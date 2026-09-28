import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/client';
import {
  Server,
  SdkError,
  SdkErrorCode,
  serializeMessage,
  type CallToolResult,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type RequestOptions,
  type Result,
  type StandardSchemaV1,
} from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import type { CallLogEntry, CallLogger } from '../observability/call-log.js';
import { resolveToolPolicy, type McprelayConfig } from '../config/config.js';
import { classifyAttempt, type AttemptOutcome, type FailurePhase } from '../pipeline/classify.js';
import { runWithRetry } from '../pipeline/retry.js';
import { createSessionContext, recordToolInventory, type SessionContext } from './session.js';
import { ClientTransport, UpstreamTransport, type ClientTransportOptions } from './transports.js';

/** Permissive result schema: relay results without imposing a shape. */
const PASSTHROUGH_SCHEMA: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'mcprelay',
    validate: (value: unknown) => ({ value }),
  },
};

export interface BridgeOptions {
  command: string;
  args: readonly string[];
  logger: CallLogger;
  stderr(chunk: string): void;
  version: string;
  config: McprelayConfig;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface Bridge {
  /** Resolves with the side that ended the session first. */
  closed: Promise<'client' | 'upstream'>;
  close(): Promise<void>;
}

type CloseSide = 'client' | 'upstream';
type ResolveClosed = (side: CloseSide) => void;

interface CloseSignal {
  closed: Promise<CloseSide>;
  resolveClosed: ResolveClosed;
}

interface PinnedServerRef {
  current: Server | undefined;
}

interface TraceFields {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
}

interface CallMetadata {
  correlationId: string;
  progressToken: unknown;
  params: Record<string, unknown>;
  trace: TraceFields;
}

interface CallLogFields {
  correlationId: string;
  trace: TraceFields;
  tool: string;
  serverName: string;
  decision: 'allowed' | 'failed' | 'cancelled';
  startedAt: number;
  requestBytes: number;
  responseBytes: number;
  attempt: number;
  error?: { message: string; code?: number };
}

type RelayRequest = (
  method: string,
  params: Record<string, unknown> | undefined,
  progressToken: unknown,
  attemptOptions?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<unknown>;

interface InterceptionDeps {
  relayRequest: RelayRequest;
  session: SessionContext;
  logger: CallLogger;
  config: McprelayConfig;
  upstreamTransport: UpstreamTransport;
}

interface PassthroughDeps {
  relayRequest: RelayRequest;
  session: SessionContext;
}

interface ServerFactoryDeps {
  session: SessionContext;
  upstream: Client;
  logger: CallLogger;
  pinned: PinnedServerRef;
  config: McprelayConfig;
  upstreamTransport: UpstreamTransport;
}

interface CloseBridgeDeps {
  upstreamTransport: UpstreamTransport;
  upstream: Client;
  handle: StdioServerHandle;
  clientTransport: ClientTransport;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

function progressTokenOf(params: unknown): unknown {
  if (params === null || typeof params !== 'object') return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== 'object') return undefined;
  return (meta as { progressToken?: unknown }).progressToken;
}

function createCloseSignal(): CloseSignal {
  let resolveClosed: ResolveClosed = () => {};
  const closed = new Promise<CloseSide>((resolve) => {
    resolveClosed = resolve;
  });
  return { closed, resolveClosed };
}

function createUpstreamTransport(options: BridgeOptions): UpstreamTransport {
  return new UpstreamTransport({
    command: options.command,
    args: options.args,
    onStderr: options.stderr,
  });
}

function createClientTransport(options: BridgeOptions): ClientTransport {
  const transportOptions: ClientTransportOptions = {};
  if (options.stdin !== undefined) transportOptions.stdin = options.stdin;
  if (options.stdout !== undefined) transportOptions.stdout = options.stdout;
  return new ClientTransport(transportOptions);
}

// Batch frames bypass the SDK protocol classes on both sides (documented
// boundary: tools/call inside a batch is not intercepted).
function relayBatchFrames(
  clientTransport: ClientTransport,
  upstreamTransport: UpstreamTransport,
): void {
  clientTransport.onBatch = (line) => {
    upstreamTransport.sendRaw(line);
  };
  upstreamTransport.onBatch = (line) => {
    clientTransport.sendRaw(line);
  };
}

function createUpstreamClient(options: BridgeOptions): Client {
  return new Client(
    { name: 'mcprelay', version: options.version },
    {
      versionNegotiation: { mode: 'auto' },
      // The middleware is the client toward upstream; it advertises the
      // server→client interactions it can relay (documented in ADR-0002).
      capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
    },
  );
}

function createPinnedServerRef(): PinnedServerRef {
  return { current: undefined };
}

// The pinned client-facing instance (created by the serveStdio factory) is the
// one whose push APIs relay server→client requests to the real client.
function registerServerToClientRequestRelays(upstream: Client, pinned: PinnedServerRef): void {
  upstream.setRequestHandler('sampling/createMessage', async (request) => {
    if (pinned.current === undefined) throw new Error('no client connection');
    return pinned.current.createMessage(request.params);
  });
  upstream.setRequestHandler('elicitation/create', async (request) => {
    if (pinned.current === undefined) throw new Error('no client connection');
    return pinned.current.elicitInput(request.params);
  });
  upstream.setRequestHandler('roots/list', async (request) => {
    if (pinned.current === undefined) throw new Error('no client connection');
    return pinned.current.listRoots(request.params);
  });
}

// Client→upstream notifications are relayed as they arrive (the SDK's protocol
// layer also consumes lifecycle ones locally).
function relayClientNotifications(
  clientTransport: ClientTransport,
  upstream: Client,
  upstreamTransport: UpstreamTransport,
  stderr: (chunk: string) => void,
): void {
  clientTransport.onNotification = (notification: JSONRPCNotification) => {
    if (!upstreamTransport.connected) return;
    void upstream
      .notification({ method: notification.method, params: notification.params })
      .catch((error: unknown) => stderr(`mcprelay: notification relay failed: ${String(error)}\n`));
  };
}

// Upstream→client notifications are relayed verbatim; progress is excluded
// because it is re-emitted with the client's original progress token by the
// request pipeline.
function relayUpstreamNotifications(
  upstreamTransport: UpstreamTransport,
  clientTransport: ClientTransport,
): void {
  upstreamTransport.onNotification = (notification: JSONRPCNotification) => {
    if (notification.method === 'notifications/progress') return;
    clientTransport.sendRaw(serializeMessage(notification));
  };
}

function wireCloseSignals(
  clientTransport: ClientTransport,
  upstreamTransport: UpstreamTransport,
  resolveClosed: ResolveClosed,
): void {
  clientTransport.onclose = () => {
    resolveClosed('client');
  };
  upstreamTransport.onclose = () => {
    resolveClosed('upstream');
  };
}

async function connectUpstream(upstream: Client, transport: UpstreamTransport): Promise<void> {
  await upstream.connect(transport);
}

function captureSessionContext(
  upstream: Client,
  fallbackServer: { name: string; version: string },
): SessionContext {
  return createSessionContext(
    upstream.getServerVersion(),
    upstream.getServerCapabilities(),
    upstream.getNegotiatedProtocolVersion(),
    upstream.getInstructions(),
    fallbackServer,
  );
}

function createRelayRequest(server: Server, upstream: Client): RelayRequest {
  return async (method, params, progressToken, attemptOptions) => {
    const requestOptions: RequestOptions = {
      ...(attemptOptions?.timeoutMs === undefined ? {} : { timeout: attemptOptions.timeoutMs }),
      ...(attemptOptions?.signal === undefined ? {} : { signal: attemptOptions.signal }),
      ...(progressToken === undefined
        ? {}
        : {
            onprogress: (progress) => {
              void server.notification({
                method: 'notifications/progress',
                params: { ...progress, progressToken },
              });
            },
          }),
    };
    return upstream.request(
      { method, params } as JSONRPCRequest,
      PASSTHROUGH_SCHEMA,
      requestOptions,
    );
  };
}

function prepareCallMetadata(requestParams: Record<string, unknown>): CallMetadata {
  const correlationId = randomUUID();
  const originalMeta = (requestParams._meta as Record<string, unknown> | undefined) ?? {};
  const trace: TraceFields = {
    ...(typeof originalMeta.traceparent === 'string'
      ? { traceparent: originalMeta.traceparent }
      : {}),
    ...(typeof originalMeta.tracestate === 'string' ? { tracestate: originalMeta.tracestate } : {}),
    ...(typeof originalMeta.baggage === 'string' ? { baggage: originalMeta.baggage } : {}),
  };
  return {
    correlationId,
    progressToken: originalMeta.progressToken,
    params: {
      ...requestParams,
      _meta: { ...originalMeta, mcprelay: { correlation_id: correlationId } },
    },
    trace,
  };
}

function buildCallLogEntry(fields: CallLogFields): CallLogEntry {
  return {
    timestamp: new Date().toISOString(),
    correlation_id: fields.correlationId,
    ...(Object.keys(fields.trace).length === 0 ? {} : { trace: fields.trace }),
    caller: { type: 'stdio', identity: 'local' },
    server: fields.serverName,
    tool: fields.tool,
    decision: fields.decision,
    latency_ms: Date.now() - fields.startedAt,
    request_bytes: fields.requestBytes,
    response_bytes: fields.responseBytes,
    attempt: fields.attempt,
    ...(fields.error === undefined ? {} : { error: fields.error }),
  };
}

function failurePhase(error: unknown, signal: AbortSignal | undefined): FailurePhase {
  if (signal?.aborted === true) return 'cancelled';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return 'timeout';
  if (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.NotConnected || error.code === SdkErrorCode.SendFailed)
  ) {
    return 'pre_send';
  }
  return 'post_send';
}

async function interceptToolCall(
  deps: InterceptionDeps,
  request: { params: { name: string } & Record<string, unknown> },
  signal: AbortSignal | undefined,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  const tool = request.params.name;
  const policy = resolveToolPolicy(deps.config, tool);
  const { correlationId, progressToken, params, trace } = prepareCallMetadata(request.params);
  const requestBytes = byteLength(params);

  const result = await runWithRetry({
    attempt: async (): Promise<AttemptOutcome> => {
      if (!deps.upstreamTransport.connected) {
        return {
          kind: 'error',
          error: new Error('upstream transport is not connected'),
          phase: 'pre_send',
        };
      }
      try {
        const value = await deps.relayRequest('tools/call', params, progressToken, {
          timeoutMs: policy.timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        });
        return { kind: 'result', result: value };
      } catch (error) {
        return { kind: 'error', error, phase: failurePhase(error, signal) };
      }
    },
    classify: (outcome) => classifyAttempt(outcome, { idempotent: policy.idempotent }),
    policy: {
      maxAttempts: policy.retry.maxAttempts,
      baseMs: policy.retry.baseMs,
      jitter: policy.retry.jitter,
    },
  });

  const logBase = {
    correlationId,
    trace,
    tool,
    serverName: deps.session.server.name,
    startedAt,
    requestBytes,
  };

  if (result.outcome.kind === 'result') {
    const value = result.outcome.result;
    const isError = result.classification.class === 'tool_error';
    deps.logger.log(
      buildCallLogEntry({
        ...logBase,
        decision: isError ? 'failed' : 'allowed',
        responseBytes: byteLength(value),
        attempt: result.attempts,
        ...(isError ? { error: { message: 'isError result' } } : {}),
      }),
    );
    return value as CallToolResult;
  }

  const error = result.outcome.error;
  if (result.classification.class === 'cancelled') {
    deps.logger.log(
      buildCallLogEntry({
        ...logBase,
        decision: 'cancelled',
        responseBytes: 0,
        attempt: result.attempts,
      }),
    );
    throw error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: number }).code;
  deps.logger.log(
    buildCallLogEntry({
      ...logBase,
      decision: 'failed',
      responseBytes: 0,
      attempt: result.attempts,
      error: code === undefined ? { message } : { message, code },
    }),
  );
  throw error;
}

async function relayPassthroughRequest(
  deps: PassthroughDeps,
  request: JSONRPCRequest,
): Promise<Result> {
  const result = await deps.relayRequest(
    request.method,
    request.params,
    progressTokenOf(request.params),
  );
  if (request.method === 'tools/list') {
    recordToolInventory(deps.session, (result as { tools?: unknown }).tools);
  }
  return result as Result;
}

// serveStdio calls the factory per opening and discards probe instances, so
// every call must return a fresh Server; the last one is the pinned instance.
function createClientServerFactory(deps: ServerFactoryDeps): () => Server {
  return () => {
    const server = new Server(deps.session.server, {
      capabilities: deps.session.capabilities,
      ...(deps.session.instructions === undefined
        ? {}
        : { instructions: deps.session.instructions }),
    });
    deps.pinned.current = server;

    const relayRequest = createRelayRequest(server, deps.upstream);

    server.setRequestHandler('tools/call', (request, ctx) =>
      interceptToolCall(
        {
          relayRequest,
          session: deps.session,
          logger: deps.logger,
          config: deps.config,
          upstreamTransport: deps.upstreamTransport,
        },
        request,
        ctx.mcpReq.signal,
      ),
    );

    server.fallbackRequestHandler = (request) =>
      relayPassthroughRequest({ relayRequest, session: deps.session }, request);

    // Client notifications are relayed by the transport hook; upstream
    // notifications by the other hook. The protocol-level fallbacks stay
    // no-op so nothing is relayed twice.
    server.fallbackNotificationHandler = async () => {};

    return server;
  };
}

// serveStdio owns the wire's onclose; chain it so the client ending the
// session (stdin EOF) still resolves the bridge.
function chainClientClose(clientTransport: ClientTransport, resolveClosed: ResolveClosed): void {
  const wireOnClose = clientTransport.onclose;
  clientTransport.onclose = () => {
    wireOnClose?.();
    resolveClosed('client');
  };
}

async function closeBridge(deps: CloseBridgeDeps): Promise<void> {
  await deps.upstreamTransport.close();
  await deps.upstream.close().catch(() => {});
  await deps.handle.close().catch(() => {});
  await deps.clientTransport.close();
}

/**
 * Wraps one upstream stdio server: connects upstream first, then serves the
 * client with the upstream's identity and capabilities. The body reads as the
 * startup sequence; each phase lives in a named helper above.
 */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const { closed, resolveClosed } = createCloseSignal();
  const upstreamTransport = createUpstreamTransport(options);
  const clientTransport = createClientTransport(options);

  relayBatchFrames(clientTransport, upstreamTransport);

  const upstream = createUpstreamClient(options);
  const pinned = createPinnedServerRef();
  registerServerToClientRequestRelays(upstream, pinned);
  relayClientNotifications(clientTransport, upstream, upstreamTransport, options.stderr);
  relayUpstreamNotifications(upstreamTransport, clientTransport);
  wireCloseSignals(clientTransport, upstreamTransport, resolveClosed);

  // Upstream first, so the client-facing server can mirror its capabilities.
  await connectUpstream(upstream, upstreamTransport);
  const session = captureSessionContext(upstream, { name: 'mcprelay', version: options.version });

  const handle = serveStdio(
    createClientServerFactory({
      session,
      upstream,
      logger: options.logger,
      pinned,
      config: options.config,
      upstreamTransport,
    }),
    {
      transport: clientTransport,
      onerror: (error: Error) => options.stderr(`mcprelay: ${error.message}\n`),
    },
  );

  chainClientClose(clientTransport, resolveClosed);

  return {
    closed,
    close: () => closeBridge({ upstreamTransport, upstream, handle, clientTransport }),
  };
}

import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/client';
import {
  Server,
  ProtocolError,
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

import {
  resolveIdentity,
  stripCredentialFields,
  type IdentityResolution,
} from '../identity/identity.js';
import type { CallLogEntry, CallLogger } from '../observability/call-log.js';
import { resolveToolPolicy, type McprelayConfig, type ToolPolicy } from '../config/config.js';
import { evaluateCall, type PolicyDecision } from '../policy/policy.js';
import { hashArguments, redactMessage, redactValue } from '../redaction/redact.js';
import {
  failureClassFromD4,
  newFailureRecordId,
  type FailureRecord,
} from '../queue/failure-record.js';
import { createPersistence, type Persistence } from '../queue/providers.js';
import { quoteCommandLine } from '../replay/command-line.js';
import { classifyAttempt, type AttemptOutcome, type FailurePhase } from '../pipeline/classify.js';
import { extractIdempotencyKey } from '../pipeline/idempotency.js';
import { runWithRetry, type RetryResult } from '../pipeline/retry.js';
import { createSessionContext, recordToolInventory, type SessionContext } from './session.js';
import {
  ClientTransport,
  createUpstreamLink,
  type ClientTransportOptions,
  type UpstreamLink,
  type UpstreamTarget,
} from './transports.js';

/** Permissive result schema: relay results without imposing a shape. */
const PASSTHROUGH_SCHEMA: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'mcprelay',
    validate: (value: unknown) => ({ value }),
  },
};

export interface BridgeOptions {
  target: UpstreamTarget;
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
  caller: CallLogEntry['caller'];
  tool: string;
  serverName: string;
  decision: 'allowed' | 'denied' | 'failed' | 'cancelled';
  startedAt: number;
  requestBytes: number;
  responseBytes: number;
  attempt: number;
  error?: { message: string; code?: number };
  enforced?: boolean;
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
  link: UpstreamLink;
  persistence: Persistence;
  serverCommand: string;
  stderr: (chunk: string) => void;
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
  link: UpstreamLink;
  persistence: Persistence;
  serverCommand: string;
  stderr: (chunk: string) => void;
}

interface CloseBridgeDeps {
  link: UpstreamLink;
  upstream: Client;
  handle: StdioServerHandle;
  clientTransport: ClientTransport;
  persistence: Persistence;
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

function createClientTransport(options: BridgeOptions): ClientTransport {
  const transportOptions: ClientTransportOptions = {};
  if (options.stdin !== undefined) transportOptions.stdin = options.stdin;
  if (options.stdout !== undefined) transportOptions.stdout = options.stdout;
  return new ClientTransport(transportOptions);
}

const BATCH_UNSUPPORTED_FRAME = JSON.stringify({
  jsonrpc: '2.0',
  id: null,
  error: {
    code: -32600,
    message: 'JSON-RPC batch frames are not supported over an HTTP upstream',
  },
});

// Batch frames bypass the SDK protocol classes on both sides (documented
// boundary: tools/call inside a batch is not intercepted). Over HTTP they are
// answered with a clear error instead of being forwarded.
function relayBatchFrames(clientTransport: ClientTransport, link: UpstreamLink): void {
  clientTransport.onBatch = (line) => {
    if (link.kind === 'stdio') link.sendBatch(line);
    else clientTransport.sendRaw(BATCH_UNSUPPORTED_FRAME);
  };
  link.setBatchRelay((line) => {
    clientTransport.sendRaw(line);
  });
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
  link: UpstreamLink,
  stderr: (chunk: string) => void,
): void {
  clientTransport.onNotification = (notification: JSONRPCNotification) => {
    if (!link.connected) return;
    void upstream
      .notification({ method: notification.method, params: notification.params })
      .catch((error: unknown) => stderr(`mcprelay: notification relay failed: ${String(error)}\n`));
  };
}

// Upstream→client notifications are relayed verbatim; progress is excluded
// because it is re-emitted with the client's original progress token by the
// request pipeline.
function relayUpstreamNotifications(link: UpstreamLink, clientTransport: ClientTransport): void {
  link.relayNotifications((notification) => {
    if (notification.method === 'notifications/progress') return;
    clientTransport.sendRaw(serializeMessage(notification));
  });
}

function wireCloseSignals(
  clientTransport: ClientTransport,
  link: UpstreamLink,
  resolveClosed: ResolveClosed,
): void {
  clientTransport.onclose = () => {
    resolveClosed('client');
  };
  link.setCloseRelay(() => {
    resolveClosed('upstream');
  });
}

async function connectUpstream(upstream: Client, link: UpstreamLink): Promise<void> {
  await link.connect(upstream);
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
      _meta: {
        ...stripCredentialFields(originalMeta),
        mcprelay: { correlation_id: correlationId },
      },
    },
    trace,
  };
}

function buildCallLogEntry(fields: CallLogFields): CallLogEntry {
  return {
    timestamp: new Date().toISOString(),
    correlation_id: fields.correlationId,
    ...(Object.keys(fields.trace).length === 0 ? {} : { trace: fields.trace }),
    caller: fields.caller,
    server: fields.serverName,
    tool: fields.tool,
    decision: fields.decision,
    latency_ms: Date.now() - fields.startedAt,
    request_bytes: fields.requestBytes,
    response_bytes: fields.responseBytes,
    attempt: fields.attempt,
    ...(fields.error === undefined ? {} : { error: fields.error }),
    ...(fields.enforced === undefined ? {} : { enforced: fields.enforced }),
  };
}

function failurePhase(
  error: unknown,
  signal: AbortSignal | undefined,
  kind: 'stdio' | 'http',
): FailurePhase {
  if (signal?.aborted === true) return 'cancelled';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) return 'timeout';
  // An HTTP fetch-level failure never reached the server: retryable pre-send.
  if (kind === 'http' && error instanceof TypeError) return 'pre_send';
  if (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.NotConnected || error.code === SdkErrorCode.SendFailed)
  ) {
    return 'pre_send';
  }
  return 'post_send';
}

interface CaptureInput {
  tool: string;
  correlationId: string;
  caller: CallLogEntry['caller'];
  rawArguments: unknown;
  failureClass: FailureRecord['failure']['class'];
  message: string;
  attempts: number;
}

/** Server-defined JSON-RPC code for an enforced policy denial (ADR-0006). */
const POLICY_DENIED_CODE = -32001;

/** Server-defined JSON-RPC code for a rejected caller credential (ADR-0010; -32002 is SDK-reserved). */
const AUTH_DENIED_CODE = -32003;

const UNAUTHENTICATED: CallLogEntry['caller'] = {
  type: 'stdio',
  identity: 'unauthenticated',
};

interface AuthDenialInput {
  tool: string;
  correlationId: string;
  reason: string;
}

/** Audit entry for an auth rejection; a store failure never blocks the denial. */
async function recordAuthDenial(deps: InterceptionDeps, input: AuthDenialInput): Promise<void> {
  try {
    await deps.persistence.getStore().audit({
      kind: 'denied',
      correlationId: input.correlationId,
      toolName: input.tool,
      detail: { action: 'auth', reason: input.reason },
    });
  } catch (error) {
    deps.stderr(
      `mcprelay: auth denial audit failed: ${error instanceof Error ? error.message : String(error)}
`,
    );
  }
}

/** Durable, redacted capture; never blocks the client if persistence fails. */
async function captureFailure(deps: InterceptionDeps, input: CaptureInput): Promise<void> {
  const patterns = deps.config.redaction.patterns;
  const record: FailureRecord = {
    id: newFailureRecordId(),
    correlation_id: input.correlationId,
    captured_at: new Date().toISOString(),
    caller: input.caller,
    server: {
      name: deps.session.server.name,
      command: deps.serverCommand,
      transport: deps.link.kind,
    },
    tool: {
      name: input.tool,
      arguments_hash: hashArguments(input.rawArguments),
      arguments: redactValue(input.rawArguments, patterns),
    },
    failure: {
      class: input.failureClass,
      message: redactMessage(input.message, patterns),
      attempts: input.attempts,
    },
    replay: { status: 'pending', attempts: [], last_outcome: null },
  };

  try {
    await deps.persistence.getQueue().enqueue(record);
    await deps.persistence.getStore().audit({
      kind: 'captured',
      correlationId: input.correlationId,
      failureId: record.id,
      toolName: input.tool,
    });
  } catch (error) {
    deps.stderr(
      `mcprelay: capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

interface DenialInput {
  tool: string;
  correlationId: string;
  decision: PolicyDecision;
}

/** Audit entry for an enforced denial; a store failure never blocks the denial. */
async function recordDenial(deps: InterceptionDeps, input: DenialInput): Promise<void> {
  try {
    await deps.persistence.getStore().audit({
      kind: 'denied',
      correlationId: input.correlationId,
      toolName: input.tool,
      detail: { action: 'deny', rule: input.decision.rule, reason: input.decision.reason },
    });
  } catch (error) {
    deps.stderr(
      `mcprelay: denial audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** Emits the log line and persists the matching call event (log/metrics parity, M8). */
async function logCall(deps: InterceptionDeps, entry: CallLogEntry): Promise<void> {
  deps.logger.log(entry);
  if (entry.enforced === false) return;
  try {
    await deps.persistence.getStore().recordCall({
      correlation_id: entry.correlation_id,
      timestamp: entry.timestamp,
      caller: entry.caller,
      tool: entry.tool,
      decision: entry.decision,
      latency_ms: entry.latency_ms,
      request_bytes: entry.request_bytes,
      response_bytes: entry.response_bytes,
      attempt: entry.attempt,
    });
  } catch (error) {
    deps.stderr(
      `mcprelay: metrics write failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

type LogBase = Omit<CallLogFields, 'decision' | 'responseBytes' | 'attempt' | 'error' | 'enforced'>;

/** Per-call facts resolved once; the handler owns the control flow over them. */
interface CallContext {
  tool: string;
  rawArguments: unknown;
  idempotencyKey: string | undefined;
  policy: ToolPolicy;
  metadata: CallMetadata;
  requestBytes: number;
  startedAt: number;
  caller: CallLogEntry['caller'];
}

/** Resolves the per-call context (identity included); the gates stay in the handler. */
function prepareCallContext(
  deps: InterceptionDeps,
  request: { params: { name: string } & Record<string, unknown> },
): { context: CallContext; resolution: IdentityResolution } {
  const startedAt = Date.now();
  const tool = request.params.name;
  const rawArguments = request.params.arguments;
  const metadata = prepareCallMetadata(request.params);
  const resolution = resolveIdentity(deps.config.identity, request.params._meta);
  const context: CallContext = {
    tool,
    rawArguments,
    idempotencyKey: extractIdempotencyKey({ _meta: request.params._meta, arguments: rawArguments }),
    policy: resolveToolPolicy(deps.config, tool),
    metadata,
    requestBytes: byteLength(metadata.params),
    startedAt,
    caller: resolution.ok ? { type: 'stdio', identity: resolution.identity } : UNAUTHENTICATED,
  };
  return { context, resolution };
}

/** Derives the shared log-entry fields from the context once per call. */
function logFields(deps: InterceptionDeps, context: CallContext): LogBase {
  return {
    correlationId: context.metadata.correlationId,
    trace: context.metadata.trace,
    caller: context.caller,
    tool: context.tool,
    serverName: deps.session.server.name,
    startedAt: context.startedAt,
    requestBytes: context.requestBytes,
  };
}

/** The credential-rejection message; one template for the log entry and the throw. */
function authFailureMessage(reason: string): string {
  return `authentication failed: ${reason}`;
}

/** Logs + audits the credential rejection; the handler throws right after. */
async function denyCredential(
  deps: InterceptionDeps,
  context: CallContext,
  reason: string,
): Promise<void> {
  await logCall(
    deps,
    buildCallLogEntry({
      ...logFields(deps, context),
      decision: 'denied',
      responseBytes: 0,
      attempt: 0,
      error: { message: authFailureMessage(reason) },
    }),
  );
  await recordAuthDenial(deps, {
    tool: context.tool,
    correlationId: context.metadata.correlationId,
    reason,
  });
}

/** The enforced-deny message; one template for the log entries, audit, and the throw. */
function policyDeniedMessage(tool: string, reason: string): string {
  return `policy denied tool '${tool}': ${reason}`;
}

/** Dry-run denial: records the decision without enforcing; the call proceeds. */
async function logPolicyWouldDeny(
  deps: InterceptionDeps,
  base: LogBase,
  decision: PolicyDecision,
): Promise<void> {
  deps.stderr(`mcprelay: policy dry-run: would deny tool '${base.tool}' (${decision.reason})\n`);
  await logCall(
    deps,
    buildCallLogEntry({
      ...base,
      decision: 'denied',
      responseBytes: 0,
      attempt: 0,
      error: { message: policyDeniedMessage(base.tool, decision.reason) },
      enforced: false,
    }),
  );
}

/** Enforced-denial persistence: log + audit; the handler throws right after. */
async function denyByPolicy(
  deps: InterceptionDeps,
  base: LogBase,
  decision: PolicyDecision,
): Promise<void> {
  await logCall(
    deps,
    buildCallLogEntry({
      ...base,
      decision: 'denied',
      responseBytes: 0,
      attempt: 0,
      error: { message: policyDeniedMessage(base.tool, decision.reason) },
    }),
  );
  await recordDenial(deps, { tool: base.tool, correlationId: base.correlationId, decision });
}

/** One upstream attempt: the connected guard, then the relay with phase classification. */
async function attemptToolCall(
  deps: InterceptionDeps,
  context: CallContext,
  signal: AbortSignal | undefined,
): Promise<AttemptOutcome> {
  if (!deps.link.connected) {
    return {
      kind: 'error',
      error: new Error('upstream transport is not connected'),
      phase: 'pre_send',
    };
  }
  return relayToolCall(deps, context, signal);
}

/** The relay itself; how it failed decides the retry phase (D4, FR-R2). */
async function relayToolCall(
  deps: InterceptionDeps,
  context: CallContext,
  signal: AbortSignal | undefined,
): Promise<AttemptOutcome> {
  try {
    const value = await deps.relayRequest(
      'tools/call',
      context.metadata.params,
      context.metadata.progressToken,
      {
        timeoutMs: context.policy.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return { kind: 'result', result: value };
  } catch (error) {
    return { kind: 'error', error, phase: failurePhase(error, signal, deps.link.kind) };
  }
}

/** Records the idempotent execution; an index failure never breaks the call. */
async function recordIdempotentExecution(
  deps: InterceptionDeps,
  context: CallContext,
  key: string,
): Promise<void> {
  try {
    await deps.persistence.getQueue().recordExecution({
      key,
      toolName: context.tool,
      argumentsHash: hashArguments(context.rawArguments),
      executedAt: new Date().toISOString(),
      source: 'live',
    });
  } catch (error) {
    deps.stderr(
      `mcprelay: idempotency index write failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** Result path: capture on configured tool errors, idempotency record, final log. */
async function finalizeSuccessfulCall(
  deps: InterceptionDeps,
  context: CallContext,
  result: RetryResult,
): Promise<CallToolResult> {
  const outcome = result.outcome as { kind: 'result'; result: unknown };
  const value = outcome.result;
  const isError = result.classification.class === 'tool_error';
  if (isError) {
    if (context.policy.captureToolErrors) {
      await captureFailure(deps, {
        tool: context.tool,
        correlationId: context.metadata.correlationId,
        caller: context.caller,
        rawArguments: context.rawArguments,
        failureClass: 'tool_error',
        message: 'isError result',
        attempts: result.attempts,
      });
    }
  } else if (context.idempotencyKey !== undefined) {
    await recordIdempotentExecution(deps, context, context.idempotencyKey);
  }
  await logCall(
    deps,
    buildCallLogEntry({
      ...logFields(deps, context),
      decision: isError ? 'failed' : 'allowed',
      responseBytes: byteLength(value),
      attempt: result.attempts,
      ...(isError ? { error: { message: 'isError result' } } : {}),
    }),
  );
  return value as CallToolResult;
}

/**
 * Error path and terminal step: cancelled logs and rethrows; recordable
 * failures are captured, then logged and rethrown. Always throws.
 */
async function failToolCall(
  deps: InterceptionDeps,
  context: CallContext,
  result: RetryResult,
): Promise<never> {
  const outcome = result.outcome as { kind: 'error'; error: unknown; phase: string };
  const error = outcome.error;
  const message = error instanceof Error ? error.message : String(error);
  if (result.classification.class === 'cancelled') {
    await logCall(
      deps,
      buildCallLogEntry({
        ...logFields(deps, context),
        decision: 'cancelled',
        responseBytes: 0,
        attempt: result.attempts,
      }),
    );
    throw error;
  }
  const recordClass = failureClassFromD4(result.classification.class);
  if (recordClass !== undefined) {
    await captureFailure(deps, {
      tool: context.tool,
      correlationId: context.metadata.correlationId,
      caller: context.caller,
      rawArguments: context.rawArguments,
      failureClass: recordClass,
      message,
      attempts: result.attempts,
    });
  }
  const code = (error as { code?: number }).code;
  await logCall(
    deps,
    buildCallLogEntry({
      ...logFields(deps, context),
      decision: 'failed',
      responseBytes: 0,
      attempt: result.attempts,
      error: code === undefined ? { message } : { message, code },
    }),
  );
  throw error;
}

async function interceptToolCall(
  deps: InterceptionDeps,
  request: { params: { name: string } & Record<string, unknown> },
  signal: AbortSignal | undefined,
): Promise<CallToolResult> {
  // Identity resolves before policy: a rejected credential never reaches the
  // retry pipeline, the upstream, or the DLQ (FR-A1/FR-A3, ADR-0010).
  const { context, resolution } = prepareCallContext(deps, request);
  if (!resolution.ok) {
    await denyCredential(deps, context, resolution.reason);
    throw new ProtocolError(AUTH_DENIED_CODE, authFailureMessage(resolution.reason));
  }

  const logBase = logFields(deps, context);

  // Policy runs before the retry pipeline: a denial consumes no retries,
  // claims no DLQ record, and never reaches the upstream (FR-Y4).
  const decision = evaluateCall(deps.config.policy, {
    tool: context.tool,
    arguments: context.rawArguments,
    caller: resolution.identity,
  });
  if (decision.action === 'deny') {
    if (deps.config.policyDryRun) {
      await logPolicyWouldDeny(deps, logBase, decision);
    } else {
      await denyByPolicy(deps, logBase, decision);
      throw new ProtocolError(
        POLICY_DENIED_CODE,
        policyDeniedMessage(context.tool, decision.reason),
      );
    }
  }

  const result = await runWithRetry({
    attempt: () => attemptToolCall(deps, context, signal),
    classify: (outcome) => classifyAttempt(outcome, { idempotent: context.policy.idempotent }),
    policy: {
      maxAttempts: context.policy.retry.maxAttempts,
      baseMs: context.policy.retry.baseMs,
      jitter: context.policy.retry.jitter,
    },
  });

  if (result.outcome.kind === 'result') {
    return finalizeSuccessfulCall(deps, context, result);
  }
  return failToolCall(deps, context, result);
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
          link: deps.link,
          persistence: deps.persistence,
          serverCommand: deps.serverCommand,
          stderr: deps.stderr,
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
  await deps.link.close();
  await deps.upstream.close().catch(() => {});
  await deps.handle.close().catch(() => {});
  await deps.clientTransport.close();
  await deps.persistence.close();
}

/**
 * Wraps one upstream server (stdio process or remote HTTP): connects upstream
 * first, then serves the client with the upstream's identity and capabilities.
 * The body reads as the startup sequence; each phase lives in a named helper.
 */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const { closed, resolveClosed } = createCloseSignal();
  const link = createUpstreamLink(options.target, options.stderr);
  const clientTransport = createClientTransport(options);

  relayBatchFrames(clientTransport, link);

  const upstream = createUpstreamClient(options);
  const pinned = createPinnedServerRef();
  registerServerToClientRequestRelays(upstream, pinned);
  relayClientNotifications(clientTransport, upstream, link, options.stderr);
  relayUpstreamNotifications(link, clientTransport);
  wireCloseSignals(clientTransport, link, resolveClosed);

  // Upstream first, so the client-facing server can mirror its capabilities.
  await connectUpstream(upstream, link);
  const session = captureSessionContext(upstream, { name: 'mcprelay', version: options.version });

  const persistence = createPersistence(options.config);

  const handle = serveStdio(
    createClientServerFactory({
      session,
      upstream,
      logger: options.logger,
      pinned,
      config: options.config,
      link,
      persistence,
      serverCommand: serverCommandOf(options.target),
      stderr: options.stderr,
    }),
    {
      transport: clientTransport,
      onerror: (error: Error) => options.stderr(`mcprelay: ${error.message}\n`),
    },
  );

  chainClientClose(clientTransport, resolveClosed);

  return {
    closed,
    close: () => closeBridge({ link, upstream, handle, clientTransport, persistence }),
  };
}

/** The record-facing target: the quoted stdio command, or the HTTP endpoint URL. */
function serverCommandOf(target: UpstreamTarget): string {
  return target.kind === 'stdio' ? quoteCommandLine(target.command, target.args) : target.url;
}

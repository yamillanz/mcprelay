import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/client';
import {
  Server,
  serializeMessage,
  type CallToolResult,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type RequestOptions,
  type Result,
  type StandardSchemaV1,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import type { CallLogger } from '../observability/call-log.js';
import { createSessionContext, recordToolInventory } from './session.js';
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
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface Bridge {
  /** Resolves with the side that ended the session first. */
  closed: Promise<'client' | 'upstream'>;
  close(): Promise<void>;
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

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const fallbackServer = { name: 'mcprelay', version: options.version };
  const logger = options.logger;
  let resolveClosed: (side: 'client' | 'upstream') => void = () => {};
  const closed = new Promise<'client' | 'upstream'>((resolve) => {
    resolveClosed = resolve;
  });

  const upstreamTransport = new UpstreamTransport({
    command: options.command,
    args: options.args,
    onStderr: options.stderr,
  });
  const clientTransportOptions: ClientTransportOptions = {};
  if (options.stdin !== undefined) clientTransportOptions.stdin = options.stdin;
  if (options.stdout !== undefined) clientTransportOptions.stdout = options.stdout;
  const clientTransport = new ClientTransport(clientTransportOptions);

  // Batch frames bypass the SDK protocol classes on both sides (documented
  // boundary: tools/call inside a batch is not intercepted).
  clientTransport.onBatch = (line) => {
    upstreamTransport.sendRaw(line);
  };
  upstreamTransport.onBatch = (line) => {
    clientTransport.sendRaw(line);
  };

  const upstream = new Client(
    { name: 'mcprelay', version: options.version },
    {
      versionNegotiation: { mode: 'auto' },
      // The middleware is the client toward upstream; it advertises the
      // server→client interactions it can relay (documented in ADR-0002).
      capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
    },
  );

  // The pinned client-facing instance (created by the serveStdio factory) is
  // the one whose push APIs relay server→client requests to the real client.
  let pinnedServer: Server | undefined;

  upstream.setRequestHandler('sampling/createMessage', async (request) => {
    if (pinnedServer === undefined) throw new Error('no client connection');
    return pinnedServer.createMessage(request.params);
  });
  upstream.setRequestHandler('elicitation/create', async (request) => {
    if (pinnedServer === undefined) throw new Error('no client connection');
    return pinnedServer.elicitInput(request.params);
  });
  upstream.setRequestHandler('roots/list', async (request) => {
    if (pinnedServer === undefined) throw new Error('no client connection');
    return pinnedServer.listRoots(request.params);
  });

  // Client→upstream notifications are relayed as they arrive (the SDK's
  // protocol layer also consumes lifecycle ones locally).
  clientTransport.onNotification = (notification: JSONRPCNotification) => {
    if (!upstreamTransport.connected) return;
    void upstream
      .notification({ method: notification.method, params: notification.params })
      .catch((error: unknown) =>
        options.stderr(`mcprelay: notification relay failed: ${String(error)}\n`),
      );
  };

  // Upstream→client notifications are relayed verbatim; progress is excluded
  // because it is re-emitted with the client's original progress token by the
  // request pipeline below.
  upstreamTransport.onNotification = (notification: JSONRPCNotification) => {
    if (notification.method === 'notifications/progress') return;
    clientTransport.sendRaw(serializeMessage(notification));
  };

  clientTransport.onclose = () => {
    resolveClosed('client');
  };
  upstreamTransport.onclose = () => {
    resolveClosed('upstream');
  };

  await upstream.connect(upstreamTransport);

  const session = createSessionContext(
    upstream.getServerVersion(),
    upstream.getServerCapabilities(),
    upstream.getNegotiatedProtocolVersion(),
    upstream.getInstructions(),
    fallbackServer,
  );

  // serveStdio calls the factory per opening and discards probe instances, so
  // every call must return a fresh Server; the last one is the pinned instance.
  const createServer = (): Server => {
    const server = new Server(session.server, {
      capabilities: session.capabilities,
      ...(session.instructions === undefined ? {} : { instructions: session.instructions }),
    });
    pinnedServer = server;

    const relayRequest = async (
      method: string,
      params: Record<string, unknown> | undefined,
      progressToken: unknown,
    ): Promise<unknown> => {
      const requestOptions: RequestOptions | undefined =
        progressToken === undefined
          ? undefined
          : {
              onprogress: (progress) => {
                void server.notification({
                  method: 'notifications/progress',
                  params: { ...progress, progressToken },
                });
              },
            };
      return upstream.request(
        { method, params } as JSONRPCRequest,
        PASSTHROUGH_SCHEMA,
        requestOptions,
      );
    };

    server.setRequestHandler('tools/call', async (request) => {
      const correlationId = randomUUID();
      const startedAt = Date.now();
      const tool = request.params.name;
      const originalMeta = (request.params as { _meta?: Record<string, unknown> })._meta ?? {};
      const progressToken = originalMeta.progressToken;
      const params = {
        ...request.params,
        _meta: { ...originalMeta, mcprelay: { correlation_id: correlationId } },
      };
      const requestBytes = byteLength(params);

      const trace = {
        ...(typeof originalMeta.traceparent === 'string'
          ? { traceparent: originalMeta.traceparent }
          : {}),
        ...(typeof originalMeta.tracestate === 'string'
          ? { tracestate: originalMeta.tracestate }
          : {}),
        ...(typeof originalMeta.baggage === 'string' ? { baggage: originalMeta.baggage } : {}),
      };

      try {
        const result = await relayRequest('tools/call', params, progressToken);
        const isError = (result as { isError?: boolean }).isError === true;
        logger.log({
          timestamp: new Date().toISOString(),
          correlation_id: correlationId,
          ...(Object.keys(trace).length === 0 ? {} : { trace }),
          caller: { type: 'stdio', identity: 'local' },
          server: session.server.name,
          tool,
          decision: isError ? 'failed' : 'allowed',
          latency_ms: Date.now() - startedAt,
          request_bytes: requestBytes,
          response_bytes: byteLength(result),
          attempt: 1,
          ...(isError ? { error: { message: 'isError result' } } : {}),
        });
        return result as CallToolResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: number }).code;
        logger.log({
          timestamp: new Date().toISOString(),
          correlation_id: correlationId,
          ...(Object.keys(trace).length === 0 ? {} : { trace }),
          caller: { type: 'stdio', identity: 'local' },
          server: session.server.name,
          tool,
          decision: 'failed',
          latency_ms: Date.now() - startedAt,
          request_bytes: requestBytes,
          response_bytes: 0,
          attempt: 1,
          error: code === undefined ? { message } : { message, code },
        });
        throw error;
      }
    });

    server.fallbackRequestHandler = async (request: JSONRPCRequest): Promise<Result> => {
      const result = await relayRequest(
        request.method,
        request.params,
        progressTokenOf(request.params),
      );
      if (request.method === 'tools/list') {
        recordToolInventory(session, (result as { tools?: unknown }).tools);
      }
      return result as Result;
    };

    // Client notifications are relayed by the transport hook above; upstream
    // notifications by the other hook. The protocol-level fallbacks stay
    // no-op so nothing is relayed twice.
    server.fallbackNotificationHandler = async () => {};

    return server;
  };

  upstream.fallbackNotificationHandler = async () => {};

  const handle = serveStdio(createServer, {
    transport: clientTransport,
    onerror: (error: Error) => options.stderr(`mcprelay: ${error.message}\n`),
  });

  // serveStdio owns the wire's onclose; chain it so the client ending the
  // session (stdin EOF) still resolves the bridge.
  const wireOnClose = clientTransport.onclose;
  clientTransport.onclose = () => {
    wireOnClose?.();
    resolveClosed('client');
  };

  return {
    closed,
    async close(): Promise<void> {
      await upstreamTransport.close();
      await upstream.close().catch(() => {});
      await handle.close().catch(() => {});
      await clientTransport.close();
    },
  };
}

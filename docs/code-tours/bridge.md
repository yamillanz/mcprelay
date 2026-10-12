# Guía de estudio — `src/proxy/bridge.ts`

> **Qué es este archivo:** una copia comentada del código real, bloque por bloque. Arriba el código (idéntico al fuente, salvo que aquí no hay números de línea), debajo la explicación en español: **qué hace**, **por qué existe** y **qué pasaría si no estuviera**.
>
> El código y los identificadores se mantienen en inglés (convención del repo); la explicación va en español.
>
> **Fuente:** [`src/proxy/bridge.ts`](../../src/proxy/bridge.ts) — **espejo de** `cefe854`. Si el código cambia, esta guía debe actualizarse en el mismo change (convención de `AGENTS.md`; es un espejo, no la fuente de verdad).
>
> **Contexto:** el bridge es la espina del proxy. Su trabajo es ponerse en medio de un cliente MCP y un servidor MCP (stdio local o HTTP remoto), dejar pasar todo igual **excepto `tools/call`**, y alrededor de esa llamada tejer las capas de todos los milestones: **identidad** (M9), **policy** (M5), **retry con taxonomía D4** (M2), **DLQ con captura redactada** (M3/M7), **idempotencia** (M4), **métricas/log** (M8) y el **cierre limpio** (M1). Decisiones y límites en [`docs/adr/0002-stdio-proxy-termination.md`](../adr/0002-stdio-proxy-termination.md) y `ADR-0006/0008/0010`.
>
> **Desde `refactor-intercept-call`:** `interceptToolCall` se lee como una secuencia de gates con nombre — preparar contexto → gate de credencial → gate de policy → ejecución con retry → outcome — con los efectos (log, audit, captura) en helpers del mismo archivo y el flujo de control (los `throw`, el dry-run) visible en el handler.

---

## Bloque A — Imports, schema permisivo y contratos públicos

```ts
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
```

**Qué hace:** trae las piezas de fuera (SDK, identity, policy, redaction, queue, pipeline, replay, transports), define el schema que acepta cualquier resultado sin validarlo (`PASSTHROUGH_SCHEMA`) y los dos contratos públicos: `BridgeOptions` y `Bridge`.

**Por qué:** esta lista de imports es el mapa de las capas que el bridge teje: `resolveIdentity`/`stripCredentialFields` (gate de credencial), `evaluateCall` (policy), `runWithRetry`/`classifyAttempt` (retry D4), `captureFailure`-helpers del DLQ (`newFailureRecordId`, `redactValue`…), `createPersistence` (SQLite o RabbitMQ), `extractIdempotencyKey` y `quoteCommandLine` (el comando del servidor que se guarda en el registro para que replay pueda re-ejecutarlo). `BridgeOptions.target` es ahora un `UpstreamTarget` (stdio o HTTP), no un comando suelto: M6 generalizó el bridge sin duplicarlo.

**Si no estuviera:** `run.ts` tendría que conocer los detalles internos, y el SDK rechazaría cada respuesta por falta de schema. Sin `target`, el bridge solo sabría envolver procesos locales.

---

## Bloque B — Tipos internos (el "vocabulario" del archivo)

```ts
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
```

**Qué hace:** nombra las formas de datos que viajan entre helpers: señal de cierre, holder `pinned`, campos de traza OTel, metadatos preparados, campos del log (ahora con `denied`/`cancelled`, `attempt` y `enforced`), la firma del reenviador (`RelayRequest`, ahora con `attemptOptions`: timeout y signal), y los paquetes de dependencias de cada grupo de helpers.

**Por qué:** cada `…Deps` hace explícito qué necesita cada fase y evita listas largas de parámetros. `InterceptionDeps` concentra lo que la intercepción necesita de verdad (relay, sesión, logger, config, link — para saber si está conectado y su `kind` —, persistencia — para audit/captura/métricas —, el comando del servidor y stderr para avisos). `CallLogFields.attempt` ya no es un `1` fijo: el retry real lo alimenta.

**Si no estuviera:** cada helper tendría firmas largas y duplicadas, y el estado compartido viajaría sin tipo.

---

## Bloque C — Helpers de datos y señal de cierre

```ts
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
```

**Qué hace:** `byteLength` calcula el tamaño real en bytes de un mensaje (para el log). `progressTokenOf` saca, con cuidado de tipos, el token de progreso de `params._meta`. `createCloseSignal` crea la promesa `closed` que se resuelve una sola vez.

**Por qué:** operaciones pequeñas pero frágiles (JSON puede ser cualquier cosa) y repetidas; aislarlas evita errores y hace el resto más legible.

**Si no estuvieran:** un `params` inesperado rompería el bridge, y cada uso repetiría los chequeos.

---

## Bloque D — Cables, batches y el límite HTTP

```ts
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
```

**Qué hace:** crea el cable del cliente (con streams inyectables para tests) y cruza los batches: un frame batch llega de un lado y sale **tal cual** por el otro — si el upstream es **stdio**. Si es **HTTP**, el protocolo 2026-07-28 eliminó batching: se responde con un frame de error claro en vez de reenviarlo.

**Por qué:** el SDK modela *un mensaje* por vez; los arrays no caben. Los batches saltan el SDK (límite documentado: un `tools/call` dentro de un batch no se intercepta) y sobre HTTP se contesta explícitamente — un límite honesto en vez de un silencio roto (M6).

**Si no estuviera:** el middleware se rompería al recibir un batch, o lo dejaría morir contra un upstream HTTP sin explicación.

---

## Bloque E — Lado upstream y los relés servidor→cliente

```ts
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
```

**Qué hace:** crea el rol **cliente MCP** frente al servidor real (`versionNegotiation: 'auto'`; capacidades `sampling`/`elicitation`/`roots` para poder retransmitir peticiones servidor→cliente). El holder `pinned` guarda la instancia real del `Server`; los tres handlers reenvían las peticiones del servidor al cliente real. Los dos relés conectan las notificaciones en ambos sentidos — el progreso se excluye aquí porque se reemite con el token original (Bloque F).

**Por qué:** sin las capacidades, el SDK no deja registrar los handlers. El `link` abstracto (en vez del transport concreto) es lo que hace que stdio y HTTP compartan este cableado; `link.connected` evita reenviar a un upstream muerto, y `link.relayNotifications` es el punto común para notificaciones de cualquier transporte.

**Si no estuviera:** no habría conexión con el servidor real, ni peticiones servidor→cliente, ni notificaciones.

---

## Bloque F — Conexión, contexto de sesión y `createRelayRequest`

```ts
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
```

**Qué hace:** conecta las señales de cierre a ambos lados (cliente y upstream, vía el `link`); `connectUpstream` arranca la conexión real (spawn del proceso o conexión HTTP) y negocia protocolo; `captureSessionContext` guarda lo aprendido del servidor; `createRelayRequest` devuelve la función que envía una petición **con timeout y signal opcionales** (los que el retry le pasa) y reemite el progreso con el token original del cliente.

**Por qué:** el orden importa: **primero** el servidor, para que el `Server` del cliente pueda espejar sus capacidades. `attemptOptions` es lo que permite que el timeout viva en el attempt (M2) sin que el reenviador sepa de retries. Se crea **una vez por instancia de `Server`** (no por llamada), para no añadir closures en el hot path.

**Si no estuviera:** el cliente hablaría con un servidor que aún no existe; no habría timeout por intento ni traducción de tokens de progreso.

---

## Bloque G — Metadatos, línea de log y fase de fallo

```ts
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
```

**Qué hace:** `prepareCallMetadata` genera el `correlation_id`, copia `_meta`, separa las claves OTel para el log y construye el `_meta` que irá **upstream con las credenciales eliminadas** (`stripCredentialFields` — FR-A3, ADR-0010) más `mcprelay.correlation_id`. `buildCallLogEntry` construye la línea JSON (una sola forma para todos los outcomes; `enforced` solo aparece en dry-run). `failurePhase` traduce un error a la fase D4: `cancelled`, `timeout`, `pre_send` (nunca llegó al servidor) o `post_send`.

**Por qué:** la credencial del cliente se valida en el edge pero **jamás** viaja al upstream: el strip ocurre aquí, en el único punto por donde pasan los params reenviados. `failurePhase` es la pieza que hace honesto el retry: solo `pre_send` (y timeout con `idempotent`) son reintentables — el resto de la decisión vive en `classifyAttempt`.

**Si no estuviera:** la credencial del cliente se filtraría upstream (violación de FR-A3) y el retry tendría que adivinar si el fallo ocurrió antes o después de ejecutar.

---

## Bloque H — Persistencia: códigos, denegaciones, captura y el log con métricas

```ts
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
```

**Qué hace:** define los dos códigos de error del producto (`-32001` policy, `-32003` credencial — `-32002` está reservado por el SDK), el caller reservado `unauthenticated`, y los cuatro helpers de persistencia: audit de rechazo de credencial, **captura durable y redactada** en el DLQ (+ audit `captured`), audit de denegación de policy, y `logCall`, que emite la línea JSON y además persiste el **call event** para `report` (paridad log/métricas, M8).

**Por qué:** la captura construye el `FailureRecord` completo — argumentos **redactados** pero con `arguments_hash` calculado sobre los **crudos** (NFR-4), el comando del servidor para que replay pueda re-ejecutarlo, y el transporte. Todos los helpers envuelven su escritura en try/catch: **una persistencia caída nunca bloquea al cliente** (un fallo de store es un aviso en stderr, no un error de la llamada). En `logCall`, un dry-run (`enforced: false`) se loguea pero **no** se persiste como evento.

**Si no estuviera:** no habría DLQ ni audit ni métricas; y un SQLite caído rompería las llamadas en vez de degradarlas con aviso.

---

## Bloque I — El contexto de llamada y los gates con nombre

```ts
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
```

**Qué hace:** resuelve **una vez por llamada** todo lo que la intercepción necesita (`prepareCallContext`): tool, argumentos crudos, clave de idempotencia, política resuelta, metadatos (correlación/traza), tamaño de request, timestamp y **caller** (perfil o clave mapeada; `unauthenticated` si la credencial fue rechazada). Deriva los campos base del log (`logFields`) y contiene los **gates del lado de la persistencia**: el rechazo de credencial (log + audit `action: auth`) y las dos caras de policy — dry-run (aviso + log `enforced:false`, la llamada sigue) y denegación efectiva (log + audit `action: deny`). El template del mensaje vive en un solo sitio (`authFailureMessage` / `policyDeniedMessage`).

**Por qué:** el handler queda como orquestador y los helpers solo hacen efectos; los `throw` viven en el handler junto a su condición (visibilidad del flujo de control — el patrón que fijó `refactor-intercept-call`). `context.caller` se setea antes de los gates para que incluso un rechazo quede atribuido en el log.

**Si no estuviera:** cada gate repetiría la construcción del log y del audit, y el handler volvería a crecer a 180 líneas.

---

## Bloque J — Ejecución y outcome

```ts
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
```

**Qué hace:** `attemptToolCall` es **un intento**: guard de conexión (si el link no está conectado, error `pre_send` — nunca tocó la red) y luego el relay. `relayToolCall` manda el `tools/call` con el timeout de la política del tool y clasifica la fase del fallo. `recordIdempotentExecution` indexa la ejecución exitosa (solo si hay clave). `finalizeSuccessfulCall` es la cola del resultado: captura el `isError` **si el tool lo pidió** (`capture_tool_errors`), registra la ejecución idempotente, y loguea `allowed`/`failed`. `failToolCall` es la cola terminal: cancelación (log + rethrow del error original), captura D4 si la clase es registrable, log `failed` con código, rethrow — **siempre lanza** (`Promise<never>`).

**Por qué:** esta separación es la que permite que `runWithRetry` gobierne los reintentos sin conocer nada del bridge: el bridge solo aporta "un intento" y deja que el clasificador decida. La equivalencia de combinaciones (`isError` + `capture`, éxito + clave) está cubierta al detalle por los tests de sesión, porque aquí es donde viven los efectos de la demo §1.

**Si no estuviera:** el resultado de una llamada no dejaría rastro (ni DLQ para `isError` opt-in, ni índice de idempotencia, ni log por outcome).

---

## Bloque K — El orquestador: `interceptToolCall`

```ts
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
```

**Qué hace:** el único método interceptado, como secuencia de cinco pasos: **preparar** el contexto → **gate de credencial** (rechazo → log + audit + `-32003`) → **gate de policy** (dry-run reporta y sigue; enforce → log + audit + `-32001`) → **ejecutar** con `runWithRetry` (clasificación D4, intento nombrado) → **outcome** (finalize o fail).

**Por qué:** el orden de los gates es una decisión de producto: identidad **antes** que policy (una credencial rechazada nunca llega a la evaluación ni al upstream, FR-A1/A3), y policy **antes** que el retry (una denegación no consume reintentos ni entra al DLQ, FR-Y4). El handler mantiene solo el flujo de control; los efectos están en los helpers — la forma que fijó el refactor de M9 y que el reviewer verificó línea a línea.

**Si no estuviera:** `tools/call` pasaría sin más: ni identidad, ni policy, ni retry, ni DLQ, ni métricas — no habría producto.

---

## Bloque L — Passthrough y la fábrica de servidores

```ts
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
```

**Qué hace:** todo método sin handler propio se reenvía tal cual (y `tools/list` además guarda el inventario en el contexto de sesión). La fábrica crea el `Server` que atiende al cliente: instancia **nueva** por llamada (con la identidad/capacidades del servidor real), la marca como `pinned`, le cuelga el handler de `tools/call` (con el `signal` de cancelación que el SDK expone en `ctx.mcpReq.signal`), el fallback de passthrough y un fallback de notificaciones no-op.

**Por qué:** `serveStdio` crea instancias "sonda" y las descarta; devolver siempre la misma rompería la sesión real (bug real de M1). El `fallbackNotificationHandler` no-op evita que el SDK duplique notificaciones que ya retransportamos en el cable. El `signal` del SDK es lo que permite abortar un attempt en vuelo cuando el cliente cancela (FR-R2).

**Si no estuviera:** el cliente recibiría "método no encontrado" para todo lo que no fuera `tools/call`, la sesión se cerraría sola tras el `initialize`, o cada notificación llegaría dos veces.

---

## Bloque M — Cierre y `startBridge`

```ts
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
```

**Qué hace:** encadena el `onclose` del wire (para no perder el cierre por stdin EOF), apaga todo en orden — link upstream → cliente SDK → servidor del cliente → transport del cliente → **persistencia** — y `startBridge` es el algoritmo de arranque en pasos: señal de cierre → link (`createUpstreamLink` decide stdio/HTTP) → batches → cliente upstream + relés + cierre → conectar upstream → capturar contexto → crear persistencia (SQLite/RabbitMQ según config) → `serveStdio` con la fábrica → encadenar cierre → devolver `{ closed, close }`. `serverCommandOf` guarda en el registro el comando entrecomillado (stdio) o la URL (HTTP) para que replay sepa re-ejecutarlo.

**Por qué:** `run.ts` espera `closed` para el código de salida (`0` cliente, `3` upstream muerto). Cerrar la persistencia al final es importante con WAL: deja los archivos SQLite consistentes entre la sesión y el `replay` CLI (comparten DB, NFR-9). Los `.catch(() => {})` garantizan que un error al cerrar no impida cerrar el resto.

**Si no estuviera:** el proceso se quedaría colgado al cerrar el cliente, saldría con el código equivocado, o los archivos SQLite quedarían sin cerrar entre sesión y replay.

---

## Glosario rápido

| Término | Significado |
|---|---|
| **MCP** | Model Context Protocol: el "idioma" JSON-RPC con el que hablan clientes y servidores. |
| **stdio / HTTP** | Los dos transportes del upstream: proceso local (líneas JSON por stdin/stdout) o Streamable HTTP remoto. |
| **`tools/call`** | La petición para ejecutar una herramienta. El único método que mcprelay intercepta. |
| **passthrough** | Todo lo demás: se reenvía sin cambios. |
| **`_meta`** | Campo del protocolo para datos extra: correlación, trazas OTel, token de progreso. En el relay, la credencial `authorization` se elimina aquí. |
| **`correlation_id`** | Identificador único por llamada, inyectado en `_meta.mcprelay` y presente en el log, el audit y el registro del DLQ. |
| **gate** | Una fase con nombre de la intercepción: credencial, policy. Los `throw` viven en `interceptToolCall`, junto a su condición. |
| **outcome** | El desenlace de una llamada: `allowed`, `denied` (policy/credencial), `failed` (D4 o `isError`), `cancelled`. |
| **D4** | La taxonomía de fallos: `pre_send` (nunca llegó), `timeout`, `post_send`, `cancelled` — decide qué se reintenta. |
| **captura** | El `FailureRecord` redactado que entra al DLQ **antes** de que el cliente vea el error; `replay` lo redriva. |
| **batch** | Array JSON-RPC con varios mensajes. El SDK no lo soporta; se retransmite crudo (stdio) o se rechaza con error claro (HTTP). |
| **`pinned`** | Holder con la instancia real del `Server` que atiende al cliente (las sondas de `serveStdio` se descartan). |
| **fallback** | El "cajón de sastre" del SDK: se llama cuando no hay handler específico para un método. |
| **`RelayRequest`** | La firma de la función que reenvía una petición al servidor real (con timeout/signal opcionales) y espera su resultado. |
| **exit code 3** | El servidor envuelto murió: el cliente recibe un error JSON-RPC y mcprelay sale con 3. |

---

## Siguiente parada sugerida

[`transports.md`](transports.md): el cable completo — el `FrameDecoder` compartido (partir bytes en líneas JSON, batches, orden de notificaciones), los dos transports stdio y `HttpUpstreamLink`. Es la capa que más bugs de orden nos dio y la que hace que este bridge no sepa (casi) nada del transporte.

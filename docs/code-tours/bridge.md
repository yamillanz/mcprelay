# Guía de estudio — `src/proxy/bridge.ts`

> **Qué es este archivo:** una copia comentada del código real, bloque por bloque. A la izquierda el código (idéntico al fuente, salvo que aquí no hay números de línea), debajo la explicación en español: **qué hace**, **por qué existe** y **qué pasaría si no estuviera**.
>
> El código y los identificadores se mantienen en inglés (convención del repo); la explicación va en español.
>
> **Fuente:** [`src/proxy/bridge.ts`](../../src/proxy/bridge.ts). Si el código cambia, esta guía debe actualizarse (es un espejo, no la fuente de verdad).
>
> **Contexto:** el bridge es el corazón de M1. Su trabajo es ponerse en medio de un cliente MCP y un servidor MCP (stdio), dejar pasar todo igual **excepto `tools/call`**, que se intercepta para correlacionar, medir y registrar. Decisiones y límites en [`docs/adr/0002-stdio-proxy-termination.md`](../adr/0002-stdio-proxy-termination.md).
>
> **Desde `readability-refactor` (M1):** todas las fases viven en funciones con nombre en este mismo archivo. El punto de entrada `startBridge` se lee como el algoritmo de arranque, de arriba a abajo. No hay módulos ni clases nuevas: la extracción es estructura, no indirección.

---

## Bloque A — Imports, schema permisivo y contratos públicos

```ts
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
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import type { CallLogEntry, CallLogger } from '../observability/call-log.js';
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
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface Bridge {
  /** Resolves with the side that ended the session first. */
  closed: Promise<'client' | 'upstream'>;
  close(): Promise<void>;
}
```

**Qué hace:** trae las piezas de fuera (SDK, transports, logger, contexto de sesión), define el schema que acepta cualquier resultado sin validarlo (`PASSTHROUGH_SCHEMA`) y los dos contratos públicos: `BridgeOptions` (entrada) y `Bridge` (salida: quién cerró y cómo apagar).

**Por qué:** el diseño es "dos lados": el SDK pone un rol en cada extremo (servidor hacia el cliente, cliente hacia el servidor real) y el bridge es el puente. `PASSTHROUGH_SCHEMA` evita añadir Zod: como proxy no validamos, solo dejamos pasar. Los `stdin`/`stdout` opcionales permiten inyectar streams falsos en tests.

**Si no estuviera:** `run.ts` tendría que conocer los detalles internos, y el SDK rechazaría cada respuesta por falta de schema.

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
  tool: string;
  serverName: string;
  decision: 'allowed' | 'failed';
  startedAt: number;
  requestBytes: number;
  responseBytes: number;
  error?: { message: string; code?: number };
}

type RelayRequest = (
  method: string,
  params: Record<string, unknown> | undefined,
  progressToken: unknown,
) => Promise<unknown>;

interface InterceptionDeps { relayRequest: RelayRequest; session: SessionContext; logger: CallLogger; }
interface PassthroughDeps { relayRequest: RelayRequest; session: SessionContext; }
interface ServerFactoryDeps { session: SessionContext; upstream: Client; logger: CallLogger; pinned: PinnedServerRef; }
interface CloseBridgeDeps { upstreamTransport: UpstreamTransport; upstream: Client; handle: StdioServerHandle; clientTransport: ClientTransport; }
```

**Qué hace:** nombra las formas de datos que se pasan entre helpers: señal de cierre, referencia al servidor "pinned", campos de traza OTel, metadatos preparados de una llamada, campos del log, la firma del reenviador (`RelayRequest`) y los paquetes de dependencias de cada helper (`…Deps`).

**Por qué:** antes estos tipos estaban implícitos dentro de `startBridge`; sacarlos arriba hace que cada función se lea sola y que el compilador vigile las fronteras. Los `…Deps` evitan listas largas de parámetros y hacen explícito qué necesita cada paso.

**Si no estuviera:** cada helper tendría firmas largas y duplicadas, y el estado compartido viajaría sin tipo.

---

## Bloque C — Helpers de datos

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
```

**Qué hace:** `byteLength` calcula el tamaño real en bytes de un mensaje (para el log). `progressTokenOf` saca, con cuidado de tipos, el token de progreso que el cliente puso en `params._meta`.

**Por qué:** operaciones pequeñas pero frágiles (JSON puede ser cualquier cosa) y repetidas; aislarlas evita errores y hace el resto más legible.

**Si no estuvieran:** un `params` inesperado rompería el bridge y cada uso repetiría los chequeos.

---

## Bloque D — Señales de cierre

```ts
function createCloseSignal(): CloseSignal {
  let resolveClosed: ResolveClosed = () => {};
  const closed = new Promise<CloseSide>((resolve) => {
    resolveClosed = resolve;
  });
  return { closed, resolveClosed };
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
```

**Qué hace:** crea la promesa `closed` (se resuelve una sola vez, con `'client'` o `'upstream'`), conecta los `onclose` de ambos transports a esa señal, **encadena** el `onclose` que `serveStdio` sobrescribe (si no, el cierre del cliente se perdería) y apaga todo en orden: servidor real → cliente SDK → servidor del cliente (`handle`) → transport del cliente.

**Por qué:** `run.ts` espera `closed` para decidir el código de salida (`0` cliente, `3` upstream muerto). El orden de apagado evita procesos y handles colgando (FR-P4). Los `.catch(() => {})` garantizan que un error al cerrar no impida cerrar el resto.

**Si no estuviera:** el proceso se quedaría colgado al cerrar el cliente (bug real que encontramos) o saldría con el código equivocado.

---

## Bloque E — Cables y batches

```ts
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
```

**Qué hace:** crea los dos "cables" (el del proceso hijo y el del cliente) y cruza sus callbacks `onBatch`: un frame batch (array JSON-RPC) que llega de un lado se escribe **tal cual** en el otro.

**Por qué:** el SDK modela *un mensaje* por vez; los arrays no caben. Los batches se saltan el SDK y se retransmiten crudos (límite documentado en ADR-0002: un `tools/call` dentro de un batch no se intercepta).

**Si no estuviera:** el middleware se rompería al recibir un batch.

---

## Bloque F — Lado upstream (cliente MCP y peticiones servidor→cliente)

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
```

**Qué hace:** crea el rol **cliente MCP** frente al servidor real (`versionNegotiation: 'auto'`: prueba `server/discover` moderno y cae a `initialize` clásico; capacidades `sampling`/`elicitation`/`roots` para poder retransmitir peticiones servidor→cliente). El holder `pinned` guarda la instancia real del `Server`. Los tres handlers reenvían las peticiones del servidor al cliente real; los dos relés de notificaciones conectan ambos sentidos (el progreso se excluye aquí y se reemite con el token original en el bloque I).

**Por qué:** sin las capacidades, el SDK no deja registrar los handlers (nos pasó: `Client does not support sampling capability`). El holder `pinned` reemplaza al antiguo `let` dentro de `startBridge`: el estado compartido ahora es explícito y tipado.

**Si no estuviera:** no habría conexión con el servidor real, ni peticiones servidor→cliente, ni notificaciones.

---

## Bloque G — Conexión y contexto de sesión

```ts
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
```

**Qué hace:** `connectUpstream` lanza el proceso del servidor (spawn), negocia protocolo y capacidades. `captureSessionContext` guarda lo aprendido: nombre/versión, capacidades, revisión negociada e instrucciones (con `mcprelay` como respaldo).

**Por qué:** el orden importa (diseño D2): **primero** el servidor, para que el `Server` del cliente pueda espejar sus capacidades. `connectUpstream` es una envoltura fina pero le da nombre a una fase del algoritmo.

**Si no estuviera:** el cliente hablaría con un servidor que aún no existe, o vería capacidades vacías.

---

## Bloque H — `createRelayRequest`: el reenviador

```ts
function createRelayRequest(server: Server, upstream: Client): RelayRequest {
  return async (method, params, progressToken) => {
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
}
```

**Qué hace:** devuelve la función que envía una petición al servidor real y espera su resultado sin validar la forma. Si la petición original traía `progressToken`, registra `onprogress` y reemite cada progreso al cliente **con el token original**.

**Por qué:** es el helper compartido por `tools/call` y el passthrough. Se crea **una vez por instancia de `Server`** (no por llamada), para no añadir closures en el hot path. Aquí vive la traducción de tokens: el SDK usa uno interno y nosotros lo devolvemos al del cliente.

**Si no estuviera:** cada handler repetiría la lógica de reenvío y progreso (y probablemente divergirían).

---

## Bloque I — Intercepción de `tools/call`

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
    attempt: 1,
    ...(fields.error === undefined ? {} : { error: fields.error }),
  };
}

async function interceptToolCall(
  deps: InterceptionDeps,
  request: { params: { name: string } & Record<string, unknown> },
): Promise<CallToolResult> {
  const startedAt = Date.now();
  const tool = request.params.name;
  const { correlationId, progressToken, params, trace } = prepareCallMetadata(request.params);
  const requestBytes = byteLength(params);

  try {
    const result = await deps.relayRequest('tools/call', params, progressToken);
    const isError = (result as { isError?: boolean }).isError === true;
    deps.logger.log(
      buildCallLogEntry({
        correlationId,
        trace,
        tool,
        serverName: deps.session.server.name,
        decision: isError ? 'failed' : 'allowed',
        startedAt,
        requestBytes,
        responseBytes: byteLength(result),
        ...(isError ? { error: { message: 'isError result' } } : {}),
      }),
    );
    return result as CallToolResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: number }).code;
    deps.logger.log(
      buildCallLogEntry({
        correlationId,
        trace,
        tool,
        serverName: deps.session.server.name,
        decision: 'failed',
        startedAt,
        requestBytes,
        responseBytes: 0,
        error: code === undefined ? { message } : { message, code },
      }),
    );
    throw error;
  }
}
```

**Qué hace:** el único método interceptado, ahora en tres piezas con nombre:
1. `prepareCallMetadata` genera el `correlation_id`, copia `_meta` y añade `mcprelay.correlation_id` **sin pisar** las claves OTel, que además separa para el log.
2. `interceptToolCall` reenvía la llamada con `relayRequest`, mide y decide `allowed`/`failed` (también `isError: true`).
3. `buildCallLogEntry` construye la línea JSON (una sola forma para éxito y fallo).

**Por qué:** cumple FR-P3 (intercepción), FR-P5 (correlación) y FR-O1 (log) sin meter todo en un handler gigante. Las operaciones y asignaciones son las mismas que antes del refactor: la extracción no añade trabajo por llamada.

**Si no estuviera:** `tools/call` pasaría sin más: ni correlación, ni métricas, ni log — no habría producto.

---

## Bloque J — Passthrough

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
```

**Qué hace:** todo método sin handler propio (`tools/list`, `resources/*`, `prompts/*`, `ping`, métodos desconocidos…) se reenvía y su resultado vuelve tal cual. Si es `tools/list`, guarda el inventario en el contexto de sesión.

**Por qué:** un solo punto para el passthrough en vez de un handler por método: el proxy aguanta revisiones nuevas del protocolo sin cambios.

**Si no estuviera:** el cliente recibiría "método no encontrado" para todo lo que no fuera `tools/call`.

---

## Bloque K — La fábrica de servidores

```ts
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

    server.setRequestHandler('tools/call', (request) =>
      interceptToolCall({ relayRequest, session: deps.session, logger: deps.logger }, request),
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

**Qué hace:** devuelve la función que `serveStdio` llama para crear el `Server` que atiende al cliente. Cada llamada crea una instancia **nueva** (con la identidad/capacidades del servidor real), la marca como `pinned`, le cuelga el handler de `tools/call`, el fallback de passthrough y un fallback de notificaciones no-op.

**Por qué:** `serveStdio` crea instancias "sonda" y las descarta; si devolviéramos siempre la misma, al descartar la sonda se cerraría la sesión real (bug real: el `initialize` respondía y todo se caía). El `fallbackNotificationHandler` no-op evita que el SDK duplique notificaciones que ya retransmitimos a nivel de transport.

**Si no estuviera:** la sesión se cerraría sola tras el `initialize`, o cada notificación llegaría dos veces.

---

## Bloque L — `startBridge`: el algoritmo de arranque

```ts
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
    createClientServerFactory({ session, upstream, logger: options.logger, pinned }),
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
```

**Qué hace:** es el algoritmo en 7 pasos legibles:
1. Crear la señal de cierre y los dos transports.
2. Conectar los batches (crudos, sin SDK).
3. Crear el cliente upstream y el holder `pinned`; registrar peticiones servidor→cliente y los relés de notificaciones; conectar las señales de cierre.
4. Conectar con el servidor real (**primero**, para espejar capacidades) y capturar el contexto de sesión.
5. Servir al cliente con `serveStdio` + la fábrica.
6. Encadenar el cierre del cliente (stdin EOF).
7. Devolver `{ closed, close }`.

**Por qué:** antes todo esto era un cuerpo de ~200 líneas con funciones anidadas. Ahora cualquier persona ve *la historia del arranque* de un vistazo y puede saltar al helper que le interese. Sin módulos ni clases nuevas: mismo archivo, mismo rendimiento.

**Si no estuviera:** no habría bridge; y sin esta refactorización, era el archivo más difícil de leer del proyecto.

---

## Glosario rápido

| Término | Significado |
|---|---|
| **MCP** | Model Context Protocol: el "idioma" JSON-RPC con el que hablan clientes y servidores. |
| **stdio** | El transporte por defecto: mensajes JSON separados por salto de línea por stdin/stdout. |
| **`tools/call`** | La petición para ejecutar una herramienta. El único método que mcprelay intercepta en M1. |
| **passthrough** | Todo lo demás: se reenvía sin cambios. |
| **`_meta`** | Campo del protocolo donde se meten datos extra (correlación, trazas OTel, token de progreso). |
| **`correlation_id`** | Identificador único por llamada, inyectado en `_meta.mcprelay` y presente en el log. |
| **batch** | Array JSON-RPC con varios mensajes. El SDK no lo soporta; se retransmite crudo. |
| **transport** | La capa que lee/escribe mensajes por un canal (stdin/stdout del cliente o del proceso hijo). |
| **`pinned`** | Holder con la instancia real del `Server` que atiende al cliente (las sondas de `serveStdio` se descartan). |
| **fallback** | El "cajón de sastre" del SDK: se llama cuando no hay handler específico para un método. |
| **`RelayRequest`** | La firma de la función que reenvía una petición al servidor real y espera su resultado. |
| **exit code 3** | El servidor envuelto murió: el cliente recibe un error JSON-RPC y mcprelay sale con 3. |

---

## Siguiente parada sugerida

`src/proxy/transports.ts`: el framing stdio (partir bytes en líneas JSON) y el demux de batches. Es la otra pieza "difícil" del proxy y la que más bugs de orden nos dio (microtasks del SDK).

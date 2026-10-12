# Guía de estudio — `src/proxy/transports.ts`

> **Qué es este archivo:** una copia comentada del código real, bloque por bloque. Arriba el código (idéntico al fuente), debajo la explicación en español: **qué hace**, **por qué existe** y **qué pasaría si no estuviera**.
>
> El código y los identificadores se mantienen en inglés (convención del repo); la explicación va en español.
>
> **Fuente:** [`src/proxy/transports.ts`](../../src/proxy/transports.ts) — **espejo de** `cefe854`. Si el código cambia, esta guía debe actualizarse en el mismo change (es un espejo, no la fuente de verdad).
>
> **Contexto:** este archivo es el **cable** del proxy. Su trabajo es convertir bytes en mensajes JSON-RPC (y viceversa) en los dos extremos — el cliente (stdin/stdout del proceso) y el servidor envuelto (proceso hijo **o** endpoint HTTP remoto) — con una sola implementación de framing. De aquí salieron los bugs más sutiles del proyecto: el orden entre una notificación de progreso y una respuesta que llegan en el mismo chunk. Historia del refactor en [`openspec/changes/archive/2026-10-05-refactor-run-transport/`](../../openspec/changes/archive/2026-10-05-refactor-run-transport/tasks.md) y límites en [`docs/adr/0002-stdio-proxy-termination.md`](../adr/0002-stdio-proxy-termination.md) / [`docs/adr/0007-http-transport.md`](../adr/0007-http-transport.md).
>
> **Nota de origen:** `FrameDecoder` existe gracias al refactor que unificó el pipeline duplicado de `UpstreamTransport` y `ClientTransport` — antes cada clase repetía su propia versión (buffering, parse, batches, orden, cierre) y las dos divergían.

---

## Bloque A — Imports y opciones del upstream stdio

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { StreamableHTTPClientTransport, type Client } from '@modelcontextprotocol/client';
import {
  deserializeMessage,
  isJSONRPCNotification,
  serializeMessage,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type Transport,
} from '@modelcontextprotocol/server';

export interface UpstreamTransportOptions {
  command: string;
  args: readonly string[];
  onStderr(chunk: string): void;
}
```

**Qué hace:** trae `spawn` (para el proceso hijo), el transporte HTTP del SDK y las funciones de serialización/detección de mensajes; define las opciones del upstream stdio (comando, argumentos y el callback al que se reenvía su stderr).

**Por qué:** `onStderr` es inyección pura: el transport no conoce `process` ni la CLI; quien lo construye decide dónde va el stderr del servidor envuelto (en producción, el stderr de mcprelay).

**Si no estuviera:** cada consumidor del transport tendría que reimplementar el spawn y decidir por su cuenta qué hacer con el error del proceso.

---

## Bloque B — `FrameDecoder`: el pipeline de framing compartido

```ts
function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((line) => line.trim()).filter((line) => line.length > 0), rest };
}

interface FrameHandlers {
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onBatch?: (line: string) => void;
  onNotification?: (notification: JSONRPCNotification) => void;
}

/**
 * Line-framing pipeline shared by the upstream and client-facing transports:
 * buffers chunks, parses frames, and dispatches batches, notifications,
 * messages, and errors to the owning transport's handlers.
 */
class FrameDecoder {
  private buffer = '';
  private processing: Promise<void> = Promise.resolve();

  constructor(private readonly handlers: FrameHandlers) {}

  push(chunk: string): void {
    const { lines, rest } = splitLines(this.buffer, chunk);
    this.buffer = rest;
    for (const line of lines) {
      // The SDK dispatches notification handlers as microtasks; yielding
      // between frames keeps progress notifications from being overtaken by a
      // response that arrived in the same chunk.
      this.processing = this.processing.then(() => this.processLine(line));
    }
  }

  private async processLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.handlers.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (Array.isArray(parsed)) {
      this.handlers.onBatch?.(line);
      return;
    }
    try {
      const message = deserializeMessage(line);
      if (isJSONRPCNotification(message)) this.handlers.onNotification?.(message);
      this.handlers.onmessage?.(message);
    } catch (error) {
      this.handlers.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
    await Promise.resolve();
  }
}
```

**Qué hace:** `splitLines` parte bytes en líneas completas guardando el resto incompleto en `buffer` (los chunks de un pipe no respetan fronteras de línea). `FrameDecoder` recibe chunks por `push`, encola cada línea en una **cadena de promesas** (`processing`) y las procesa en orden: JSON inválido → `onerror` y a la siguiente; array JSON-RPC → `onBatch` (el SDK no lo modela); mensaje normal → `deserializeMessage` + `onNotification` (si lo es) + `onmessage`. El `await Promise.resolve()` al final cede el microtask.

**Por qué:** dos decisiones finas, ambas por bugs reales: (1) procesar en serie con `processing.then(...)` garantiza que los frames de un mismo chunk se despachen en el orden del wire — sin eso, una notificación de progreso podía ser adelantada por la respuesta que venía detrás; (2) un frame individual inválido **no** tumba el pipeline: se reporta y se sigue. El decoder es único (mismo archivo, privado) para que stdio y HTTP no diverjan.

**Si no estuviera:** cada transport tendría su propia copia del framing (así era antes), el orden de despacho dependería de la suerte del event loop, y un frame corrupto mataría la sesión entera.

---

## Bloque C — `UpstreamTransport`: el proceso hijo (parte pública)

```ts
/**
 * Transport for the wrapped upstream server: spawns the command and speaks
 * newline-delimited JSON-RPC. Single messages go through the SDK protocol
 * classes; JSON-RPC batch arrays are surfaced through `onBatch` and relayed
 * verbatim, because the SDK message model cannot represent them.
 */
export class UpstreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onBatch?: (line: string) => void;
  onNotification?: (notification: JSONRPCNotification) => void;

  private readonly decoder: FrameDecoder;
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private closing = false;

  constructor(private readonly options: UpstreamTransportOptions) {
    this.decoder = new FrameDecoder(this);
  }

  /** True once the upstream process has been spawned and is still alive. */
  get connected(): boolean {
    return this.child !== undefined && !this.closed;
  }

  async start(): Promise<void> {
    const child = this.spawnChild();
    this.forwardUpstreamStderr(child);
    this.watchChildError(child);
    this.watchChildExit(child);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.writeLine(serializeMessage(message));
  }

  /** Relays a raw frame verbatim (JSON-RPC batch arrays). */
  sendRaw(line: string): void {
    this.writeLine(line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.child?.stdin.end();
    this.child?.kill('SIGTERM');
    this.finish();
  }
```

**Qué hace:** el transport del servidor envuelto. Expone los handlers que el SDK y el bridge asignan, compone un `FrameDecoder` (pasándose a sí mismo como handlers), y su API pública: `connected` (¿spawneado y vivo?), `start()` como tres pasos con nombre — spawn, forward de stderr, vigilar error y exit —, `send()` (serializa y escribe), `sendRaw()` (frame crudo, para batches) y `close()` (marca `closing`, cierra stdin, SIGTERM, `finish`).

**Por qué:** `closing` existe para que la salida esperada por `close()` no se reporte como error (ver bloque C2). `connected` es lo que consultan los gates del bridge (`attemptToolCall` devuelve `pre_send` si es falso). `finish()` es idempotente: `onclose` se llama exactamente una vez, cierre quien cierre.

**Si no estuviera:** `start()` volvería a ser un bloque de wiring inline, y nadie podría preguntar "¿está vivo el upstream?" sin mirar el proceso a pelo.

---

## Bloque C2 — `UpstreamTransport`: el wiring del proceso hijo

```ts
  private spawnChild(): ChildProcessWithoutNullStreams {
    const child = spawn(this.options.command, [...this.options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.decoder.push(chunk);
    });
    return child;
  }

  private forwardUpstreamStderr(child: ChildProcessWithoutNullStreams): void {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.options.onStderr(chunk);
    });
  }

  private watchChildError(child: ChildProcessWithoutNullStreams): void {
    child.on('error', (error: Error) => {
      this.onerror?.(error);
      this.finish();
    });
  }

  private watchChildExit(child: ChildProcessWithoutNullStreams): void {
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.closing && (code !== 0 || signal !== null)) {
        this.onerror?.(
          new Error(`upstream exited (code ${String(code)}, signal ${String(signal)})`),
        );
      }
      this.finish();
    });
  }

  private writeLine(line: string): void {
    this.child?.stdin.write(`${line}\n`);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
```

**Qué hace:** `spawnChild` lanza el proceso con los tres pipes y conecta su stdout al decoder. `forwardUpstreamStderr` retransmite su stderr entero. `watchChildError`/`watchChildExit` cierran el transport siempre y solo reportan error si la salida **no** fue pedida (`!closing`) **y** fue anómala (código ≠ 0 o señal) — y en ese caso el SDK del bridge traduce "el upstream murió" en el exit code 3. `writeLine` escribe con el `\n` de framing (stdio es newline-delimited). `finish` garantiza el `onclose` único.

**Por qué:** distinguir "salida pedida" de "salida inesperada" es lo que evita falsos positivos en logs y en el código de salida: un SIGTERM nuestro no es un crash. `finish()` como guard único hace segura la carrera entre exit y close.

**Si no estuviera:** cada close dispararía errores espurios, y la salida corrupta del upstream pasaría desapercibida.

---

## Bloque D — `UpstreamTarget` y el puerto `UpstreamLink`

```ts
/** Upstream to wrap: a local stdio process or a remote Streamable HTTP server. */
export type UpstreamTarget =
  | { kind: 'stdio'; command: string; args: readonly string[] }
  | { kind: 'http'; url: string; headers: Record<string, string> };

/** What the bridge needs from an upstream connection, independent of its transport. */
export interface UpstreamLink {
  readonly kind: 'stdio' | 'http';
  readonly connected: boolean;
  connect(client: Client): Promise<void>;
  relayNotifications(relay: (notification: JSONRPCNotification) => void): void;
  setCloseRelay(relay: () => void): void;
  sendBatch(line: string): void;
  setBatchRelay(relay: (line: string) => void): void;
  close(): Promise<void>;
}
```

**Qué hace:** `UpstreamTarget` es lo que el CLI le pide envolver — un comando local o una URL HTTP con headers. `UpstreamLink` es el **puerto**: exactamente lo que el bridge necesita de un upstream sin saber de qué transporte se trata (conectividad, relés de notificación/cierre/batches, y cierre), más `kind` para las pocas decisiones que sí dependen del transporte (registro de capturas, batches).

**Por qué:** esta abstracción es la que permitió añadir HTTP (M6) **sin duplicar el bridge**: `startBridge` habla con el puerto y `createUpstreamLink` decide la implementación. Es la abstracción de puertos de §6.2 aplicada a la dirección upstream: la misma idea que hace intercambiables los backends de cola (`QueueProvider`/`Store`) aquí hace intercambiables los transportes hacia el servidor.

**Si no estuviera:** el bridge tendría un `if (http)` en cada punto de contacto, o dos bridges paralelos.

---

## Bloque E — `StdioUpstreamLink`: el adaptador stdio

```ts
export class StdioUpstreamLink implements UpstreamLink {
  readonly kind = 'stdio' as const;
  private readonly transport: UpstreamTransport;

  constructor(options: UpstreamTransportOptions) {
    this.transport = new UpstreamTransport(options);
  }

  get connected(): boolean {
    return this.transport.connected;
  }

  async connect(client: Client): Promise<void> {
    await client.connect(this.transport);
  }

  relayNotifications(relay: (notification: JSONRPCNotification) => void): void {
    this.transport.onNotification = relay;
  }

  setCloseRelay(relay: () => void): void {
    this.transport.onclose = relay;
  }

  sendBatch(line: string): void {
    this.transport.sendRaw(line);
  }

  setBatchRelay(relay: (line: string) => void): void {
    this.transport.onBatch = relay;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
```

**Qué hace:** mapea cada método del puerto sobre el `UpstreamTransport` real: conectar = `client.connect(transport)` (el SDK spawnea y negocia), los relés son asignaciones de handlers, batch = `sendRaw`, close = `close`.

**Por qué:** es un adaptador fino a propósito — toda la inteligencia vive en el transport; el link solo traduce vocabulario (`relayNotifications` en vez de `onNotification`) para que el bridge no toque al SDK directamente.

**Si no estuviera:** el bridge importaría `UpstreamTransport` (la implementación) y perdería la intercambiabilidad con HTTP.

---

## Bloque F — `HttpUpstreamLink`: el vínculo remoto

```ts
export class HttpUpstreamLink implements UpstreamLink {
  readonly kind = 'http' as const;
  private readonly transport: StreamableHTTPClientTransport;
  private relay: ((notification: JSONRPCNotification) => void) | undefined;
  private started = false;
  private closed = false;

  constructor(options: { url: string; headers: Record<string, string> }) {
    this.transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: options.headers },
    });
  }

  get connected(): boolean {
    return this.started && !this.closed;
  }

  async connect(client: Client): Promise<void> {
    await this.connectTransport(client);
    this.mirrorNotificationsAfterConnect();
  }

  private async connectTransport(client: Client): Promise<void> {
    await client.connect(this.transport);
  }

  private mirrorNotificationsAfterConnect(): void {
    // Wrap after connect: the protocol layer assigns `onmessage` during it.
    const downstream = this.transport.onmessage;
    this.transport.onmessage = (message) => {
      if (isJSONRPCNotification(message)) this.relay?.(message);
      downstream?.(message);
    };
    this.started = true;
  }

  relayNotifications(relay: (notification: JSONRPCNotification) => void): void {
    this.relay = relay;
  }

  setCloseRelay(relay: () => void): void {
    this.transport.onclose = relay;
  }

  /** Batch frames are not supported over HTTP; the bridge answers the client instead. */
  sendBatch(_line: string): void {}

  setBatchRelay(_relay: (line: string) => void): void {}

  async close(): Promise<void> {
    this.closed = true;
    await this.transport.close().catch(() => {});
  }
```

**Qué hace:** envuelve el `StreamableHTTPClientTransport` del SDK con `requestInit.headers` (los `upstream.http.headers` de la config). `connect` = conectar y **después** espejar notificaciones. `mirrorNotificationsAfterConnect` **envuelve** el `onmessage` que el SDK asignó durante el connect: cuando llega una notificación, la pasa además al `relay` del bridge, y siempre llama al handler original. Los batches sobre HTTP son no-ops deliberados: el protocolo 2026-07-28 los eliminó y el bridge contesta con un error claro (bloque D del tour de `bridge.md`).

**Por qué:** la nota "Wrap after connect" documenta un bug sutil: si envuelves `onmessage` **antes** del connect, la capa de protocolo lo reasigna y pierdes el wrapper — el orden importa y está fijado por un comentario. `started`/`closed` son los flags con los que `connected` responde sin tocar el estado interno del SDK; `close()` marca `closed` y cierra el transporte del SDK sin propagar errores (el cierre no debe fallar dos veces). El `relay` es un campo mutable (no un handler del SDK) porque sobre HTTP el SDK es dueño de `onmessage`.

**Si no está el wrap después del connect:** las notificaciones upstream sobre HTTP llegarían al SDK pero no al puente — se rompería la paridad stdio/HTTP.

---

## Bloque G — `createUpstreamLink`: la fábrica

```ts
export function createUpstreamLink(
  target: UpstreamTarget,
  onStderr: (chunk: string) => void,
): UpstreamLink {
  return target.kind === 'stdio'
    ? new StdioUpstreamLink({ command: target.command, args: target.args, onStderr })
    : new HttpUpstreamLink({ url: target.url, headers: target.headers });
}
```

**Qué hace:** la única decisión stdio-vs-HTTP del archivo, en un solo sitio.

**Por qué:** concentrar el `if` en una fábrica mantiene el resto del archivo polimórfico (cada link implementa el mismo puerto) y hace trivial añadir un tercer transporte en el futuro.

**Si no estuviera:** cada construcción de link repetiría el condicional.

---

## Bloque H — `ClientTransport`: el lado del cliente

```ts
export interface ClientTransportOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/**
 * Transport facing the MCP client: reads the middleware's stdin, writes its
 * stdout. Batch arrays bypass the SDK protocol classes through `onBatch`.
 */
export class ClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onBatch?: (line: string) => void;
  onNotification?: (notification: JSONRPCNotification) => void;

  private readonly decoder: FrameDecoder;
  private closed = false;

  constructor(private readonly options: ClientTransportOptions = {}) {
    this.decoder = new FrameDecoder(this);
  }

  async start(): Promise<void> {
    this.attachStdin();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.writeLine(serializeMessage(message));
  }

  /** Relays a raw frame verbatim (JSON-RPC batch arrays). */
  sendRaw(line: string): void {
    this.writeLine(line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.detachStdin();
    this.finish();
  }

  private attachStdin(): void {
    const stdin = this.options.stdin ?? process.stdin;
    stdin.setEncoding('utf8');
    stdin.on('data', this.onDataHandler);
    stdin.on('end', this.onEndHandler);
    stdin.resume();
  }

  private detachStdin(): void {
    const stdin = this.options.stdin ?? process.stdin;
    stdin.off('data', this.onDataHandler);
    stdin.off('end', this.onEndHandler);
    stdin.pause();
  }

  private readonly onDataHandler = (chunk: string): void => {
    this.decoder.push(chunk);
  };

  private readonly onEndHandler = (): void => {
    this.finish();
  };

  private writeLine(line: string): void {
    const stdout = this.options.stdout ?? process.stdout;
    stdout.write(`${line}\n`);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
```

**Qué hace:** el transport que `serveStdio` usa para hablar con el cliente real: lee su stdin (con `stdin`/`stdout` inyectables para tests) y escribe en su stdout. Comparte el mismo `FrameDecoder` que el upstream. `start()` = attach; `close()` = detach (quita los listeners por referencia, pausa) + `finish()` idempotente. El `'end'` de stdin (el cliente cerró) llama a `finish()` → `onclose` → que el bridge encadena para resolver `closed` con `'client'`.

**Por qué:** `onDataHandler`/`onEndHandler` son **arrow properties**, no métodos: su identidad es estable por instancia, y eso es exactamente lo que permite `stdin.off('data', this.onDataHandler)` en el detach — con métodos normales, `off` no encontraría la misma función. El `\n` final en cada escritura es el framing que el otro extremo espera.

**Si no estuviera:** no habría forma de servir al cliente desde el proceso, ni de inyectar streams falsos en los tests, ni de desenganchar stdin limpiamente al cerrar.

---

## Glosario rápido

| Término | Significado |
|---|---|
| **framing** | Convertir bytes de un pipe en líneas JSON-RPC completas (y guardar el resto). |
| **`FrameDecoder`** | El pipeline único de framing: buffer, parse, batches, notificaciones, errores, orden. |
| **batch** | Array JSON-RPC; el SDK no lo modela — stdio lo relaya crudo, HTTP lo rechaza con error claro. |
| **microtask yield** | El `await Promise.resolve()` entre frames que evita que una respuesta adelante a una notificación del mismo chunk. |
| **`UpstreamTarget`** | Qué envolver: `{ kind: 'stdio', command, args }` o `{ kind: 'http', url, headers }`. |
| **`UpstreamLink`** | El puerto del upstream: lo que el bridge necesita, sin saber el transporte. |
| **`connected`** | Upstream vivo y listo; `attemptToolCall` lo consulta antes de intentar. |
| **`closing`** | "El cierre fue pedido": distingue una salida esperada de un crash al reportar errores. |
| **`finish()`** | El cierre idempotente: `onclose` exactamente una vez, venga de donde venga. |
| **arrow property** | Handler definido como propiedad flecha: identidad estable por instancia, indispensable para `off()` en el detach. |

---

## Siguiente parada sugerida

[`replay-run.md`](replay-run.md): el motor del diferenciador — `replay run` como redrive de efectos: guards, dedup, claims atómicos y la captura del resultado en el audit. Ahí es donde el trabajo de este cable (registros durables con comando y transporte) se convierte en una re-ejecución real.

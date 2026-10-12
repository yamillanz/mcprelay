# Guía de estudio — `src/replay/replay-run.ts`

> **Qué es este archivo:** una copia comentada del código real, bloque por bloque. Arriba el código (idéntico al fuente), debajo la explicación en español: **qué hace**, **por qué existe** y **qué pasaría si no estuviera**.
>
> El código y los identificadores se mantienen en inglés (convención del repo); la explicación va en español.
>
> **Fuente:** [`src/replay/replay-run.ts`](../../src/replay/replay-run.ts) — **espejo de** `cefe854`. Si el código cambia, esta guía debe actualizarse en el mismo change (es un espejo, no la fuente de verdad).
>
> **Contexto:** este archivo es **el motor del diferenciador**. `replay run <id>` y `replay run --all` redrivan registros del DLQ: re-conectan al servidor guardado, re-ejecutan la llamada, y capturan el resultado (redactado) en el audit — porque la sesión del agente original ya no existe, el audit es el único sitio donde vive el outcome ([`docs/adr/0005-replay-semantics.md`](../adr/0005-replay-semantics.md)). Aquí viven también las dos guardas de seguridad de efectos: los marcadores `[REDACTED]` bloquean la ejecución hasta que se suplan con `--set`, y el dedup (`dedup_window`) rechaza duplicados salvo `--force`. La CLI ([`replay-cli.ts`](../../src/replay/replay-cli.ts)) solo parsea y despacha hacia `runReplayRecord`/`runReplayBatch`.

---

## Bloque A — Imports y contratos de entrada/salida

```ts
import { Client } from '@modelcontextprotocol/client';

import { loadConfig, resolveToolPolicy, type McprelayConfig } from '../config/config.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { extractIdempotencyKey } from '../pipeline/idempotency.js';
import type { FailureFilter, FailureRecord } from '../queue/failure-record.js';
import { RecordNotFoundError, type IdempotencyIndex, type QueueProvider } from '../queue/port.js';
import { createPersistence } from '../queue/providers.js';
import { HttpUpstreamLink, StdioUpstreamLink, type UpstreamLink } from '../proxy/transports.js';
import { redactDeep } from '../redaction/redact.js';
import type { Store } from '../store/sqlite-store.js';
import { packageVersion } from '../version.js';
import { parseCommandLine } from './command-line.js';
import { applyOverrides, dedupVerdict, type DedupVerdict } from './guards.js';
```

```ts
export interface ReplayRunIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface ReplayRunOptions {
  id: string;
  all: boolean;
  filter: FailureFilter;
  dryRun: boolean;
  force: boolean;
  overrides: Record<string, string>;
  configPath?: string;
  json: boolean;
}
```

**Qué hace:** los imports dibujan el mapa de dependencias: config (dedup window, redacción, headers), exit codes, el índice de idempotencia, la cola y su persistencia, los links de `transports` (los mismos del bridge para reconectar), la redacción profunda, el store (audit) y los guards del propio directorio. `ReplayRunIO` es el puerto de salida (stdout/stderr inyectables — la CLI pasa `process`, los tests pasan capturadores); `ReplayRunOptions` es todo lo que puede pedir un `replay run`: un id o `--all` con filtros, dry-run, force, overrides de argumentos y JSON.

**Por qué:** la IO inyectada es lo que hace estos flujos testeables sin proceso real; el paquete de opciones evita una firma de diez parámetros.

**Si no estuviera:** cada test tendría que espiar el proceso, y las dos entry points cargarían con listas de parámetros gigantes.

---

## Bloque B — El vocabulario del archivo

```ts
/** The replay's own (redacted) result or error — the only place its outcome lives. */
interface RunOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

type ReplayAttempt =
  { kind: 'unreachable'; message: string } | { kind: 'executed'; outcome: RunOutcome };

type Queue = QueueProvider & IdempotencyIndex;

interface Providers {
  queue: Queue;
  store: Store;
  close(): Promise<void>;
}

interface CallIdentity {
  key?: string;
  argumentsHash: string;
}

const CLAIM_LEASE_MS = 5 * 60 * 1000;
```

**Qué hace:** `RunOutcome` es el resultado del replay **tal como quedará guardado** (redactado; es lo único que sobrevive). `ReplayAttempt` distingue los dos desenlaces posibles de un intento: **no se pudo ni conectar** (`unreachable` — el registro queda pendiente, no es culpa de la llamada) o **se ejecutó** (con outcome ok/error). `Queue` compone las dos mitades de la persistencia (registros + índice de idempotencia) y `Providers` las agrupa con su cierre. `CallIdentity` es lo que hace falta para el dedup/indexación. `CLAIM_LEASE_MS` es el lease del claim: 5 minutos.

**Por qué:** `unreachable` vs `executed` es LA distinción del replay honesto: si el servidor no está, no se inventa un fallo del tool ni se marca el registro como resuelto — queda pendiente para el próximo intento (y `persistOutcome` lo trata distinto). El lease de 5 minutos permite que un replay muerto a mitad no bloquee el registro para siempre: el claim expira.

**Si no estuviera:** un servidor apagado "quemaría" registros (marcados como fallidos sin haberlos intentado) y no habría forma de nombrar los desenlaces.

---

## Bloque C — Marcadores redactados, config y proveedores

```ts
function redactedMarkerKeys(value: unknown, prefix = ''): string[] {
  if (value === '[REDACTED]') return [prefix === '' ? '(root)' : prefix];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => redactedMarkerKeys(entry, `${prefix}[${index}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    redactedMarkerKeys(entry, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function loadReplayConfig(options: ReplayRunOptions, io: ReplayRunIO): McprelayConfig | undefined {
  try {
    const config = loadConfig(options.configPath === undefined ? {} : { path: options.configPath });
    for (const warning of config.warnings) io.stderr(`mcprelay: warning: ${warning}\n`);
    return config;
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

function openProviders(config: McprelayConfig, io: ReplayRunIO): Providers | undefined {
  try {
    const persistence = createPersistence(config);
    const queue = persistence.getQueue();
    const store = persistence.getStore();
    return { queue, store, close: () => persistence.close() };
  } catch (error) {
    io.stderr(
      `mcprelay: cannot open the queue/store: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}
```

**Qué hace:** `redactedMarkerKeys` recorre los argumentos almacenados y devuelve las **rutas** (`api_key`, `headers.authorization`, `items[2].token`) donde quedó un `[REDACTED]`. `loadReplayConfig` carga la config (misma que usa el middleware, para el dedup window, redacción y headers HTTP) y degrada con mensaje + `undefined` si falla. `openProviders` abre la persistencia configurada (SQLite o RabbitMQ + store) y devuelve las dos mitades con su `close`.

**Por qué:** las rutas exactas se le usan al usuario para decirle **qué** claves faltan con `--set` — sin `redactedMarkerKeys` el mensaje sería "faltan valores" sin decir cuáles. Los dos helpers convierten errores de infraestructura en códigos de salida (nunca en excepciones sin manejar), porque esto es una CLI.

**Si no estuviera:** el guard de redacción no podría decir qué suplir, y un config roto reventaría con stacktrace en vez de un mensaje y exit code.

---

## Bloque D — Las guardas: fetch, argumentos, dedup y claim

```ts
async function fetchRecord(
  queue: Queue,
  id: string,
  io: ReplayRunIO,
): Promise<FailureRecord | undefined> {
  const record = await queue.get(id);
  if (record === null) io.stderr(`mcprelay: failure record '${id}' not found\n`);
  return record ?? undefined;
}

function resolveArguments(
  record: FailureRecord,
  overrides: Record<string, string>,
): { replayArguments: Record<string, unknown>; remainingMarkers: string[] } {
  const storedArguments = (record.tool.arguments ?? {}) as Record<string, unknown>;
  const replayArguments = applyOverrides(storedArguments, overrides);
  return { replayArguments, remainingMarkers: redactedMarkerKeys(replayArguments) };
}

async function computeDedupVerdict(
  queue: Queue,
  config: McprelayConfig,
  record: FailureRecord,
  key: string | undefined,
): Promise<DedupVerdict> {
  return dedupVerdict({
    ...(key === undefined ? {} : { key }),
    argumentsHash: record.tool.arguments_hash,
    windowMs: config.reliability.replay.dedupWindowMs,
    now: new Date(),
    lastByKey: key === undefined ? null : await queue.lastExecution(key),
    lastByHash:
      key === undefined ? await queue.lastExecutionByHash(record.tool.arguments_hash) : null,
  });
}

/** Returns an exit code when the run must be refused, undefined when it may proceed. */
function guardRun(deps: {
  remainingMarkers: string[];
  verdict: DedupVerdict;
  force: boolean;
  io: ReplayRunIO;
}): number | undefined {
  if (deps.remainingMarkers.length > 0) {
    deps.io.stderr(
      `mcprelay: stored arguments contain redacted values (${deps.remainingMarkers.join(', ')}); ` +
        `supply them with --set key=value before replaying\n`,
    );
    return EXIT_FAILURE;
  }
  if (deps.verdict.duplicate && !deps.force) {
    deps.io.stderr(
      `mcprelay: duplicate side-effect risk: '${deps.verdict.previous?.key}' was successfully executed at ` +
        `${deps.verdict.previous?.executedAt} (${deps.verdict.matchedBy}); use --force to replay anyway\n`,
    );
    return EXIT_FAILURE;
  }
  return undefined;
}

async function claimOrReport(
  queue: Queue,
  record: FailureRecord,
  io: ReplayRunIO,
): Promise<boolean> {
  try {
    await queue.claim(record.id, CLAIM_LEASE_MS);
    return true;
  } catch (error) {
    io.stderr(
      `mcprelay: cannot claim '${record.id}': ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}
```

**Qué hace:** `fetchRecord` busca el registro (`RecordNotFoundError` se maneja arriba, en el orquestador). `resolveArguments` aplica los `--set key=value` por encima de los argumentos almacenados y recalcula qué marcadores **quedan**. `computeDedupVerdict` construye el veredicto de duplicado: por clave (si el registro tiene una) o por hash de argumentos, mirando las últimas ejecuciones en el índice. `guardRun` es la **guarda de efecto**: devuelve un exit code (y explica) si quedan marcadores o si hay duplicado sin `--force`; `undefined` = adelante. `claimOrReport` toma el claim atómico con lease; si otro replay lo tiene, se reporta y el registro queda intacto.

**Por qué:** el orden importa: primero **reparar argumentos** (los `--set` pueden eliminar el bloqueo de redacción), después el **dedup**, después el **claim**. El claim es lo que hace concurrent-safe el replay (dos procesos, un solo ejecutor) — y su lease hace que un ejecutor muerto no bloquee para siempre. `guardRun` devuelve códigos en vez de lanzar: es una CLI y el flujo de refusal debe leerse como datos.

**Si no estuviera:** se podrían re-ejecutar efectos con secretos redactados "silenciosamente", duplicar side effects, o que dos batch simultáneos ejecutaran la misma llamada dos veces.

---

## Bloque E — Reconectar al servidor guardado

```ts
/** Reconnects over the record's transport: stdio command, or HTTP endpoint + config headers. */
async function connectStoredServer(
  record: FailureRecord,
  config: McprelayConfig,
): Promise<{ client: Client; link: UpstreamLink }> {
  const link: UpstreamLink =
    record.server.transport === 'http'
      ? new HttpUpstreamLink({
          url: record.server.command,
          headers: config.upstream.http.headers,
        })
      : new StdioUpstreamLink({
          ...parseCommandLine(record.server.command),
          onStderr: (chunk) => {
            process.stderr.write(chunk);
          },
        });
  const client = new Client(
    { name: 'mcprelay-replay', version: packageVersion() },
    {
      versionNegotiation: { mode: 'auto' },
      capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
    },
  );
  await link.connect(client);
  return { client, link };
}

async function closeUpstream(upstream: { client: Client; link: UpstreamLink }): Promise<void> {
  await upstream.link.close().catch(() => {});
  await upstream.client.close().catch(() => {});
}

async function listToolNames(client: Client): Promise<string[]> {
  const result = (await client.listTools()) as { tools: Array<{ name: string }> };
  return result.tools.map((tool) => tool.name);
}
```

**Qué hace:** reconstruye el upstream **desde el registro**: si el `server.transport` guardado es `http`, conecta a `server.command` como URL (con los headers de la config actual); si es stdio, parsea `server.command` (entrecomillado por `quoteCommandLine`) y lanza el proceso. El cliente se presenta como `mcprelay-replay` y negocia versión igual que el bridge. `closeUpstream` cierra sin propagar errores; `listToolNames` es la lectura para el chequeo del dry-run.

**Por qué:** aquí es donde se cobra el trabajo del bridge al capturar `server.command`/`transport` en el `FailureRecord`: el replay no necesita ninguna información externa para volver al mismo servidor. El parseo del comando guardado (`parseCommandLine`) es el inverso exacto del quoting del bridge — si uno cambia, el otro debe cambiar (hay tests que los emparejan).

**Si no estuviera:** el replay no sabría a dónde reconectar, o duplicaría la lógica de links que ya existe en transports.

---

## Bloque F — `attemptReplay`: la ejecución (una sola vez)

```ts
/** Connects and executes once; touches no queue state (the caller decides release/resolve). */
async function attemptReplay(
  config: McprelayConfig,
  record: FailureRecord,
  replayArguments: Record<string, unknown>,
): Promise<ReplayAttempt> {
  let upstream: { client: Client; link: UpstreamLink };
  try {
    upstream = await connectStoredServer(record, config);
  } catch (error) {
    return {
      kind: 'unreachable',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const policy = resolveToolPolicy(config, record.tool.name);
    const result = (await upstream.client.callTool(
      { name: record.tool.name, arguments: replayArguments },
      { timeout: policy.timeoutMs },
    )) as Record<string, unknown>;
    const isError = result.isError === true;
    return {
      kind: 'executed',
      outcome: isError
        ? {
            ok: false,
            error: 'tool reported isError',
            result: redactDeep(result, config.redaction.patterns),
          }
        : { ok: true, result: redactDeep(result, config.redaction.patterns) },
    };
  } catch (error) {
    return {
      kind: 'executed',
      outcome: {
        ok: false,
        error: redactDeep(
          error instanceof Error ? error.message : String(error),
          config.redaction.patterns,
        ) as string,
      },
    };
  } finally {
    await closeUpstream(upstream);
  }
}
```

**Qué hace:** si no puede conectar → `unreachable` (sin tocar la cola). Si conecta: resuelve la política del tool para el timeout, ejecuta **una vez** `tools/call` con los argumentos reparados, y construye el outcome — `isError` cuenta como fallo (`ok: false`) y **todo** el resultado o mensaje de error pasa por `redactDeep` antes de salir de aquí. `finally` cierra el upstream siempre.

**Por qué:** la redacción **en la frontera** es la garantía NFR-4 del replay: lo que sale de esta función es lo que se persistirá, y ya está redactado — no hay una segunda oportunidad de olvidarlo. "Toca la cola cero veces" es deliberado: el caller decide `release` (unreachable) o `resolve` (ejecutado) — la ejecución y la persistencia están separadas para que un crash entre ambas no deje un registro mentiroso.

**Si no estuviera:** el resultado del replay podría llevar secretos a la DB, o un crash a mitad dejaría el registro marcado sin haber capturado el outcome.

---

## Bloque G — `persistOutcome`: release o resolve + audit + índice

```ts
/** Unreachable → release (stays pending); executed → resolve + audit + idempotency index. */
async function persistOutcome(
  providers: Providers,
  record: FailureRecord,
  attempt: ReplayAttempt,
  identity: CallIdentity,
): Promise<void> {
  if (attempt.kind === 'unreachable') {
    await providers.queue.release(record.id);
    return;
  }

  const attemptEntry = { at: new Date().toISOString(), source: 'replay' as const };
  await providers.queue.resolve(record.id, {
    status: 'replayed',
    attempts: [...record.replay.attempts, attemptEntry],
    lastOutcome: attempt.outcome,
  });
  await providers.store.audit({
    kind: 'replayed',
    correlationId: record.correlation_id,
    failureId: record.id,
    toolName: record.tool.name,
    detail: attempt.outcome,
  });

  if (attempt.outcome.ok && identity.key !== undefined) {
    await providers.queue.recordExecution({
      key: identity.key,
      toolName: record.tool.name,
      argumentsHash: identity.argumentsHash,
      executedAt: attemptEntry.at,
      source: 'replay',
    });
  }
}
```

**Qué hace:** `unreachable` → **release** del claim (el registro sigue `pending`, listo para reintentar). Ejecutado → **resolve** con `status: 'replayed'` y el outcome como `lastOutcome` (el registro conserva la historia de intentos), **audit** `kind: 'replayed'` con el outcome en el detalle (aquí es donde `report` cuenta `replayed`, y donde vive el resultado para siempre), y si fue exitoso **y había clave**, se indexa la ejecución (`source: 'replay'`) para que el dedup la vea.

**Por qué:** este bloque es *la semántica honesta del replay* escrita en código: el outcome no va al agente (no existe), va al audit; el registro no se borra, se resuelve con historia; y el índice de ejecuciones se actualiza también desde replay para que un segundo replay del mismo key sea rechazado. Solo los replays **ok** indexan: un replay fallido no "ejecutó" nada que haya que deduplicar.

**Si no estuviera:** los registros no tendrían desenlace, el audit no mostraría los replays, y el guard de duplicados tendría un agujero por el lado del replay.

---

## Bloque H — Reportar al usuario

```ts
function reportOutcome(
  io: ReplayRunIO,
  record: FailureRecord,
  attempt: ReplayAttempt,
  json: boolean,
): number {
  if (attempt.kind === 'unreachable') {
    io.stderr(
      `mcprelay: replay could not reach the tool (${attempt.message}); record left pending\n`,
    );
    return EXIT_FAILURE;
  }
  if (json) io.stdout(`${JSON.stringify({ id: record.id, outcome: attempt.outcome })}\n`);
  if (attempt.outcome.ok) {
    io.stdout(`replay ok: ${record.id}\n`);
    return EXIT_OK;
  }
  io.stderr(`replay failed: ${record.id}: ${attempt.outcome.error ?? 'unknown error'}\n`);
  return EXIT_FAILURE;
}

function reportDryRunSummary(io: ReplayRunIO, record: FailureRecord): void {
  io.stdout(`record:      ${record.id}\n`);
  io.stdout(`tool:        ${record.tool.name}\n`);
  io.stdout(`class:       ${record.failure.class} (attempts ${record.failure.attempts})\n`);
  io.stdout(`server:      ${record.server.command}\n`);
  io.stdout(`arguments:   ${JSON.stringify(record.tool.arguments)}\n`);
  io.stdout('dry-run:     no upstream tools/call will be made\n');
}

function reportDryRunGuards(deps: {
  io: ReplayRunIO;
  config: McprelayConfig;
  record: FailureRecord;
  remainingMarkers: string[];
  verdict: DedupVerdict;
}): void {
  if (deps.remainingMarkers.length > 0) {
    deps.io.stdout(`redacted:    requires --set for: ${deps.remainingMarkers.join(', ')}\n`);
  }
  if (deps.verdict.duplicate) {
    deps.io.stdout(
      `duplicate:   ${deps.verdict.previous?.key} succeeded at ${deps.verdict.previous?.executedAt} (${deps.verdict.matchedBy}); --force required\n`,
    );
  }
  if (deps.config.reliability.perTool[deps.record.tool.name]?.effects === 'read') {
    deps.io.stdout('hint:        effects: read — a read-only tool is rarely worth replaying\n');
  }
}
```

**Qué hace:** `reportOutcome` traduce el intento a salida + exit code (`unreachable` y fallo → `EXIT_FAILURE`; ok → `EXIT_OK`; con `--json`, además una línea JSON con el outcome). `reportDryRunSummary` imprime la ficha del registro. `reportDryRunGuards` añade los avisos: qué claves faltan, el duplicado con su fecha, y el **hint** de `effects: read` ("un tool de solo lectura rara vez merece un replay" — la honestidad de ADR-0005 en una línea).

**Por qué:** los exit codes son contrato de CI (`replay` en un pipeline debe poder fallar el job); el JSON es para máquinas. El hint de `effects: read` es la única mitigación al problema de los replays inútiles: la herramienta no puede saber si un read merece redrive, pero puede decirlo.

**Si no estuviera:** el usuario no tendría ni ficha ni avisos, y el replay no podría usarse en automatización.

---

## Bloque I — `runDryRun`: inspección con cero `tools/call`

```ts
/** Read-only inspection: tools/list only, zero `tools/call`. */
async function runDryRun(deps: {
  io: ReplayRunIO;
  config: McprelayConfig;
  record: FailureRecord;
  replayArguments: Record<string, unknown>;
  remainingMarkers: string[];
  verdict: DedupVerdict;
  json: boolean;
}): Promise<number> {
  const { io, record, replayArguments } = deps;
  reportDryRunSummary(io, record);
  reportDryRunGuards(deps);

  let upstream: { client: Client; link: UpstreamLink } | undefined;
  try {
    upstream = await connectStoredServer(record, deps.config);
    const tools = await listToolNames(upstream.client);
    if (!tools.includes(record.tool.name)) {
      io.stderr(`mcprelay: tool '${record.tool.name}' does not exist upstream; replay aborted\n`);
      return EXIT_FAILURE;
    }
    io.stdout(`tool check:  present (${tools.length} tools)\n`);
    io.stdout(`arguments:   ${JSON.stringify(replayArguments)}\n`);
    if (deps.json) {
      io.stdout(`${JSON.stringify({ id: record.id, dryRun: true, toolPresent: true })}\n`);
    }
    return EXIT_OK;
  } catch (error) {
    io.stderr(
      `mcprelay: could not reach the stored server: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_FAILURE;
  } finally {
    if (upstream !== undefined) await closeUpstream(upstream);
  }
}
```

**Qué hace:** imprime la ficha + guardas, conecta al servidor guardado, hace **solo** `tools/list` para comprobar que el tool aún existe, imprime los argumentos reparados (ya sin secretos — los `[REDACTED]` se ven literalmente) y devuelve código. Con `--json`, una línea con `dryRun: true`.

**Por qué:** el dry-run es la mitigación del riesgo de efectos (PRD §11): el usuario ve **exactamente** qué se enviará y contra qué tool, sin ejecutar nada. Conectar sí, ejecutar jamás — y si el tool desapareció del servidor, el replay se aborta aquí, no a mitad.

**Si no estuviera:** el primer contacto con un replay sería la ejecución real — el flujo que el PRD prohíbe como UX por defecto.

---

## Bloque J — `runReplayRecord`: el orquestador de un registro

```ts
/**
 * `mcprelay replay run <id>`: dry-run inspection, or redrive for side effects.
 * The body reads as the run sequence; each phase lives in a named helper above.
 */
export async function runReplayRecord(options: ReplayRunOptions, io: ReplayRunIO): Promise<number> {
  const config = loadReplayConfig(options, io);
  if (config === undefined) return EXIT_USAGE;

  const providers = openProviders(config, io);
  if (providers === undefined) return EXIT_FAILURE;

  try {
    let record: FailureRecord | undefined;
    try {
      record = await fetchRecord(providers.queue, options.id, io);
    } catch (error) {
      if (error instanceof RecordNotFoundError) io.stderr(`mcprelay: ${error.message}\n`);
      else io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    }
    if (record === undefined) return EXIT_FAILURE;

    const storedArguments = (record.tool.arguments ?? {}) as Record<string, unknown>;
    const key = extractIdempotencyKey({ arguments: storedArguments });
    const identity: CallIdentity = {
      ...(key === undefined ? {} : { key }),
      argumentsHash: record.tool.arguments_hash,
    };
    const { replayArguments, remainingMarkers } = resolveArguments(record, options.overrides);
    const verdict = await computeDedupVerdict(providers.queue, config, record, key);

    if (options.dryRun) {
      return await runDryRun({
        io,
        config,
        record,
        replayArguments,
        remainingMarkers,
        verdict,
        json: options.json,
      });
    }

    const refusal = guardRun({ remainingMarkers, verdict, force: options.force, io });
    if (refusal !== undefined) return refusal;

    if (!(await claimOrReport(providers.queue, record, io))) return EXIT_FAILURE;

    const attempt = await attemptReplay(config, record, replayArguments);
    try {
      await persistOutcome(providers, record, attempt, identity);
    } catch (error) {
      io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    }
    return reportOutcome(io, record, attempt, options.json);
  } finally {
    await providers.close();
  }
}
```

**Qué hace:** la secuencia completa como pasos con nombre: cargar config → abrir proveedores → buscar el registro → extraer clave/identidad → reparar argumentos → computar dedup → **si dry-run**, inspección y salir → **guarda** (¿refusal?) → **claim** → **intento** → **persistir** → **reportar**. `finally` cierra los proveedores pase lo que pase.

**Por qué:** el orden de esta secuencia es el contrato de seguridad del replay: nada se ejecuta antes de que las guardas hayan hablado, nada se persiste sin claim, y el cierre de providers vive en `finally` (con SQLite WAL, cerrar limpio importa). El manejo de `RecordNotFoundError` distingue "no existe" de "la cola falló": mensajes distintos, mismo exit code.

**Si no estuviera:** cada entry point (single y batch) repetiría esta coreografía y divergirían en guardas.

---

## Bloque K — El batch: mismo camino, N registros

```ts
interface BatchRecordResult {
  id: string;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
}

/** One record inside a batch: the same guards, claim, attempt, and persist as a single run. */
async function replayBatchRecord(
  providers: Providers,
  config: McprelayConfig,
  record: FailureRecord,
  options: ReplayRunOptions,
  io: ReplayRunIO,
): Promise<BatchRecordResult> {
  const storedArguments = (record.tool.arguments ?? {}) as Record<string, unknown>;
  const key = extractIdempotencyKey({ arguments: storedArguments });
  const identity: CallIdentity = {
    ...(key === undefined ? {} : { key }),
    argumentsHash: record.tool.arguments_hash,
  };
  const { replayArguments, remainingMarkers } = resolveArguments(record, options.overrides);
  const verdict = await computeDedupVerdict(providers.queue, config, record, key);

  if (options.dryRun) {
    const code = await runDryRun({
      io,
      config,
      record,
      replayArguments,
      remainingMarkers,
      verdict,
      json: false,
    });
    return code === EXIT_OK
      ? { id: record.id, status: 'ok' }
      : { id: record.id, status: 'failed', error: 'dry-run inspection failed' };
  }

  const refusal = guardRun({ remainingMarkers, verdict, force: options.force, io });
  if (refusal !== undefined) return { id: record.id, status: 'skipped', error: 'guard refused' };

  if (!(await claimOrReport(providers.queue, record, io))) {
    return { id: record.id, status: 'skipped', error: 'claimed by another replay' };
  }

  const attempt = await attemptReplay(config, record, replayArguments);
  await persistOutcome(providers, record, attempt, identity);
  if (attempt.kind === 'unreachable') {
    return { id: record.id, status: 'failed', error: attempt.message };
  }
  if (attempt.outcome.ok) return { id: record.id, status: 'ok' };
  return { id: record.id, status: 'failed', error: attempt.outcome.error ?? 'unknown error' };
}

/**
 * `mcprelay replay run --all`: sequentially redrives the pending records that
 * match the filter, reporting per-record outcomes and a summary.
 */
export async function runReplayBatch(options: ReplayRunOptions, io: ReplayRunIO): Promise<number> {
  const config = loadReplayConfig(options, io);
  if (config === undefined) return EXIT_USAGE;

  const providers = openProviders(config, io);
  if (providers === undefined) return EXIT_FAILURE;

  try {
    let records: FailureRecord[];
    try {
      records = await providers.queue.list({ ...options.filter, status: 'pending' });
    } catch (error) {
      io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    }

    const results: BatchRecordResult[] = [];
    for (const record of records) {
      const result = await replayBatchRecord(providers, config, record, options, io);
      results.push(result);
      if (!options.json) {
        if (result.status === 'ok') io.stdout(`replay ok: ${record.id}\n`);
        else if (result.status === 'failed') {
          io.stderr(`replay failed: ${record.id}: ${result.error ?? 'unknown error'}\n`);
        } else {
          io.stderr(`replay skipped: ${record.id}: ${result.error ?? 'skipped'}\n`);
        }
      }
    }

    const summary = {
      all: true,
      selected: records.length,
      ok: results.filter((result) => result.status === 'ok').length,
      failed: results.filter((result) => result.status === 'failed').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
    };
    if (options.json) {
      io.stdout(`${JSON.stringify({ ...summary, records: results })}\n`);
    } else {
      io.stdout(
        `replay --all: ${summary.selected} selected, ${summary.ok} ok, ${summary.failed} failed, ${summary.skipped} skipped\n`,
      );
    }
    return summary.failed > 0 || summary.skipped > 0 ? EXIT_FAILURE : EXIT_OK;
  } finally {
    await providers.close();
  }
}
```

**Qué hace:** `replayBatchRecord` repite **el mismo camino** que el single run (reparar → dedup → guardas → claim → intento → persistir) pero traduce cada desenlace a un `status` (`ok`/`failed`/`skipped`) para la tabla: "guard refused" y "claimed by another replay" son `skipped` (no es culpa del registro), y `unreachable`/outcome fallido son `failed`. `runReplayBatch` lista los pendientes que matchean el filtro, los procesa **secuencialmente**, imprime línea por línea (o JSON completo) y cierra con el resumen; el exit code falla si hubo algún `failed` **o algún `skipped`** — un batch que no pudo procesar todo no es verde (útil en CI).

**Por qué:** `skipped` cuenta para el exit code a propósito: en un pipeline, "había 3 para replays y 1 fue saltado por otro proceso" es una condición que quieres ver fallar, no un detalle. La secuencialidad es deliberada: el batch es para humanos y brokers, no para maximizar throughput; la concurrencia segura ya la garantiza el claim atómico entre procesos.

**Si no estuviera:** el batch tendría que duplicar (y mantener) toda la coreografía del single run.

---

## Glosario rápido

| Término | Significado |
|---|---|
| **redrive** | Re-ejecutar un registro del DLQ para que el efecto de lado ocurra; su resultado va al audit, no al agente (ADR-0005). |
| **`unreachable`** | No se pudo ni conectar al servidor: el registro queda `pending` (release), no cuenta como fallo del tool. |
| **`release`** | Devolver el claim sin resolver: el registro sigue pendiente para otro intento. |
| **`resolve`** | Cerrar el registro como `replayed` con la historia de intentos y el outcome. |
| **`[REDACTED]`** | Marcador de valor suprimido en la captura; bloquea el replay hasta suplirlo con `--set`. |
| **dedup** | La guarda anti-duplicado: clave o hash de argumentos ejecutados dentro de `dedup_window` (default 24 h). |
| **`--force`** | Ejecutar aunque el dedup diga duplicado (decisión explícita del humano). |
| **claim / lease** | Toma exclusiva del registro por 5 minutos; expira solo, así un replay muerto no bloquea. |
| **`effects: read`** | Hint por tool: `--dry-run` avisa de que un read rara vez merece replay. |
| **`redactDeep`** | Redacción del resultado **en la frontera**: lo que sale de `attemptReplay` ya no tiene secretos. |

---

## Siguiente parada sugerida

[`sqlite-queue.md`](sqlite-queue.md): el otro extremo del ciclo — dónde nacen los registros que este motor consume: la captura-antes-del-error, el `claim`/`resolve` atómicos y el índice de idempotencia en SQLite (y el espejo RabbitMQ del mismo contrato).

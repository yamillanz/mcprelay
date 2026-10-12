# Guía de estudio — `src/store/sqlite-store.ts`

> **Qué es este archivo:** una copia comentada del código real, bloque por bloque. Arriba el código (idéntico al fuente), debajo la explicación en español: **qué hace**, **por qué existe** y **qué pasaría si no estuviera**.
>
> El código y los identificadores se mantienen en inglés (convención del repo); la explicación va en español.
>
> **Fuente:** [`src/store/sqlite-store.ts`](../../src/store/sqlite-store.ts) — **espejo de** `cefe854`. Si el código cambia, esta guía debe actualizarse en el mismo change (es un espejo, no la fuente de verdad).
>
> **Contexto:** el store es el **substrato de historia del producto**: cada llamada interceptada deja un *call event* (paridad con la línea de log, FR-O1/M8), cada denegación/captura/replay deja una entrada de *audit* (el único sitio donde vive el outcome de un replay, ADR-0005), y `report` agrega los eventos por caller+tool (FR-O2/O3). Comparte archivo SQLite con el middleware y el CLI (NFR-9) y poda los eventos por retención al abrir. Es la implementación del puerto `Store` (PRD §6.2).

---

## Bloque A — El puerto `Store` y su vocabulario

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

import type { CallDecision } from '../observability/call-log.js';

export type { CallDecision };

/** Call history, metrics, and audit substrate (PRD §6.2). */
export interface Store {
  recordCall(event: CallEvent): Promise<void>;
  metrics(filter: MetricsFilter): Promise<StoreMetrics>;
  audit(entry: AuditEntry): Promise<void>;
}

/** One persisted call event per intercepted tools/call (mirrors the log line). */
export interface CallEvent {
  correlation_id: string;
  timestamp: string;
  caller: { type: 'stdio' | 'http'; identity: string };
  tool: string;
  decision: CallDecision;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
  attempt: number;
}

export interface MetricsFilter {
  since?: string;
  until?: string;
  tool?: string;
  caller?: string;
}

/** Per caller+tool aggregation row (FR-O2). */
export interface ToolMetrics {
  caller: string;
  tool: string;
  calls: number;
  errors: number;
  error_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  avg_request_bytes: number;
  avg_response_bytes: number;
}

export interface DecisionTotals {
  allowed: number;
  denied: number;
  failed: number;
  cancelled: number;
}

export interface StoreMetrics {
  tools: ToolMetrics[];
  decisions: DecisionTotals;
  replayed: number;
}

export interface AuditEntry {
  kind: string;
  correlationId?: string;
  failureId?: string;
  toolName?: string;
  detail?: unknown;
}

export interface AuditFilter {
  correlationId?: string;
  failureId?: string;
  limit?: number;
}

export interface StoredAuditEntry {
  id: string;
  at: string;
  kind: string;
  correlation_id: string | null;
  failure_id: string | null;
  tool_name: string | null;
  detail: unknown;
}
```

**Qué hace:** define el puerto mínimo del store (`recordCall`, `metrics`, `audit`) y todo su vocabulario: `CallEvent` (el espejo persistido de la línea de log — mismos campos: correlación, caller, decisión, latencia, bytes, intentos), `ToolMetrics` (una fila por caller+tool con errores, error rate, p50/p95 y medias), `StoreMetrics` (filas + totales por decisión + `replayed`) y el audit (`kind` libre, referencias opcionales a correlación/registro/tool, `detail` arbitrario).

**Por qué:** el `CallEvent` duplica deliberadamente la línea de log — es el contrato de paridad de M8 ("metrics match logs"): cualquier campo que el log tiene, el evento lo tiene. El audit es deliberadamente genérico (`kind` string, `detail` unknown): un solo sustrato para denegaciones (`denied`), capturas (`captured`) y replays (`replayed`) sin migraciones por cada kind nuevo.

**Si no estuviera:** `report` no tendría datos, el replay no tendría dónde escribir su outcome, y los tests de paridad log/métricas no tendrían contrato.

---

## Bloque B — Schema y constantes de retención

```ts
const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  correlation_id TEXT,
  failure_id TEXT,
  tool_name TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_correlation ON audit(correlation_id);
CREATE INDEX IF NOT EXISTS audit_failure ON audit(failure_id);
CREATE TABLE IF NOT EXISTS call_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  caller_type TEXT NOT NULL,
  caller_identity TEXT NOT NULL,
  tool TEXT NOT NULL,
  decision TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  request_bytes INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL,
  attempt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_events_at ON call_events(at);
CREATE INDEX IF NOT EXISTS call_events_tool ON call_events(tool);
CREATE INDEX IF NOT EXISTS call_events_caller ON call_events(caller_identity);
`;

const monotonicUlid = monotonicFactory();

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
```

**Qué hace:** dos tablas: `audit` (append-only, con índices por correlación y por registro) y `call_events` (una fila por llamada, con índices para los tres filtros de `report`: fecha, tool, caller). El generador `monotonicUlid` (fábrica monotónica de ULID) asigna ids ordenables por tiempo; la retención por defecto son 30 días.

**Por qué:** el ULID monotónico importa dos veces: `ORDER BY id DESC` de `listAudit` tiene que estabilizar entradas creadas en el mismo milisegundo (el bug de la DB con ULID no-monotónico está documentado en ADR-0004 — lo cazó CI en Node 20), y como PK evita coordinar contadores. Los índices están elegidos por los queries reales, no por estética.

**Si no estuviera:** ids no ordenables (audit en orden aleatorio dentro del mismo ms), y sin índices cada `report` sería un full scan.

---

## Bloque C — Filtros, percentiles y agregación

```ts
interface CallEventRow {
  at: string;
  caller_identity: string;
  tool: string;
  decision: string;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
}

function buildCallWhere(filter: MetricsFilter): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.since !== undefined) {
    conditions.push('at >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push('at <= ?');
    params.push(filter.until);
  }
  if (filter.tool !== undefined) {
    conditions.push('tool = ?');
    params.push(filter.tool);
  }
  if (filter.caller !== undefined) {
    conditions.push('caller_identity = ?');
    params.push(filter.caller);
  }
  return {
    clause: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

/** Nearest-rank percentile over ascending values (⌈p/100 · n⌉-th, no interpolation). */
function nearestRank(ascending: number[], percentile: number): number {
  if (ascending.length === 0) return 0;
  const rank = Math.ceil((percentile / 100) * ascending.length);
  return ascending[Math.min(Math.max(rank, 1), ascending.length) - 1] as number;
}

function toToolMetrics(group: CallEventRow[]): ToolMetrics {
  const latencies = group.map((row) => row.latency_ms).sort((a, b) => a - b);
  const errors = group.filter((row) => row.decision === 'failed').length;
  const average = (pick: (row: CallEventRow) => number): number =>
    Math.round(group.reduce((sum, row) => sum + pick(row), 0) / group.length);
  return {
    caller: group[0]?.caller_identity as string,
    tool: group[0]?.tool as string,
    calls: group.length,
    errors,
    error_rate: errors / group.length,
    latency_p50_ms: nearestRank(latencies, 50),
    latency_p95_ms: nearestRank(latencies, 95),
    avg_request_bytes: average((row) => row.request_bytes),
    avg_response_bytes: average((row) => row.response_bytes),
  };
}
```

**Qué hace:** `buildCallWhere` compone el WHERE del filter de métricas (mismo patrón que en la queue: parámetros ligados). `nearestRank` calcula el percentil por **rango más cercano** — el elemento ⌈p/100·n⌉-ésimo de la lista ordenada, sin interpolar. `toToolMetrics` convierte un grupo de filas en la fila de report: errores = solo `failed` (una denegación no es un error), error_rate, p50/p95 y medias redondeadas.

**Por qué:** nearest-rank es la definición honesta para datasets pequeños (es lo mismo que hace el `report` de M8 con los números de la demo: p50/p95 de 1–3 muestras); interpolar (tipo Prometheus) sugeriría precisión que no existe. `errors` solo cuenta `failed` — decisión documentada: denegados/cancelados se cuentan aparte en `decisions`, no inflan la tasa de error de un tool.

**Si no estuviera:** cada fila del report tendría que recalcular percentiles a mano, y "error" significaría lo que cada quien quisiera.

---

## Bloque D — Mapeo de audit, constructor y poda

```ts
interface AuditRow {
  id: string;
  at: string;
  kind: string;
  correlation_id: string | null;
  failure_id: string | null;
  tool_name: string | null;
  detail: string | null;
}

function toAuditEntry(row: AuditRow): StoredAuditEntry {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    correlation_id: row.correlation_id,
    failure_id: row.failure_id,
    tool_name: row.tool_name,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as unknown),
  };
}

/** SQLite-backed store; WAL + busy_timeout so the CLI can share the file. */
export class SqliteStore implements Store {
  private readonly db: Database.Database;
  private readonly path: string;
  private readonly retentionDays: number;

  constructor(options: { path: string; retentionDays?: number }) {
    this.path = options.path;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    // busy_timeout first: the WAL pragma needs a lock and must wait, not fail.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.pruneCallEvents();
  }

  /** Bounds call-event growth (NFR-9); `0` keeps everything. Audit is untouched. */
  private pruneCallEvents(): void {
    if (this.retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - this.retentionDays * MS_PER_DAY).toISOString();
    this.db.prepare('DELETE FROM call_events WHERE at < ?').run(cutoff);
  }
```

**Qué hace:** `toAuditEntry` des-serializa el detalle JSON. El constructor abre la DB con los mismos pragmas que la queue (`busy_timeout` **antes** que WAL — mismo bug evitado), aplica el schema y **poda al abrir**: `DELETE FROM call_events WHERE at < now − retentionDays`. `retentionDays: 0` desactiva la poda.

**Por qué:** podar **al abrir** (no en un cron ni por fila) es la decisión de M8: el trabajo se paga una vez por proceso, en los dos extremos que abren la DB (middleware y CLI), sin relojes de fondo. La poda **solo toca `call_events`**: el audit y el DLQ son historia durable — borrarlos jamás debe ser un efecto de la retención (comentario explícito en el código). El cutoff es una comparación ISO (los timestamps son ISO-8601 y comparan lexicográficamente).

**Si no estuviera:** `call_events` crecería sin límite en sesiones longevas (NFR-9) — o peor: alguien podaría el audit y perdería los outcomes de los replays.

---

## Bloque E — `recordCall`: la paridad con el log

```ts
  async recordCall(event: CallEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO call_events (
          id, at, correlation_id, caller_type, caller_identity, tool, decision,
          latency_ms, request_bytes, response_bytes, attempt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        monotonicUlid(),
        event.timestamp,
        event.correlation_id,
        event.caller.type,
        event.caller.identity,
        event.tool,
        event.decision,
        event.latency_ms,
        event.request_bytes,
        event.response_bytes,
        event.attempt,
      );
  }
```

**Qué hace:** inserta el evento con un ULID nuevo y los campos tal cual vienen del bridge (que los construyó desde la misma entrada de log).

**Por qué:** INSERT plano, sin upsert ni dedupe: cada llamada interceptada es una fila (los dry-runs no llegan aquí — `logCall` del bridge los corta antes, `enforced: false` no se persiste). El `id` lo genera el store, no el llamador: el contrato del puerto no carga con la responsabilidad del ULID.

**Si no estuviera:** `report` no tendría de dónde contar — y el gate de paridad M8 (`metrics match logs`) no existiría.

---

## Bloque F — `metrics`: la agregación del report

```ts
  async metrics(filter: MetricsFilter): Promise<StoreMetrics> {
    const { clause, params } = buildCallWhere(filter);
    const rows = this.db
      .prepare(`SELECT * FROM call_events ${clause} ORDER BY at ASC`)
      .all(...params) as CallEventRow[];

    const decisions: DecisionTotals = { allowed: 0, denied: 0, failed: 0, cancelled: 0 };
    const groups = new Map<string, CallEventRow[]>();
    for (const row of rows) {
      if (row.decision in decisions) decisions[row.decision as CallDecision] += 1;
      const key = `${row.caller_identity}\u0000${row.tool}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [row]);
      else group.push(row);
    }

    const tools = [...groups.values()]
      .map((group) => toToolMetrics(group))
      .sort(
        (a, b) =>
          b.calls - a.calls || a.caller.localeCompare(b.caller) || a.tool.localeCompare(b.tool),
      );

    const replayConditions = ["kind = 'replayed'"];
    const replayParams: unknown[] = [];
    if (filter.since !== undefined) {
      replayConditions.push('at >= ?');
      replayParams.push(filter.since);
    }
    if (filter.until !== undefined) {
      replayConditions.push('at <= ?');
      replayParams.push(filter.until);
    }
    const replayRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM audit WHERE ${replayConditions.join(' AND ')}`)
      .get(...replayParams) as { count: number };

    return { tools, decisions, replayed: replayRow.count };
  }
```

**Qué hace:** lee los eventos del rango, cuenta decisiones (`in` sobre las claves — un decision desconocido se ignora sin romper), agrupa por `caller\0tool` (el separador NUL evita colisiones entre un caller que contenga el separador "natural" y un tool), produce las filas ordenadas por volumen (calls desc, luego caller, luego tool — orden determinista para tests) y cuenta `replayed` en una consulta aparte **sobre el audit** (`kind = 'replayed'`), aplicando solo el rango temporal (los filtros tool/caller no aplican a replays: un replay no es "de" un caller).

**Por qué:** `replayed` viene del **audit**, no de los eventos: un replay no emite call event (no pasó por `tools/call` del cliente), solo deja su entrada de audit — contarlo desde ahí es la única fuente honesta (y así lo pidió M8: el total refleja replays reales). El orden del sort está fijado para que dos ejecuciones con los mismos datos impriman la misma tabla (tests y diffs).

**Si no estuviera:** el `report` no existiría; "¿qué pasó?" (UC4) seguiría siendo una pregunta sin respuesta.

---

## Bloque G — `audit`, `listAudit` y `close`

```ts
  async audit(entry: AuditEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit (id, at, kind, correlation_id, failure_id, tool_name, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        monotonicUlid(),
        new Date().toISOString(),
        entry.kind,
        entry.correlationId ?? null,
        entry.failureId ?? null,
        entry.toolName ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      );
  }

  /** Read side for tests and the replay CLI (not part of the port). */
  async listAudit(filter: AuditFilter = {}): Promise<StoredAuditEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.correlationId !== undefined) {
      conditions.push('correlation_id = ?');
      params.push(filter.correlationId);
    }
    if (filter.failureId !== undefined) {
      conditions.push('failure_id = ?');
      params.push(filter.failureId);
    }
    const clause = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = this.db
      .prepare(`SELECT * FROM audit ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as AuditRow[];
    return rows.map(toAuditEntry);
  }

  close(): void {
    this.db.close();
  }
}
```

**Qué hace:** `audit` es un INSERT append-only (ids monotónicos, `at` del momento de escribir, opcionales a NULL, `detail` a JSON). `listAudit` es la lectura (filtros por correlación o registro, límite acotado, más nuevo primero) — **fuera del puerto**: existe para los tests y el CLI de replay, no para el producto. `close` cierra.

**Por qué:** el audit no tiene update ni delete a propósito: es la historia que sostiene la honestidad del replay ("el audit es el único sitio donde vive el outcome") — reescribirlo sería reescribir la historia. Separar `listAudit` del puerto `Store` mantiene el contrato mínimo: el middleware solo escribe audit; leer es de herramientas.

**Si no estuviera:** los replays no dejarían rastro (el outcome se perdería al no existir destinatario), y no habría forma de auditar denegaciones por correlación.

---

## Glosario rápido

| Término | Significado |
|---|---|
| **`Store`** | El puerto del sustrato: `recordCall`, `metrics`, `audit`. Mínimo a propósito. |
| **call event** | Una fila por llamada interceptada; espejo persistido de la línea de log FR-O1 (paridad M8). |
| **audit** | Historia append-only: `denied`, `captured`, `replayed`… con `detail` libre. Único hogar del outcome de un replay. |
| **nearest-rank** | Percentil = elemento ⌈p/100·n⌉-ésimo ordenado, sin interpolar. |
| **`errors`** | Solo decisiones `failed` (denegados y cancelados se cuentan en `decisions`, no aquí). |
| **`replayed`** | Conteo desde el audit (`kind='replayed'`) en el rango, no desde call events. |
| **ULID monotónico** | Id ordenable por tiempo, único dentro del mismo ms; PK de ambas tablas. |
| **retención** | `store.retention_days` (30 default, `0` desactiva): poda `call_events` **al abrir**; el audit nunca se poda. |
| **`\u0000`** | Separador NUL de la clave de grupo `caller␀tool`: imposible de colisionar con valores reales. |

---

## Siguiente parada sugerida

Fin del recorrido de primera ola — vuelve al [índice](README.md) para el catálogo completo y la siguiente ola pendiente (`policy`, `config`, `cli/run`, `identity`, `replay-cli`/`guards`, `rabbitmq-queue`).

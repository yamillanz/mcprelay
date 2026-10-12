# Guía de estudio — `src/queue/sqlite-queue.ts`

> **Qué es este archivo:** una copia comentada del código real, bloque por bloque. Arriba el código (idéntico al fuente), debajo la explicación en español: **qué hace**, **por qué existe** y **qué pasaría si no estuviera**.
>
> El código y los identificadores se mantienen en inglés (convención del repo); la explicación va en español.
>
> **Fuente:** [`src/queue/sqlite-queue.ts`](../../src/queue/sqlite-queue.ts) — **espejo de** `cefe854`. Si el código cambia, esta guía debe actualizarse en el mismo change (es un espejo, no la fuente de verdad).
>
> **Contexto:** este archivo es el **adaptador de referencia del puerto `QueueProvider`** (y del `IdempotencyIndex`): la implementación que hace durable el DLQ con cero infraestructura. El middleware (bridge) llama `enqueue` **antes** de que el cliente vea el error; el `replay` CLI llama `list`/`get`/`claim`/`resolve` desde **otro proceso**, compartiendo el mismo archivo SQLite (NFR-9) — por eso todo lo delicado aquí es la concurrencia entre procesos: `claim` y `resolve` son atómicos por construcción `UPDATE … WHERE` y WAL + busy_timeout sostienen el acceso compartido. El espejo RabbitMQ ([`rabbitmq-queue.ts`](../../src/queue/rabbitmq-queue.ts)) implementa el mismo contrato con el broker como almacén inmutable y **este mismo SQLite** como índice local (ADR-0008). Decisiones en [`docs/adr/0004-dlq-persistence.md`](../adr/0004-dlq-persistence.md) y [`docs/adr/0008-rabbitmq-adapter.md`](../adr/0008-rabbitmq-adapter.md).

---

## Bloque A — Imports, límites y el schema

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type {
  ExecutionEntry,
  ExecutionRecord,
  FailureFilter,
  FailureRecord,
  HealthStatus,
  ReplayOutcome,
  ServerTransport,
} from './failure-record.js';
import {
  AlreadyClaimedError,
  AlreadyResolvedError,
  RecordNotFoundError,
  type IdempotencyIndex,
  type QueueProvider,
} from './port.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS failures (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  caller_type TEXT NOT NULL,
  caller_identity TEXT NOT NULL,
  server_name TEXT NOT NULL,
  server_command TEXT NOT NULL,
  server_transport TEXT NOT NULL DEFAULT 'stdio',
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  arguments TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  failure_message TEXT NOT NULL,
  failure_attempts INTEGER NOT NULL,
  replay_status TEXT NOT NULL DEFAULT 'pending',
  replay_attempts TEXT NOT NULL DEFAULT '[]',
  last_outcome TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS failures_tool ON failures(tool_name);
CREATE INDEX IF NOT EXISTS failures_correlation ON failures(correlation_id);
CREATE INDEX IF NOT EXISTS failures_captured_at ON failures(captured_at);
CREATE INDEX IF NOT EXISTS failures_replay_status ON failures(replay_status);
CREATE TABLE IF NOT EXISTS executions (
  key TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_hash ON executions(arguments_hash);
`;
```

**Qué hace:** define los límites de paginación (50 por defecto, 500 máximo) y el schema en dos tablas: `failures` (el registro del DLQ: identidad, servidor, tool, argumentos —hash y redactados—, fallo y estado de replay) y `executions` (el índice de idempotencia). Los índices cubren exactamente los filtros de `replay list` (tool, correlación, fecha, estado) y las dos búsquedas del dedup (clave y hash).

**Por qué:** es un espejo SQL del `FailureRecord` (Appendix A del PRD) con los campos JSON serializados como TEXT (`arguments`, `replay_attempts`, `last_outcome`): SQLite guarda, la forma la pone la capa TS. `server_transport` con default `'stdio'` es la compatibilidad con registros pre-M6. `key TEXT PRIMARY KEY` en `executions` es lo que hace el upsert de dedup trivial.

**Si no estuviera:** no habría dónde capturar, el replay no tendría qué listar, y el dedup no tendría memoria.

---

## Bloque B — Filas y `buildWhere`

```ts
interface FailureRow {
  id: string;
  correlation_id: string;
  captured_at: string;
  caller_type: string;
  caller_identity: string;
  server_name: string;
  server_command: string;
  server_transport: string;
  tool_name: string;
  arguments_hash: string;
  arguments: string;
  failure_class: string;
  failure_message: string;
  failure_attempts: number;
  replay_status: string;
  replay_attempts: string;
  last_outcome: string | null;
}

function buildWhere(filter: FailureFilter): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) {
    conditions.push('replay_status = ?');
    params.push(filter.status);
  }
  if (filter.tool !== undefined) {
    conditions.push('tool_name = ?');
    params.push(filter.tool);
  }
  if (filter.correlationId !== undefined) {
    conditions.push('correlation_id = ?');
    params.push(filter.correlationId);
  }
  if (filter.since !== undefined) {
    conditions.push('captured_at >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push('captured_at <= ?');
    params.push(filter.until);
  }
  return {
    clause: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`,
    params,
  };
}
```

**Qué hace:** `FailureRow` es la forma cruda de una fila (todo TEXT). `buildWhere` compone el `WHERE` a partir del filtro del puerto, con parámetros ligados (`?`) — nunca interpolación de valores.

**Por qué:** `buildWhere` lo comparten `list` y `purge`: un solo lugar donde se define qué significa filtrar, y por construcción sin SQL injection (los valores van como parámetros). Los filtros opcionales son `!== undefined` (no truthiness): un filtro con cadena vacía sigue siendo un filtro.

**Si no estuviera:** cada método repetiría su composición de WHERE, y `purge` y `list` podrían divergir en lo que consideran "el mismo filtro".

---

## Bloque C — Migración in-place y mapeo de filas

```ts
/** Adds a column when an older database predates it (in-place migration). */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function toExecutionRecord(row: {
  key: string;
  tool_name: string;
  arguments_hash: string;
  executed_at: string;
  source: string;
}): ExecutionRecord {
  return {
    key: row.key,
    toolName: row.tool_name,
    argumentsHash: row.arguments_hash,
    executedAt: row.executed_at,
    source: row.source as ExecutionRecord['source'],
  };
}

function toRecord(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    correlation_id: row.correlation_id,
    captured_at: row.captured_at,
    caller: { type: row.caller_type as 'stdio' | 'http', identity: row.caller_identity },
    server: {
      name: row.server_name,
      command: row.server_command,
      transport: row.server_transport as ServerTransport,
    },
    tool: {
      name: row.tool_name,
      arguments_hash: row.arguments_hash,
      arguments: JSON.parse(row.arguments) as unknown,
    },
    failure: {
      class: row.failure_class as FailureRecord['failure']['class'],
      message: row.failure_message,
      attempts: row.failure_attempts,
    },
    replay: {
      status: row.replay_status as FailureRecord['replay']['status'],
      attempts: JSON.parse(row.replay_attempts) as unknown[],
      last_outcome: row.last_outcome === null ? null : (JSON.parse(row.last_outcome) as unknown),
    },
  };
}
```

**Qué hace:** `ensureColumn` es la **migración in-place**: mira `PRAGMA table_info` y añade la columna solo si falta (así las DBs de versiones anteriores se actualizan al abrir, sin herramienta de migración). `toRecord`/`toExecutionRecord` reconstruyen los tipos del puerto desde las filas (des-serializando los JSON y casteando los enums cerrados).

**Por qué:** `ensureColumn` es lo que permitió añadir `claimed_at`/`claim_expires_at` (claims de batch replay, M7) y `server_transport` (HTTP, M6) a bases existentes sin romper a nadie: abrir la DB es migrar la DB. Los mappers dejan el cast de cada enum en un único sitio auditable.

**Si no estuviera:** cada actualización de schema exigiría borrar el DLQ o un script de migración aparte; y cada consulta repetiría el mapeo.

---

## Bloque D — El constructor: abrir y preparar

```ts
/** Durable DLQ backed by SQLite: WAL + busy_timeout, shared with the replay CLI. */
export class SqliteQueueProvider implements QueueProvider, IdempotencyIndex {
  private readonly db: Database.Database;
  private readonly path: string;

  constructor(options: { path: string }) {
    this.path = options.path;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    // busy_timeout first: the WAL pragma needs a lock and must wait, not fail.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    ensureColumn(this.db, 'failures', 'claimed_at', 'claimed_at TEXT');
    ensureColumn(this.db, 'failures', 'claim_expires_at', 'claim_expires_at TEXT');
    ensureColumn(
      this.db,
      'failures',
      'server_transport',
      "server_transport TEXT NOT NULL DEFAULT 'stdio'",
    );
  }
```

**Qué hace:** crea el directorio si falta, abre el archivo y fija los pragmas: `busy_timeout` **antes** que WAL, journal WAL, synchronous NORMAL, FK on. Después aplica el schema (idempotente) y completa las migraciones in-place.

**Por qué:** el orden `busy_timeout` → WAL está comentado en el código porque es un bug real esperando: cambiar a WAL toma un lock exclusivo, y con el default de busy_timeout cualquier escritura concurrente (el CLI de replay, otra sesión del middleware) fallaría con `SQLITE_BUSY` en vez de esperar. WAL es lo que permite leer mientras se escribe — la convivencia middleware/CLI del NFR-9.

**Si no estuviera:** dos procesos compartiendo el DLQ se pisarían con `SQLITE_BUSY` intermitentes y difíciles de reproducir.

---

## Bloque E — Capturar y leer: `enqueue`, `list`, `get`

```ts
  async enqueue(record: FailureRecord): Promise<string> {
    this.db
      .prepare(
        `INSERT INTO failures (
          id, correlation_id, captured_at, caller_type, caller_identity,
          server_name, server_command, server_transport, tool_name, arguments_hash, arguments,
          failure_class, failure_message, failure_attempts,
          replay_status, replay_attempts, last_outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.correlation_id,
        record.captured_at,
        record.caller.type,
        record.caller.identity,
        record.server.name,
        record.server.command,
        record.server.transport,
        record.tool.name,
        record.tool.arguments_hash,
        JSON.stringify(record.tool.arguments ?? null),
        record.failure.class,
        record.failure.message,
        record.failure.attempts,
        record.replay.status,
        JSON.stringify(record.replay.attempts),
        record.replay.last_outcome === null ? null : JSON.stringify(record.replay.last_outcome),
      );
    return record.id;
  }

  async list(filter: FailureFilter = {}): Promise<FailureRecord[]> {
    const { clause, params } = buildWhere(filter);
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const rows = this.db
      .prepare(`SELECT * FROM failures ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as FailureRow[];
    return rows.map(toRecord);
  }

  async get(id: string): Promise<FailureRecord | null> {
    const row = this.db.prepare('SELECT * FROM failures WHERE id = ?').get(id) as
      FailureRow | undefined;
    return row === undefined ? null : toRecord(row);
  }
```

**Qué hace:** `enqueue` inserta el registro completo (el `id` es el ULID que viene del bridge — el orden `ORDER BY id DESC` depende de que los ULIDs sean ordenables, ADR-0004). `list` aplica filtro + límite acotado (nunca más de 500) y ordena por `id DESC` (lo más nuevo primero). `get` es la lectura por id.

**Por qué:** `enqueue` es sincrónico por dentro (`better-sqlite3`) — el `await` del bridge espera el INSERT real, lo que da la garantía "capturado **antes** de que el cliente vea el error" (FR-R3/NFR-5). El clamp del límite es defensivo: un `--limit 1000000` de CLI no debe materializar la tabla entera.

**Si no estuviera:** el DLQ no tendría captura ni lectura, y `replay list/get` no existirían.

---

## Bloque F — `resolve`: cerrar con guardia de estado

```ts
  async resolve(id: string, outcome: ReplayOutcome): Promise<void> {
    const info = this.db
      .prepare(
        `UPDATE failures
         SET replay_status = ?, replay_attempts = ?, last_outcome = ?, resolved_at = ?
         WHERE id = ? AND replay_status = 'pending'`,
      )
      .run(
        outcome.status,
        JSON.stringify(outcome.attempts ?? []),
        outcome.lastOutcome === undefined ? null : JSON.stringify(outcome.lastOutcome),
        new Date().toISOString(),
        id,
      );
    if (info.changes === 0) {
      const exists = this.db.prepare('SELECT 1 FROM failures WHERE id = ?').get(id);
      if (exists === undefined) throw new RecordNotFoundError(id);
      throw new AlreadyResolvedError(id);
    }
  }
```

**Qué hace:** el resolve es **un solo UPDATE** con la guardia `replay_status = 'pending'` en el WHERE: cero filas afectadas significa "no se pudo resolver" — y entonces desambigua *por qué*: ¿no existe (→ `RecordNotFoundError`) o ya estaba resuelto (→ `AlreadyResolvedError`)?

**Por qué:** la atomicidad no viene de un lock de aplicación sino de la condición del propio UPDATE: entre el check y el update no hay ventana (es una sentencia). Eso es lo que hace concurrent-safe a `resolve` entre procesos (el `replay --all` de dos terminales). Los errores tipados son contrato del puerto: el CLI los traduce a mensajes precisos.

**Si no estuviera:** dos replays podrían resolver el mismo registro (doble historia) o el CLI no podría distinguir "no existe" de "ya estaba hecho".

---

## Bloque G — `claim` con lease y `release`

```ts
  async claim(id: string, leaseMs: number): Promise<void> {
    const now = new Date();
    const info = this.db
      .prepare(
        `UPDATE failures
         SET claimed_at = ?, claim_expires_at = ?
         WHERE id = ? AND replay_status = 'pending'
           AND (claim_expires_at IS NULL OR claim_expires_at < ?)`,
      )
      .run(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        id,
        now.toISOString(),
      );
    if (info.changes === 0) {
      const row = this.db.prepare('SELECT replay_status FROM failures WHERE id = ?').get(id) as
        { replay_status: string } | undefined;
      if (row === undefined) throw new RecordNotFoundError(id);
      if (row.replay_status !== 'pending') throw new AlreadyResolvedError(id);
      throw new AlreadyClaimedError(id);
    }
  }

  async release(id: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE failures SET claimed_at = NULL, claim_expires_at = NULL
         WHERE id = ? AND replay_status = 'pending'`,
      )
      .run(id);
  }
```

**Qué hace:** `claim` toma el registro con **lease**: el UPDATE solo afecta si está `pending` **y** (nunca reclamado **o** su claim expiró) — mismo patrón atómico que `resolve`, con desambiguación tipada (`RecordNotFoundError` / `AlreadyResolvedError` / `AlreadyClaimedError`). `release` devuelve el claim a NULL (el registro sigue `pending`).

**Por qué:** el lease (5 minutos, `CLAIM_LEASE_MS` del motor de replay) es la red de seguridad del claim: si el proceso que reclamó muere a mitad, el `claim_expires_at` vence y otro replay puede tomarlo — sin intervención manual. `release` es la contraparte explícita del camino `unreachable` (no pude conectarme: te devuelvo el registro tal como estaba).

**Si no estuviera:** dos batches concurrentes ejecutarían el mismo registro (efecto duplicado), o un crash dejaría el registro bloqueado para siempre.

---

## Bloque H — El índice de idempotencia

```ts
  async recordExecution(entry: ExecutionEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO executions (key, tool_name, arguments_hash, executed_at, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           tool_name = excluded.tool_name,
           arguments_hash = excluded.arguments_hash,
           executed_at = excluded.executed_at,
           source = excluded.source`,
      )
      .run(entry.key, entry.toolName, entry.argumentsHash, entry.executedAt, entry.source);
  }

  async lastExecution(key: string): Promise<ExecutionRecord | null> {
    const row = this.db.prepare('SELECT * FROM executions WHERE key = ?').get(key) as
      | {
          key: string;
          tool_name: string;
          arguments_hash: string;
          executed_at: string;
          source: string;
        }
      | undefined;
    return row === undefined ? null : toExecutionRecord(row);
  }

  async lastExecutionByHash(argumentsHash: string): Promise<ExecutionRecord | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM executions WHERE arguments_hash = ? ORDER BY executed_at DESC LIMIT 1',
      )
      .get(argumentsHash) as
      | {
          key: string;
          tool_name: string;
          arguments_hash: string;
          executed_at: string;
          source: string;
        }
      | undefined;
    return row === undefined ? null : toExecutionRecord(row);
  }
```

**Qué hace:** `recordExecution` es un **upsert por clave** (`ON CONFLICT(key) DO UPDATE`): la última ejecución de una clave gana. `lastExecution` lee por clave; `lastExecutionByHash` es la búsqueda del dedup **sin clave**: la última ejecución con el mismo hash de argumentos (índice `executions_hash` + `ORDER BY executed_at DESC LIMIT 1`).

**Por qué:** el upsert es la decisión correcta porque el dedup pregunta "¿cuándo fue la **última** ejecución de esta clave?" — historia completa por clave no aporta y crecería sin límite. La búsqueda por hash cubre a los clientes que no mandan idempotency key: mismo hash ≈ misma llamada (heurística declarada en ADR-0005). `source` (`live`/`replay`) queda en el registro para auditoría.

**Si no estuviera:** el guard anti-duplicado del replay no tendría dónde mirar, y la demo de dedup no existiría.

---

## Bloque I — `purge`, `health` y `close`

```ts
  async purge(filter: FailureFilter = {}): Promise<number> {
    const { clause, params } = buildWhere(filter);
    const info = this.db.prepare(`DELETE FROM failures ${clause}`).run(...params);
    return info.changes;
  }

  async health(): Promise<HealthStatus> {
    try {
      this.db.prepare('SELECT 1').get();
      return { ok: true, provider: 'sqlite', path: this.path };
    } catch {
      return { ok: false, provider: 'sqlite', path: this.path };
    }
  }

  close(): void {
    this.db.close();
  }
}
```

**Qué hace:** `purge` borra con el mismo `buildWhere` que `list` (purgar lo que listarías) y devuelve cuántas filas borró. `health` hace un `SELECT 1` y reporta ok/provider/path — con signatura para rabbitmq (`provider: 'rabbitmq'`) en el otro adaptador. `close` cierra la conexión (el bridge lo llama al apagar la sesión: con WAL, cerrar limpio deja los archivos consistentes entre procesos).

**Por qué:** `purge` sin duplicar el WHERE es lo que hace predecible "borra lo que este filtro liste". `health` es el contrato mínimo de observabilidad del puerto: los tests de contrato corren contra ambos adaptadores.

**Si no estuviera:** no habría limpieza del DLQ ni diagnóstico de conectividad del backend.

---

## Glosario rápido

| Término | Significado |
|---|---|
| **`QueueProvider`** | El puerto de la cola: `enqueue`/`list`/`get`/`resolve`/`claim`/`release`/`purge`/`health`/`close`. |
| **`IdempotencyIndex`** | El puerto hermano: `recordExecution`/`lastExecution`/`lastExecutionByHash`. |
| **WAL** | Journal mode que permite lecturas concurrentes con una escritura (middleware + CLI). |
| **`busy_timeout`** | Espera máxima por un lock antes de rendirse; puesto **antes** que WAL a propósito. |
| **claim / lease** | Toma exclusiva temporal (`claim_expires_at`); expira sola para no bloquear tras un crash. |
| **`UPDATE … WHERE` atómico** | La atomicidad del resolve/claim: una sola sentencia, sin ventana entre check y update. |
| **`ensureColumn`** | Migración in-place: añade la columna si falta al abrir la DB. |
| **upsert (`ON CONFLICT`)** | La última ejecución de una clave reemplaza a la anterior en `executions`. |
| **ULID** | El `id` ordenable por tiempo; `ORDER BY id DESC` = más reciente primero. |

---

## Siguiente parada sugerida

[`retry-pipeline.md`](retry-pipeline.md): la decisión que decide qué llega a este DLQ — la taxonomía D4 y el bucle de reintentos con backoff. Capturar está resuelto; la pregunta interesante es *cuándo* capturar.

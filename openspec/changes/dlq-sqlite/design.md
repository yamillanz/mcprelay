## Context

M2 ends with a classified failure and a log line — the call itself is lost. M3 makes the DLQ real (demo beat 3): capture is durable and happens before the client sees the error, secrets never persist, the record survives restart, and `replay list`/`inspect` expose the queue. This is also where the two v1 extension ports (`QueueProvider`, `Store`) get their SQLite adapters, and where `validate` completes the configuration surface.

Constraints from the PRD: `FailureRecord` shape (Appendix A), hash over **raw** args with redacted persistence (NFR-4), enqueue-before-error durability (NFR-5), SQLite files shared safely between the middleware and the `replay` CLI (NFR-9), Node ≥ 20 (NFR-6), OSS-only dependencies (P1/P5).

## Goals / Non-Goals

**Goals**

- A failed call is never lost: durable, redacted capture before the error, surviving restart.
- The `QueueProvider` and `Store` ports exist with SQLite adapters; atomic `resolve` is proven.
- `replay list`/`inspect` and `validate` work from the CLI.
- Config gains `queue`, `store`, `redaction`, and `capture_tool_errors` with safe defaults.
- ADR-0004, README, and the living diagram reflect the new layer.

**Non-Goals**

- Replay execution (`--dry-run`/`run`), idempotency dedup (M4), RabbitMQ (M7), metrics/report and retention (M8), policy (M5), HTTP (M6).
- A general plugin system: only the two ports, exactly as capped by P4.
- Encrypting the database at rest (redaction only, per NFR-4).

## Decisions

### D1 — Dependencies: `better-sqlite3@^12` and `ulid@^3`

`better-sqlite3@12.11.1` (MIT) supports Node `20.x || 22.x || …` — the only mature synchronous SQLite binding that keeps the Node 20 floor. Rejected: `node:sqlite` (built-in but requires Node ≥ 22.5 and is still experimental; adopting it would silently drop the PRD's Node ≥ 20 support), `sqlite3` (BSD, async callback API, more moving parts for a store we want synchronous and small), `sql.js` (WASM, no real WAL/durability story). `ulid@3.0.2` (MIT, 69 kB) generates the Appendix A id; rejected hand-rolling Crockford base32 for correctness risk. Both licenses are permissive (P1) and justified in ADR-0004.

### D2 — Module layout (same-file helpers, per the readability rule)

```
src/queue/failure-record.ts  — FailureRecord types + class mapping from D4
src/queue/sqlite-queue.ts    — QueueProvider port + SQLite adapter
src/store/sqlite-store.ts    — Store port + SQLite adapter (audit path)
src/redaction/redact.ts      — patterns, redactValue, canonical hash
src/replay/replay-cli.ts     — replay list / inspect command bodies
src/cli/run.ts               — dispatch for replay/validate + exit codes
src/proxy/bridge.ts          — capture-before-error integration
src/config/config.ts         — queue/store/redaction sections + capture_tool_errors
```

Ports live with their default adapter; core logic never imports `better-sqlite3` (adding RabbitMQ later must not touch the bridge).

### D3 — `FailureRecord` and class mapping

Fields exactly as Appendix A: `id` (ULID), `correlation_id`, `captured_at` (ISO-8601), `caller {type: 'stdio', identity: 'local'}`, `server {name, command}`, `tool {name, arguments_hash, arguments}`, `failure {class, message, attempts}`, `replay {status: 'pending', attempts: [], last_outcome: null}`.

D4 → record class mapping: `transport_pre_execution` and `transport_post_execution` → `transport`; `timeout` → `timeout`; `upstream_error` → `upstream_error`; `non_retryable` → `non_retryable`; `tool_error` → `tool_error` (opt-in capture only). `ok`, `input_required`, and `cancelled` are never captured.

### D4 — Redaction and hashing

- `redactValue(value, patterns)`: recursive walk over objects/arrays; a key matching any pattern (case-insensitive substring) has its value replaced with `'[REDACTED]'`. Arrays keep their shape; depth is bounded (guard against cycles with a seen-set).
- Message masking: failure messages are free text, so a regex masks `(?i)(api[_-]?key|token|password|authorization|secret|credential)\s*[:=]\s*\S+` → `$1=[REDACTED]`; best-effort by design (documented).
- `arguments_hash`: sha256 over a **canonical** JSON serialization of the raw arguments (object keys sorted recursively) so equal arguments hash equally regardless of key order; computed before redaction and stored as hex.

### D5 — SQLite schema and pragmas

```sql
CREATE TABLE IF NOT EXISTS failures (
  id TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, captured_at TEXT NOT NULL,
  caller_type TEXT NOT NULL, caller_identity TEXT NOT NULL,
  server_name TEXT NOT NULL, server_command TEXT NOT NULL,
  tool_name TEXT NOT NULL, arguments_hash TEXT NOT NULL, arguments TEXT NOT NULL,
  failure_class TEXT NOT NULL, failure_message TEXT NOT NULL, failure_attempts INTEGER NOT NULL,
  replay_status TEXT NOT NULL DEFAULT 'pending', replay_attempts TEXT NOT NULL DEFAULT '[]',
  last_outcome TEXT, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS failures_tool ON failures(tool_name);
CREATE INDEX IF NOT EXISTS failures_correlation ON failures(correlation_id);
CREATE INDEX IF NOT EXISTS failures_captured_at ON failures(captured_at);
CREATE INDEX IF NOT EXISTS failures_replay_status ON failures(replay_status);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL,
  correlation_id TEXT, failure_id TEXT, tool_name TEXT, detail TEXT
);
```

Pragmas on open: `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON`. WAL + busy_timeout satisfy NFR-9 (middleware and CLI share files); NORMAL keeps committed records across process crashes (the NFR-5 guarantee) while avoiding a full fsync per capture.

Atomic resolve: `UPDATE failures SET replay_status = ?, last_outcome = ?, resolved_at = ? WHERE id = ? AND replay_status = 'pending'` — `changes === 1` wins; otherwise throw `AlreadyResolvedError`. This is the guarantee M4's concurrent replay relies on.

Filters: `status`, `tool`, `correlationId`, `since`/`until`, `limit` (default 50, max 500). `purge(filter)` runs `DELETE … RETURNING`-equivalent (count via `changes`).

### D6 — Capture ordering in the bridge

In `interceptToolCall`, after the retry loop fails (or an opted-in `tool_error` result arrives):

1. Build the record (raw args captured before redaction; class mapped from the classification).
2. `await queue.enqueue(record)` — synchronous SQLite write, WAL-committed.
3. `await store.audit({kind: 'captured', correlation_id, failure_id: record.id, tool_name})`.
4. Only then throw/return so the SDK sends the error response.

If enqueue or audit throws (e.g., disk full), the error is still returned to the client, and the failure is logged loudly as `capture_failed` — the client must never hang because the store is down; this trade-off is recorded in ADR-0004.

Providers are opened lazily on first capture (zero-config creates no files until a failure happens) and cached for the session; `replay`/`validate` open their own connections.

### D7 — Port interfaces (exact)

```ts
interface QueueProvider {
  enqueue(rec: FailureRecord): Promise<string>;
  list(f?: FailureFilter): Promise<FailureRecord[]>;
  get(id: string): Promise<FailureRecord | null>;
  resolve(id: string, outcome: ReplayOutcome): Promise<void>; // atomic
  purge(f: FailureFilter): Promise<number>;
  health(): Promise<HealthStatus>;
}

interface Store {
  recordCall(ev: CallEvent): Promise<void>;   // implemented with metrics (M8)
  metrics(f: MetricsFilter): Promise<ToolMetrics[]>; // M8
  audit(entry: AuditEntry): Promise<void>;    // this milestone
}
```

The bridge depends on the port types only; `createQueueProvider(config)` / `createStore(config)` are the only places that know about SQLite.

### D8 — Config resolution

New sections merge into the M2 loader (`defaults ← file ← CLI flags`), with strict key checking inside known sections and the same warning for unknown top-level sections. Paths are resolved relative to the process cwd; parent directories are created on first write (`mkdirSync(recursive)`). `reliability.per_tool.<tool>.capture_tool_errors` is a boolean (default false) and participates in `resolveToolPolicy`.

### D9 — CLI: replay and validate

- `mcprelay replay list [--status …] [--tool …] [--correlation-id …] [--since …] [--until …] [--limit n] [--json]`
- `mcprelay replay inspect <id> [--json]`
- `mcprelay validate [--config <path>]` — loads the config, prints `config ok: <path>` (or defaults), exits 0; on error prints the ConfigError message and exits 2.
- Exit codes extended and documented in `--help`: `0` ok, `1` command ran but failed (record not found, database error), `2` usage/config, `3` upstream failure. `replay` never starts an upstream process.

### D10 — Test strategy (rule 11)

- **Unit, tight loops:** redaction (nested, custom patterns, arrays, cycles), canonical hash stability, ULID ordering/uniqueness, D4→record class mapping, filter building.
- **Adapter contract tests:** enqueue/list/get/filters, atomic resolve (two connections), purge, health, reopen durability, pragmas (`journal_mode=wal`, `busy_timeout`).
- **Integration (hermetic):** exhausted retries → record + audit written; kill-after-error durability (raw client, SIGKILL the middleware after the error, then `replay list` from a fresh process); redacted arguments and raw hash; `capture_tool_errors` opt-in; cancelled calls not captured; config error paths; `validate` valid/invalid.
- **Real-server gate (rule 10):** filesystem server + a forced failure (nonexistent tool? no — use the hermetic flaky for capture; real server run proves the success path and the CLI `replay list` against a real session).

### D11 — Docs, ADR, diagram, npm refresh

ADR-0004 records the SQLite adapter choice, schema, ULID, redaction policy, and the capture-failure trade-off. The architecture diagram gains the DLQ/Store nodes and the capture path. The npm page README refresh (stale since M2) ships with this milestone's publish, after the code lands.

## Risks / Trade-offs

- **Native dependency (`better-sqlite3`)** adds install weight and prebuilt-binary dependence → pinned major, license MIT, and CI on both Node lines exercises it; `node:sqlite` remains the future path once Node 20 support can be dropped (recorded in ADR-0004).
- **Capture can fail (disk full, permissions)** → the client still gets its error and the failure is logged as `capture_failed`; never block the session (documented).
- **Free-text message redaction is best-effort** → key-based redaction is exact for structured payloads; message masking is a documented heuristic.
- **Redaction misses a secret under an unlisted key** → defaults cover common names; patterns are configurable; `arguments_hash` stays raw for dedup, which is intentional.
- **SQLite file growth** → retention lands with M8 (PRD NFR-9); until then `replay purge` is the manual lever.

## Open Questions

- Whether `replay list` should default to pending-only or all statuses (proposed: all, with `--status` to narrow) — settle during apply with a test.
- Exact ULID library API shape (`ulid()` factory) — verify at implementation time.

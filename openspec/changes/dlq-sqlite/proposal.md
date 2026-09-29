## Why

M2 classifies failures honestly but lets the failed call vanish: the client gets an error, the operator gets a log line, and the work is gone. M3 makes the DLQ real — demo beat 3: a call that exhausts its retries is durably captured **before** the client sees the error, with raw-argument hashing and redacted persistence, and the record survives a middleware restart. The `QueueProvider` and `Store` ports (the two — and only two — extension ports of v1) get their SQLite adapters, `replay list`/`inspect` expose the queue, and `validate` completes the configuration surface.

## What Changes

- **Durable capture before the error** (FR-R3, NFR-5): a `tools/call` that ultimately fails (attempts exhausted, timeout, non-retryable) enqueues a `FailureRecord` before the error is returned; killing the middleware right after the error leaves the record persisted and listable after restart.
- **`FailureRecord`** (Appendix A): ULID id, correlation id, timestamps, caller, server {name, command}, tool {name, `arguments_hash` (sha256 over raw args), redacted arguments}, failure {class, redacted message, attempts}, replay {status `pending`, attempts, last_outcome}.
- **Redaction before persistence** (NFR-4): configurable key patterns (`api_key`, `token`, `password`, `authorization`, `secret`, `credential` by default) applied to persisted arguments and failure messages; `arguments_hash` computed over **raw** args.
- **`QueueProvider` port + SQLite adapter** (FR-R6): `enqueue`, `list`/`get` with filters, atomic `resolve`, `purge`, `health`; WAL + `busy_timeout` so the middleware and the `replay` CLI share the DB files safely (NFR-9).
- **`Store` port + SQLite adapter (audit)**: capturing a failure writes an audit entry linking correlation id ↔ failure id; `recordCall`/`metrics` land with the metrics change (M8).
- **`replay list` / `replay inspect <id>`** (FR-R4 partial): filters, table and `--json` output, reading the same DB as the middleware; `--dry-run`/`run` arrive with `replay-cli` (M4).
- **`validate` command** completes FR-C1/C2: validates the whole config, prints precise path + field errors, exits non-zero on failure.
- **Opt-in `tool_error` capture**: `reliability.per_tool.<tool>.capture_tool_errors: true` captures `isError` results (never retried, unchanged) — default off.
- **Config sections activate**: `queue`, `store`, and `redaction` stop being "unknown section" warnings and become validated sections with safe defaults (`./.mcprelay/queue.db`, `./.mcprelay/history.db`, default patterns).
- **Docs/architecture**: ADR-0004 (SQLite adapters, schema, ULID, redaction policy), README DLQ section, living diagram updated. The npm page README refresh (from M2) ships with this milestone's publish.

No breaking changes: zero-config keeps working; failures are now persisted instead of only logged.

## Capabilities

### New Capabilities

- `dead-letter-queue`: durable, redacted capture before the error, the `FailureRecord` shape, the `QueueProvider` port + SQLite adapter (atomic resolve, filters, purge, health, restart durability), and `replay list`/`inspect` inspection.
- `store`: the `Store` port and its SQLite adapter's audit trail (capture events linking correlation id ↔ failure id).

### Modified Capabilities

- `configuration`: `queue`/`store`/`redaction` sections with defaults, the `capture_tool_errors` per-tool key, and the `validate` command completing FR-C1/C2.
- `retry-pipeline`: `tool_error` results become capturable by explicit per-tool opt-in (still never retried).

## Impact

- **New code**: `src/queue/` (port types, SQLite adapter, FailureRecord), `src/store/` (port types, SQLite adapter), `src/redaction/` (patterns, hash), `src/replay/` (CLI list/inspect), `validate` in `src/cli/`.
- **Modified**: `src/proxy/bridge.ts` (capture before error), `src/config/config.ts` (new sections), `src/cli/run.ts` (command dispatch), `examples/echo-server/` (unchanged), tests.
- **Dependencies**: `better-sqlite3@^12` (MIT; supports Node 20 and 22) and `ulid@^3` (MIT, 69 kB) — both justified in ADR-0004; `node:sqlite` rejected because it requires Node ≥ 22.5 while the project supports Node ≥ 20.
- **Out of scope**: replay `--dry-run`/`run` and dedup (M4), RabbitMQ adapter (M7), metrics/report (M8), policy (M5), retention/cleanup (M8), HTTP (M6).

# ADR-0004 — DLQ persistence: SQLite adapters, schema, and redaction policy

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-09-29 |
| **Milestone** | M3 `dlq-sqlite` |
| **PRD refs** | FR-R3, FR-R6, NFR-4, NFR-5, NFR-9, P4, P5 |

## Context

M3 makes failures durable: the `QueueProvider` and `Store` ports get their SQLite adapters, capture happens before the client sees the error (FR-R3/NFR-5), secrets never persist in the clear (NFR-4), and the `replay` CLI shares the database files with the middleware (NFR-9). The PRD fixes the port shapes (§6.2) and the `FailureRecord` sketch (Appendix A); this ADR records the adapter, schema, id, and redaction decisions and their rejected alternatives.

## Decisions

### D1 — SQLite binding: `better-sqlite3@^12` (MIT)

Synchronous, mature, and the only binding whose engines cover the PRD's Node ≥ 20 floor (`20.x || 22.x || …`). Rejected: `node:sqlite` (built-in, but requires Node ≥ 22.5 and is still experimental — adopting it would silently drop Node 20 support, an NFR-6 change the PRD does not authorize), `sqlite3` (BSD, async callback API and a heavier surface for a store we want synchronous and small), `sql.js` (WASM, no real WAL/durability story). Install note: the native binary is fetched by an install script; environments with `ignore-scripts=true` must run `npm rebuild better-sqlite3 --ignore-scripts=false` once (documented in the README). CI is unaffected.

### D2 — ULID for record ids: `ulid@^3` (MIT)

Appendix A specifies a ULID: lexicographically sortable by capture time and unique without coordination. Rejected hand-rolling Crockford base32 (correctness risk for ~30 lines of code) and UUIDv4 (`crypto.randomUUID`, not sortable). The generator MUST be **monotonic** (`monotonicFactory`): two records captured in the same millisecond must stay ordered, because `replay list` orders by `id DESC`. A plain `ulid()` draws fresh randomness per call and violated the spec's sortable-id scenario within a millisecond; the suite caught it in CI (Node 20) and it was fixed in the M3 follow-up commit.

### D3 — Capture ordering and the failure trade-off

`interceptToolCall` builds the record, `await`s `queue.enqueue` and `store.audit`, and only then throws so the SDK sends the error response. If persistence itself fails (disk full, permissions), the client still receives its error and the failure is logged loudly as `capture failed` on stderr. Rationale: the middleware must never hang or mask the upstream error because the store is unavailable; the trade-off is explicit and visible.

### D4 — Schema and pragmas

One table per concern (queue `failures`, store `audit`), separate database files by default (`./.mcprelay/queue.db`, `./.mcprelay/history.db`). Pragmas on open: `busy_timeout = 5000` **first**, then `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`. The order matters: the WAL pragma needs a lock and must wait for it instead of failing with `SQLITE_BUSY` — found by the concurrent-replay test in M4 and fixed in both adapters. WAL + busy_timeout make concurrent middleware/CLI access safe (NFR-9); NORMAL keeps committed records across process crashes (the NFR-5 guarantee) without an fsync per capture. Indexes on `tool_name`, `correlation_id`, `captured_at`, `replay_status` support the CLI filters.

### D5 — Atomic resolve via a guarded UPDATE

`UPDATE failures SET … WHERE id = ? AND replay_status = 'pending'` — `changes === 1` wins; otherwise the adapter throws `AlreadyResolvedError` (record exists) or `RecordNotFoundError`. This is the mechanism M4's concurrent replay relies on; it is proven with two connections in the contract tests.

### D6 — Redaction policy

- Structured payloads: recursive key matching (case-insensitive substring) against configurable patterns; matching values become `[REDACTED]`; arrays keep their shape; cycles are cut with a marker.
- Free-text failure messages: best-effort regex masking of `key=value` / `key: value` for configured patterns (documented as heuristic — a secret with no key context cannot be detected).
- `arguments_hash`: sha256 over a canonical JSON serialization (object keys sorted recursively) of the **raw** arguments, computed before redaction, so dedup stays stable across redaction changes.
- Rejected: full-payload encryption at rest (out of scope for v1; redaction is the NFR-4 requirement) and allowlist-based argument capture (would break arbitrary tool schemas).

### D7 — Lazy provider opening

Providers are constructed on first capture (and by the CLI on demand), so zero-config sessions create no files until a failure occurs (FR-C2). The bridge owns a small `Persistence` holder (`src/queue/providers.ts`) — the only module that knows about the SQLite adapters; the bridge depends on the port types.

## Consequences

- `replay list`/`inspect` and the middleware can run concurrently against the same files (WAL); `purge` is the manual growth lever until retention lands with M8.
- Adding the RabbitMQ adapter (M7) touches only `providers.ts` + a new adapter; the bridge and ports stay unchanged (P4).
- If Node 20 support is ever dropped, `node:sqlite` becomes a candidate to replace `better-sqlite3`; the ports keep that change local to the adapters.

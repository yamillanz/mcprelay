# ADR-0005 — Replay execution semantics

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-09-29 |
| **Milestone** | M4 `replay-cli` |
| **PRD refs** | FR-R4, FR-R5, FR-R6, NFR-4, §1 *What replay means* |

## Context

Replay is redrive for side effects: the original caller's session is gone, so the replay's own (redacted) result or error is captured into the audit trail — the only place a replay's outcome can ever be inspected (PRD §1). M4 must execute a stored call safely: stored arguments are redacted (NFR-4), duplicate side effects must be guarded (FR-R5), and concurrent replays must not double-execute (FR-R6). This ADR records the semantics that make those guarantees real.

## Decisions

### D1 — Claim with a lease, before executing

`resolve()` is atomic but happens *after* execution, so it cannot prevent two concurrent runs from both executing. The port therefore gains `claim(id, leaseMs)` — a guarded UPDATE that only succeeds while the record is `pending` and unclaimed (or the previous claim's lease expired) — and `release(id)` to clear a claim on a still-pending record. The replay flow claims first, then connects and executes. A claim whose lease (5 minutes, fixed) expires can be reclaimed, so a crashed replay never blocks the record forever.

Schema: `claimed_at` and `claim_expires_at` columns, added in place with a `PRAGMA table_info` guard so M3 databases migrate on open.

### D2 — "An attempted replay is a replay"

If the failure happens **before the tool could execute** (the stored server cannot be reached), the CLI calls `release` and leaves the record `pending` — nothing was attempted, so the operator can retry later. Once the call reaches the tool (success, `isError`, upstream error, or timeout), the outcome is captured, the record is resolved `replayed`, and the CLI exits non-zero if the tool failed. Losing an attempted replay back to `pending` would hide that a side effect may have happened.

### D3 — Redacted arguments are never replayed blindly

Stored arguments contain `[REDACTED]` where secrets were masked. `run` refuses to execute while any marker remains; `--set key=value` (repeatable, top-level) fills the named keys, and a partial fill lists the keys still missing. Rejected alternatives: storing raw secrets to make replay exact (violates NFR-4) and silently sending `[REDACTED]` upstream (would execute a different call than the one that failed).

### D4 — Idempotency index and dedup window

The queue database gains an `executions` table (`key`, `tool_name`, `arguments_hash`, `executed_at`, `source`). The middleware records a successful intercepted call **only when it carries a key** (`_meta.idempotencyKey` or an args `idempotency_key`/`idempotencyKey`), so unkeyed traffic pays nothing. Replay checks the key, falls back to the arguments hash, and refuses duplicates within `reliability.replay.dedup_window` (default 24 h) unless `--force` is given. `--force` proceeds and records the new execution. Rejected: recording failures too (the guard is about *successful* executions; failures are already in the DLQ) and a separate dedup store (same DB keeps the CLI/middleware contract simple).

### D5 — Stored command, quoted and parsed

The record's `server.command` is the exact wrapped invocation, stored shell-quoted (`quoteCommandLine`) so arguments with spaces and quotes survive; replay parses it back (`parseCommandLine`) and spawns it without a shell. Trust boundary: the queue database is local and operator-owned — replay executes what the operator originally ran through the proxy; no command is ever fetched from a remote source. Windows is best-effort (quoting is our own format, not cmd.exe's).

### D6 — Result capture and redaction

The replay's result or error is passed through `redactDeep` (key-based redaction plus string masking for JSON-ish payloads that echo arguments back — `"api_key":"…"`, `key=value`, `key: value`) before being written to `replay.last_outcome` and to an audit entry (`kind: replayed`, linking the original correlation id and failure id). This closes the NFR-4 gap that key-based redaction alone leaves in string payloads.

### D7 — Concurrency fix found in development

The concurrent-replay test exposed a real adapter bug: `journal_mode = WAL` was set before `busy_timeout`, so opening the database while another process held the lock failed with `SQLITE_BUSY` instead of waiting. Both adapters now set `busy_timeout` first (recorded in ADR-0004 D4). The CLI also reports database-open failures cleanly instead of crashing.

## Consequences

- Replay is safe by default: no accidental duplicates (dedup + claim), no secret leakage (guard + redaction), and no silent loss (pending on unreachable server, captured on attempt).
- `--force` is the single explicit escape hatch; the dedup verdict names the previous execution so the decision is informed.
- The idempotency convention is ours until the spec's ETags/caching work lands (PRD §5.1); the hash fallback covers unkeyed calls.

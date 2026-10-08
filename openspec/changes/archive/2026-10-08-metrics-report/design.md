## Context

The `Store` port (PRD §6.2) shipped with the audit path implemented (M3) and `recordCall`/`metrics` throwing "not implemented", with `CallEvent`/`ToolMetrics` as shape sketches. The bridge already builds one log entry per intercepted call (`buildCallLogEntry`, FR-O1) with decision, latency, sizes, attempts, correlation id, and caller — but nothing is persisted. M8 (FR-O2–O3, UC4, demo beat 5) persists those events and exposes them through `mcprelay report`; NFR-9 requires bounded growth with configurable retention (default 30 days of CallEvents). Constraints: metrics must reconcile with the logs (milestone exit criterion), the store write must never break a call (same discipline as capture/audit), the read path is a local CLI (no hot-path concern), and the caller identity is the current placeholder until M9 fills real identities.

## Goals / Non-Goals

**Goals:**

- One persisted `CallEvent` per intercepted `tools/call`, carrying exactly what the log line carries; denied/failed/cancelled/allowed decisions included; unenforced dry-run decisions excluded.
- `metrics(filter)` via the `Store` port: per caller + tool counts, error count/rate, latency p50/p95, average payload sizes, plus decision totals and the `replayed` count from the audit trail.
- `mcprelay report` renders the time-ranged table and `--json`; documented defaults and exit behavior.
- Retention: `store.retention_days` (default 30, `0` disables), pruned on store open, documented (NFR-9).

**Non-Goals:**

- Prometheus/OpenMetrics endpoint (FR-O4 — its own post-M8 change).
- Real caller identities (M9 `auth-identities`); the placeholder `{type: 'stdio', identity: 'local'}` is persisted as-is so attribution is correct the day identities arrive.
- Server-name attribution, per-attempt events, cross-store (Postgres) work, dashboards, or alerting.
- Changing the FR-O1 log line shape (the event mirrors it; the line is the source of truth for tests).

## Decisions

### D1 — Event/log parity through one helper, non-blocking

`interceptToolCall` keeps a single `logCall(deps, entry)` path: it emits the JSON line (unchanged) and persists a `CallEvent` built from the same `CallLogEntry`, except entries with `enforced: false` (dry-run) which are logged only. Persistence failures are caught and warned (`mcprelay: metrics write failed: …`) and never affect the call — the same discipline as capture and audit. One event per call (not per attempt); `attempt` records the final attempt count. `CallEvent` gains a `caller {type, identity}` field (placeholder today) so FR-O2's caller attribution is real in the schema.

### D2 — Aggregation in the SQLite adapter; port shapes defined now

`call_events` table (`id` ULID, `at`, `correlation_id`, `caller_type`, `caller_identity`, `tool`, `decision`, `latency_ms`, `request_bytes`, `response_bytes`, `attempt`) with indexes on `at`, `tool`, `caller_identity`; created with `CREATE TABLE IF NOT EXISTS` so existing `history.db` files migrate on open. The port return type is defined by this change (the skeleton's signatures were never implemented, so there is no compatibility constraint):

```ts
interface StoreMetrics {
  tools: ToolMetrics[];          // one row per caller + tool
  decisions: { allowed: number; denied: number; failed: number; cancelled: number };
  replayed: number;              // audit entries kind 'replayed' in range
}
interface ToolMetrics {
  caller: string; tool: string;
  calls: number; errors: number; error_rate: number;
  latency_p50_ms: number; latency_p95_ms: number;
  avg_request_bytes: number; avg_response_bytes: number;
}
```

`errors` counts decision `failed` (upstream errors and `isError` results); denied and cancelled are decisions, not errors (FR-Y4, FR-R2). Percentiles use the **nearest-rank** method over the sorted latencies (⌈p/100 · n⌉-th value, no interpolation) — documented and pinned by unit tests with known datasets. Aggregation runs in JS over the filtered rows: the read path is the local CLI, and the dataset is bounded by retention. `MetricsFilter` gains `caller`. Rejected: SQL window-function percentiles (SQLite has no percentile aggregate; per-group corner cases get convoluted) and storing pre-aggregated rollups (breaks arbitrary time ranges and filters).

### D3 — Retention: prune on open, call events only

`store.retention_days` (integer, default 30, `0` disables) lives under the strict `store` section. On store open, `DELETE FROM call_events WHERE at < now − retention_days` runs once (indexed, cheap). Only `call_events` are pruned — the audit trail and the DLQ keep their own lifecycle (NFR-9 names CallEvents explicitly). Documented in the README config example.

### D4 — `mcprelay report`: table + JSON, documented defaults

`mcprelay report [--since <iso>] [--until <iso>] [--tool <name>] [--caller <identity>] [--json] [--config <path>]`. Defaults: `since` = now − 24 h, `until` = now; ISO-8601 values validated (usage error otherwise). Human output: a window line, a totals line (`calls · allowed · denied · failed · cancelled · replayed`), and a table of `CALLER TOOL CALLS ERRORS ERR% P50 P95 AVG_REQ_B AVG_RESP_B`. `--json` emits one document: `{ since, until, totals: {...}, tools: [...] }`. Empty data prints zero totals and exits 0 (not an error); malformed config/args exit 2, store-open failure exits 1 — the replay/list convention. The command lives in `src/report/report-cli.ts`, dispatched from `src/cli/run.ts`, and obtains its store through `createPersistence` (port-only core).

### D5 — Testing

Store unit tests pin nearest-rank p50/p95 with known latencies, error rate, byte averages, caller grouping, filters (`since`/`until`/`tool`/`caller`), decision totals, `replayed` from audit, retention prune and `0` disabling, and migration of a pre-M8 `history.db`. A parity test runs a live session (allowed, denied, failed, cancelled) through the echo server, parses the JSON log lines, and asserts `metrics()` reconciles with them — including the dry-run denial being logged but absent from metrics. Report CLI tests seed a store and cover the table, `--json`, filters, empty data, unknown options, and invalid dates. Config tests cover retention parsing/validation. Real-server evidence: the filesystem demo flow then `mcprelay report` on the numbers, checked against the logs.

### D6 — Docs and diagram

ADR-0009 records the parity rule, nearest-rank percentiles, prune-on-open retention, and the caller placeholder. The living diagram gains the report path (call events → Store → report CLI) within the 12-node showcase budget — the report CLI may replace or absorb an existing CLI node if no clean corridor exists (decided during implementation against the validator). README gains the report section and the retention key; AGENTS status moves to M8 → next M9.

## Risks / Trade-offs

- **Extra write per call vs the NFR-3 budget** → one indexed insert per intercepted call (the same order as the existing audit write on failure paths); store failures warn and never block; `bench/` (a later milestone) remains the arbiter.
- **Percentile definition drift** → nearest-rank fixed in this design, the spec, and unit tests with hand-computed datasets.
- **Metrics drifting from logs** → parity test over a real session; a single entry object feeds both paths.
- **Retention surprising users** → default 30 days documented, `0` disables, only call events pruned; DLQ/audit untouched.
- **Caller attribution looks empty-ish until M9** → the placeholder is persisted as a real field, so M9 changes the value, not the schema; README says so.

## Migration Plan

No breaking change: the new table is created on open (`CREATE TABLE IF NOT EXISTS`), `store.retention_days` defaults to 30, and `report` is additive. Rollback is a revert; already-written call events simply stop being read.

## Open Questions

(none)

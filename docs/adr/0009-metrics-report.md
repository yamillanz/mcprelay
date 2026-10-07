# ADR-0009 — Metrics: call-event parity, nearest-rank percentiles, and retention

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-10-07 |
| **Milestone** | M8 `metrics-report` |
| **PRD refs** | FR-O1–O3, NFR-3, NFR-9, UC4, §12 |

## Context

M8 persists what the FR-O1 log line already knows and exposes it through `mcprelay report` (FR-O2–O3, demo beat 5). The `Store` port's `recordCall`/`metrics` shipped as throwing skeletons with shape sketches; nothing consumed them, so this change defines the shapes. Constraints: metrics must reconcile with the logs (milestone exit criterion), the store write must never break a call (same discipline as capture/audit), the read path is a local CLI, caller identity is a placeholder until M9, and store growth must be bounded (NFR-9).

## Decisions

### D1 — One `logCall` path: the log line and the call event are the same data

`interceptToolCall` no longer calls the logger directly; a single `logCall(deps, entry)` emits the JSON line and persists a `CallEvent` built from the same entry. This makes parity structural instead of aspirational. Entries with `enforced: false` (dry-run would-be denials) are logged but not persisted: they were never enforced, so counting them as denials would lie. One event per call — retries are captured by the `attempt` field, not by extra rows. A store failure is caught and warned (`mcprelay: metrics write failed: …`); the call still completes, mirroring capture/audit. `CallEvent.caller` is a real column set from the placeholder identity, so M9 changes the value, not the schema.

### D2 — `metrics()` groups per caller+tool and aggregates in JavaScript

`call_events(id, at, correlation_id, caller_type, caller_identity, tool, decision, latency_ms, request_bytes, response_bytes, attempt)` with indexes on `at`, `tool`, `caller_identity`; created with `CREATE TABLE IF NOT EXISTS` so pre-M8 store files migrate in place. `metrics(filter)` returns:

```ts
interface StoreMetrics {
  tools: ToolMetrics[];          // per caller+tool
  decisions: { allowed; denied; failed; cancelled };
  replayed: number;              // audit kind 'replayed' in range
}
```

`errors` counts decision `failed` only: a denied call never ran (FR-Y4) and a cancelled call is not a failure (FR-R2). Percentiles use the **nearest-rank** method over sorted latencies (the ⌈p/100 · n⌉-th value, no interpolation) — cheap, explainable, and pinned by unit tests with hand-computed datasets. Aggregation runs in JS over the filtered rows rather than SQL window functions: SQLite has no percentile aggregate, per-group corner cases get convoluted, and the read path is a local CLI whose dataset is bounded by retention. Rejected: pre-aggregated rollups (break arbitrary ranges/filters) and storing per-attempt rows (the log line is per call; parity would need joins).

### D3 — Retention: prune on open, call events only

`store.retention_days` (integer ≥ 0, default 30, `0` disables) lives under the strict `store` section. On store open, events older than `now − retention_days` are deleted in one indexed statement. Only `call_events` are pruned — the audit trail and the DLQ keep their own lifecycles (NFR-9 names CallEvents). Rejected: pruning on every write (per-call cost) and a background timer (a CLI process has no lifetime to hang work on).

### D4 — `report`: table + JSON with documented defaults

`mcprelay report [--since <iso>] [--until <iso>] [--tool <name>] [--caller <identity>] [--json] [--config <path>]`; default window = the last 24 hours. Human output: window line, totals line (`calls · allowed · denied · failed · cancelled · replayed`), and a per caller+tool table (`ERR%` one decimal; latencies in ms). `--json` emits one document with `since`, `until`, `totals`, and `tools`. Empty data prints zero totals and exits 0; bad dates/options are usage errors (2); store-open failures exit 1. The command reads through `createPersistence` (port-only core) and lives in `src/report/report-cli.ts`.

## Consequences

- **Positive:** metrics reconcile with logs by construction; one insert per call (same order as the existing audit write); retention bounds growth; `report` is CI-friendly; the schema already carries caller attribution for M9.
- **Negative / accepted:** caller and server attribution are coarse until identities land (M9) and no server column exists (FR-O2 asks for caller+tool; a future change can add it); JS aggregation is O(rows) per report (fine for a local CLI, bounded by retention); `retention_days` is days-only (NFR-9's unit).

## Why

M8 answers UC4 — *"what happened?"*. The log line per intercepted call (FR-O1) exists, but nothing is persisted: `CallEvent`/`ToolMetrics` are skeletons in the `Store` port and `recordCall`/`metrics` throw "not implemented". Demo beat 5 (§1) and the milestone exit criteria need per-tool latency, error rate, payload size, and caller attribution persisted and reportable from the CLI (`mcprelay report`, FR-O2–O3), with Store growth bounded by configurable retention (NFR-9).

## What Changes

- **Call events persisted**: every intercepted `tools/call` writes one `CallEvent` — the same entry that becomes the FR-O1 log line (decision, latency, payload sizes, attempts, correlation id, caller) — so metrics and logs reconcile ("metrics match logs"). Dry-run (unenforced) decisions are logged but not persisted; a store failure warns and never breaks the call.
- **Metrics via the `Store` port** (FR-O2): `metrics(filter)` aggregates per caller + tool — call count, error count/rate, latency p50/p95 (nearest-rank), average request/response bytes — plus decision totals (allowed/denied/failed/cancelled) and the `replayed` count from the audit trail. Filters: `since`, `until`, `tool`, `caller`.
- **`mcprelay report`** (FR-O3): human-readable table and `--json` for a time range; default window last 24 h; `--since`/`--until`/`--tool`/`--caller` filters; exit codes consistent with the CLI; empty data is not an error. Command surface, HELP, and dispatch updated.
- **Retention (NFR-9)**: `store.retention_days` (default 30, `0` disables) prunes `call_events` older than the window when the store opens; documented in the README.
- **Port-only core**: the report CLI selects its store through `createPersistence` (the M7 rule extends to it).
- ADR-0009 (event/log parity, nearest-rank percentiles, retention prune-on-open, caller placeholder until M9); README (report + retention); living diagram (call events → Store → report CLI).

## Capabilities

### New Capabilities

- `report-cli`: the `mcprelay report` command — metrics table and `--json` for a time range, filters, decision/replay counts, and documented exit behavior.

### Modified Capabilities

- `store`: `recordCall`/`metrics` move from skeleton to implemented — `call_events` schema, per-caller+tool aggregation with percentiles/error rate/payload sizes, decision totals, `replayed` from audit, retention pruning.
- `observability`: one persisted call event per emitted log line (parity), with unenforced dry-run decisions excluded and store failures non-blocking.
- `configuration`: `store.retention_days` (default 30, `0` disables) with strict parsing and precise errors.
- `maintainability`: port-only provider selection also covers the report CLI.

## Impact

- **Code**: `src/store/sqlite-store.ts` (call_events schema, `recordCall`, `metrics`, prune, port shapes), `src/proxy/bridge.ts` (persist the log entry at each decision site), `src/report/report-cli.ts` (new), `src/cli/run.ts` (dispatch + HELP), `src/config/config.ts` (retention), `src/queue/providers.ts` (report uses the same store factory).
- **Tests**: `store` aggregation/retention, call-event/log parity in a live session, report CLI behavior, config parsing.
- **Docs**: ADR-0009, README (report + retention), architecture diagram; no new dependencies; no breaking CLI changes (new command).

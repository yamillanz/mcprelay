# Tasks — `metrics-report`

Test-first (rule 11): every implementation group starts with its failing tests. Everything here is hermetic (SQLite store + echo/filesystem servers); broker tests are untouched.

Scenario → test traceability: "Every decision is persisted" / "Metrics group per caller and tool" / "Filters narrow the aggregate" / "Error rate excludes denials and cancellations" / "Nearest-rank percentiles" / "Payload sizes average per row" / "Decision totals and replayed count" / "Metrics survive restart" → `tests/store.test.ts`; retention scenarios → `tests/store.test.ts` + `tests/config.test.ts`; "Persisted call events mirror the log line" scenarios → `tests/call-log.test.ts` (live session) ; report scenarios → `tests/report-cli.test.ts`; "The report CLI selects through the factory" → `tests/providers.test.ts` + code inspection.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-07 ("approved, make the commit" + `/opsx-apply metrics-report`)

## 1. Baseline

- [x] 1.1 Run the full gate and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (hermetic; expect 330 passed + 5 skipped, and 341/341 with `MCPRELAY_RABBITMQ_URL` set)
  - Baseline 2026-10-07 hermetic: typecheck/lint/format/build/build:examples clean; **330 passed + 5 skipped** (broker suites skip with notice); `spec:validate` 12/12

## 2. Call events, metrics, and retention (red first)

- [x] 2.1 Write failing `tests/store.test.ts` cases: recordCall → metrics round-trip, grouping per caller+tool, filters (`since`/`until`/`tool`/`caller`), error rate excluding denials/cancellations, nearest-rank p50/p95 on known latencies (`[10,20,30,40]` → 20/40), payload averages, decision totals + `replayed` from audit, restart durability, migration of a pre-M8 `history.db` ("Every decision is persisted"; "Metrics group per caller and tool"; "Filters narrow the aggregate"; "Error rate excludes denials and cancellations"; "Nearest-rank percentiles"; "Payload sizes average per row"; "Decision totals and replayed count"; "Metrics survive restart")
  - 8 failing cases first (replacing the pre-M8 not-implemented stub test); red confirmed
- [x] 2.2 Implement `call_events` schema + `recordCall` + `metrics` (StoreMetrics) in `src/store/sqlite-store.ts` until green
  - Schema + indexes, `CallDecision` re-exported from `call-log.ts`, nearest-rank helper, JS aggregation, replayed count from audit; store suite 11/11
- [x] 2.3 Config-first: write failing `tests/config.test.ts` cases (default 30, file override, invalid negative/fractional/non-number naming `store.retention_days`, zero) then implement the key in `src/config/config.ts` until green ("Store retention" scenarios)
  - 4 failing cases first; `StoreConfig.retentionDays` + `STORE_KEYS` + strict parsing; config 36/36
- [x] 2.4 Write failing retention cases (prune on open, keep inside window, `0` disables, audit untouched) then implement prune-on-open in `src/store/sqlite-store.ts` until green ("Call-event retention" scenarios)
  - 4 cases; `pruneCallEvents()` on open, `0` disables, audit untouched; `createPersistence` passes `retentionDays`; store+config+providers 55/55

## 3. Event/log parity (red first)

- [x] 3.1 Write failing parity cases in `tests/call-log.test.ts`: a live session (allowed, denied, failed, cancelled) through the echo server — persisted events reconcile with the parsed JSON log lines one-for-one; a retried success persists exactly one event with the final attempt count; a dry-run denial is logged with `enforced: false` and not persisted; a store failure warns and the call still completes ("Decision parity between log and events"; "Retried success persists one event"; "Dry-run denials are logged but not persisted"; "Store failures never break a call")
  - 4 failing cases first (temp config + raw `call_events` readback); red confirmed against stale dist
- [x] 3.2 Implement the `logCall` helper in `src/proxy/bridge.ts` (emit the line and persist the event, exceptions for `enforced: false`, warnings on store failure) until green
  - 5 log sites now route through `logCall`; `tests/call-log.test.ts` 10/10; full suite **349 passed + 5 skipped**

## 4. Report CLI (red first)

- [x] 4.1 Write failing `tests/report-cli.test.ts`: seeded store → table (window, totals line with all counts, caller+tool rows), `--json` single document, filters (`--since`/`--until`/`--tool`/`--caller`), empty data → zero totals + exit 0, invalid dates → exit 2 naming the value, unknown option → exit 2, config error → exit 2 ("Table renders the aggregated metrics"; "JSON is machine-readable"; "Filters narrow the window"; "Empty data is not an error"; "Invalid dates are usage errors"; "Replayed counts come from the audit trail")
  - 7 failing cases first (red against the missing `report` command)
- [x] 4.2 Implement `src/report/report-cli.ts` (via `createPersistence`) plus dispatch + HELP in `src/cli/run.ts` until green; report defaults to the last 24 h
  - Parser + table/JSON renderers + totals; HELP gains `report` and the status line moves to M8; report 7/7, full suite **356 passed + 5 skipped**

## 5. Docs and diagram

- [x] 5.1 Write `docs/adr/0009-metrics-report.md` (event/log parity, nearest-rank percentiles, prune-on-open retention, caller placeholder until M9, rejected alternatives: SQL percentiles, pre-aggregated rollups)
  - ADR-0009 written (D1 `logCall` parity, D2 aggregation, D3 retention, D4 report surface, consequences)
- [x] 5.2 README: `report` section (table + `--json`, default window, filters) and `store.retention_days` in the config example; AGENTS status line (M8 landed → next M9 `auth-identities`)
  - README status M8 + metrics bullet + Report section + `retention_days` in the config example + ADR-0009 in the index; AGENTS status → M8 landed, next M9
- [x] 5.3 PRD (rule 1): add `retention_days` to the Appendix B store example; document history v0.11
  - Appendix B updated; history v0.11 added
- [x] 5.4 Living architecture diagram: add the report path (call events → Store → report CLI) within the showcase node budget; validate + re-deliver the HTML (Archify, showcase) and visual-check
  - Title M8; `CLIs` node (`replay · report`, tag `claim · dedup · metrics`); call-log tag `stderr · mirrors to Store`; persistence tag `WAL · redaction · retention`; validate 0 errors/0 warnings, delivered, visual-check light/dark at 1440x900

## 6. Verification and approval gates

- [x] 6.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
  - 2026-10-07 hermetic: typecheck/lint/format/build/build:examples clean; **356 passed + 5 skipped** (broker suites skip with notice; M8 touches no broker code); `spec:validate` 12/12
- [x] 6.2 Demo-beat-5 evidence: a real session (filesystem server: allowed call, denied call, captured failure) then `mcprelay report` shows real numbers and the report reconciles with the structured log lines — record the output here
  - 2026-10-07 evidence run (real filesystem server): logs `read_file:allowed`, `write_file:denied`, `read_file:failed` → `report --json` totals `{calls:3, allowed:1, denied:1, failed:1, cancelled:0, replayed:0}`, rows `local/read_file:2/1/0.5`, `local/write_file:1/0/0` → **metrics match logs: true**; table renders `50.0%` for read_file; the failed call is in the DLQ (`read_file:tool_error`)
- [x] 6.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
  - Approved 2026-10-07: `2fa7452` feat (+ `803eff6` spec) pushed to `origin/main`
- [x] 6.4 Human approval to archive (rule 0); archive the change after approval
  - Approved and archived 2026-10-08 as `2026-10-08-metrics-report`

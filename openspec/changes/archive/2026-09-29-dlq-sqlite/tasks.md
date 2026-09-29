# Tasks — `dlq-sqlite`

Test-first (rule 11): each delta scenario becomes a failing test before its implementation. Scenario names in parentheses map to `specs/dead-letter-queue/spec.md`, `specs/store/spec.md`, `specs/configuration/spec.md`, and `specs/retry-pipeline/spec.md`.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session** (approved 2026-09-29)

## 1. Foundations: redaction, hash, ULID, record model

- [x] 1.1 Add `better-sqlite3@^12` and `ulid@^3` (both MIT); record the justification in ADR-0004
- [x] 1.2 Write failing unit tests: redaction (nested keys, custom patterns, arrays, cycles), message masking, canonical hash stability, ULID ordering/uniqueness, D4→record class mapping (red)
- [x] 1.3 Implement `src/redaction/redact.ts` and `src/queue/failure-record.ts` until green

## 2. QueueProvider + SQLite adapter

- [x] 2.1 Write failing contract tests: enqueue/list/get, filters (status, tool, correlation, time range), atomic resolve with two connections, purge, health, reopen durability, WAL + busy_timeout pragmas (red)
- [x] 2.2 Implement `src/queue/sqlite-queue.ts` (port types + adapter, schema, lazy open, mkdir on first write) until green

## 3. Store port + audit

- [x] 3.1 Write failing tests: capture writes an audit entry (kind, correlation id, failure id, timestamp); audit survives restart; default paths are separate (red)
- [x] 3.2 Implement `src/store/sqlite-store.ts` until green

## 4. Configuration sections + validate

- [x] 4.1 Write failing tests: `queue`/`store`/`redaction` defaults, file overrides, malformed sections with path+field, `capture_tool_errors` accepted and resolved into the tool policy (red)
- [x] 4.2 Extend `src/config/config.ts` until green
- [x] 4.3 Write failing tests for `mcprelay validate`: valid exits 0 with summary; invalid exits non-zero with path+field; explicit missing path fails; no upstream started (red)
- [x] 4.4 Implement the `validate` command + dispatch until green

## 5. Capture before the error (bridge integration)

- [x] 5.1 Write failing integration tests: exhausted retries captured before the error (client sees the error only after the record exists), non-retryable captured, success/cancelled never captured, redacted arguments + raw hash, correlation id matches the log line (red)
- [x] 5.2 Implement capture + audit in `interceptToolCall` (lazy providers, capture-failure path logged, never block the client) until green
- [x] 5.3 Write the durability test: kill the middleware right after the error (SIGKILL), then `replay list` from a fresh process shows the record (red → green)
- [x] 5.4 Write failing tests for opt-in `tool_error` capture (default off; opt-in writes class `tool_error`) and implement until green

## 6. Replay inspection CLI

- [x] 6.1 Write failing tests: `replay list` shows captured records (table + `--json`), filters work, `inspect <id>` prints one record, unknown id exits with the not-found code (red)
- [x] 6.2 Implement `src/replay/replay-cli.ts` + dispatch + exit codes until green

## 7. Docs, ADR, diagram, npm refresh

- [x] 7.1 Write ADR-0004: SQLite adapter choice (and rejected `node:sqlite`/`sqlite3`/`sql.js`), schema + pragmas, ULID, redaction policy, capture-failure trade-off
- [x] 7.2 Update the living architecture diagram (DLQ + Store + capture path) and re-deliver the HTML (showcase)
- [x] 7.3 README: DLQ section (capture → list → inspect, redaction, config), AGENTS status line (M3 done → next M4)
- [x] 7.4 Publish follow-up from M2: bump the version, `stage publish`, human approves with 2FA, verify `npx` — this refresh also fixes the stale README on the npm page

## 8. Verification and approval gates

- [x] 8.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [x] 8.2 Real-server check: filesystem session through the proxy with the new config sections; `replay list` reads the shared DB; record evidence here
- [x] 8.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [x] 8.4 Human approval to archive (rule 0); archive the change after approval

## Verification results — 2026-09-29 (Node v22.17.0)

- `npm test` → 128/128 green across 13 suites: redaction/hash/ULID/classes (11), queue contract (8), store audit (4), config (14), validate CLI (4), capture + durability (7), replay CLI (7), plus the M1/M2 suites
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run spec:validate` → clean
- Real-server gate: `secure-filesystem-server` session (14 tools, `read_file` OK) with the new config sections; with `capture_tool_errors: true` the real server's `isError` result was captured, `replay list` showed it (`tool_error`, attempts=1, pending) and `replay inspect` printed the full redacted record
- Durability (NFR-5): SIGKILL immediately after the error response leaves the record readable by a fresh process (test `survives SIGKILL right after the error`)
- Atomic resolve: two connections resolving the same record → exactly one wins (contract test)
- Dev-environment note: the machine's global `ignore-scripts=true` requires `npm rebuild better-sqlite3 --ignore-scripts=false` once (README install note added); CI is unaffected
- Artifact sync: added `src/queue/providers.ts` (lazy Persistence holder) so the bridge depends on port types only; eslint now ignores `_`-prefixed unused parameters
- Real-package check (rule 10) found and fixed a rough edge: when the SQLite native binary is missing (npm `ignore-scripts=true`), `replay` now exits 1 with an actionable message instead of a stack trace (test added); `validate` and the proxy success path are unaffected. The published 0.0.3 predates this fix — it ships in 0.0.4 (M4)
- npm 0.0.3 published and verified (`npm view` + `npx @yamillanz/mcprelay@0.0.3 --version`); the npm page README refresh from M2 is resolved

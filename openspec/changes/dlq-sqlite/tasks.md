# Tasks — `dlq-sqlite`

Test-first (rule 11): each delta scenario becomes a failing test before its implementation. Scenario names in parentheses map to `specs/dead-letter-queue/spec.md`, `specs/store/spec.md`, `specs/configuration/spec.md`, and `specs/retry-pipeline/spec.md`.

## 0. Approval gate (rule 0 — blocks everything below)

- [ ] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**

## 1. Foundations: redaction, hash, ULID, record model

- [ ] 1.1 Add `better-sqlite3@^12` and `ulid@^3` (both MIT); record the justification in ADR-0004
- [ ] 1.2 Write failing unit tests: redaction (nested keys, custom patterns, arrays, cycles), message masking, canonical hash stability, ULID ordering/uniqueness, D4→record class mapping (red)
- [ ] 1.3 Implement `src/redaction/redact.ts` and `src/queue/failure-record.ts` until green

## 2. QueueProvider + SQLite adapter

- [ ] 2.1 Write failing contract tests: enqueue/list/get, filters (status, tool, correlation, time range), atomic resolve with two connections, purge, health, reopen durability, WAL + busy_timeout pragmas (red)
- [ ] 2.2 Implement `src/queue/sqlite-queue.ts` (port types + adapter, schema, lazy open, mkdir on first write) until green

## 3. Store port + audit

- [ ] 3.1 Write failing tests: capture writes an audit entry (kind, correlation id, failure id, timestamp); audit survives restart; default paths are separate (red)
- [ ] 3.2 Implement `src/store/sqlite-store.ts` until green

## 4. Configuration sections + validate

- [ ] 4.1 Write failing tests: `queue`/`store`/`redaction` defaults, file overrides, malformed sections with path+field, `capture_tool_errors` accepted and resolved into the tool policy (red)
- [ ] 4.2 Extend `src/config/config.ts` until green
- [ ] 4.3 Write failing tests for `mcprelay validate`: valid exits 0 with summary; invalid exits non-zero with path+field; explicit missing path fails; no upstream started (red)
- [ ] 4.4 Implement the `validate` command + dispatch until green

## 5. Capture before the error (bridge integration)

- [ ] 5.1 Write failing integration tests: exhausted retries captured before the error (client sees the error only after the record exists), non-retryable captured, success/cancelled never captured, redacted arguments + raw hash, correlation id matches the log line (red)
- [ ] 5.2 Implement capture + audit in `interceptToolCall` (lazy providers, capture-failure path logged, never block the client) until green
- [ ] 5.3 Write the durability test: kill the middleware right after the error (SIGKILL), then `replay list` from a fresh process shows the record (red → green)
- [ ] 5.4 Write failing tests for opt-in `tool_error` capture (default off; opt-in writes class `tool_error`) and implement until green

## 6. Replay inspection CLI

- [ ] 6.1 Write failing tests: `replay list` shows captured records (table + `--json`), filters work, `inspect <id>` prints one record, unknown id exits with the not-found code (red)
- [ ] 6.2 Implement `src/replay/replay-cli.ts` + dispatch + exit codes until green

## 7. Docs, ADR, diagram, npm refresh

- [ ] 7.1 Write ADR-0004: SQLite adapter choice (and rejected `node:sqlite`/`sqlite3`/`sql.js`), schema + pragmas, ULID, redaction policy, capture-failure trade-off
- [ ] 7.2 Update the living architecture diagram (DLQ + Store + capture path) and re-deliver the HTML (showcase)
- [ ] 7.3 README: DLQ section (capture → list → inspect, redaction, config), AGENTS status line (M3 done → next M4)
- [ ] 7.4 Publish follow-up from M2: bump the version, `stage publish`, human approves with 2FA, verify `npx` — this refresh also fixes the stale README on the npm page

## 8. Verification and approval gates

- [ ] 8.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [ ] 8.2 Real-server check: filesystem session through the proxy with the new config sections; `replay list` reads the shared DB; record evidence here
- [ ] 8.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [ ] 8.4 Human approval to archive (rule 0); archive the change after approval

# Tasks — M1 `proxy-stdio`

Every implementation group starts with its failing tests (rule 11). Scenario names in parentheses map to `specs/stdio-proxy/spec.md` and `specs/observability/spec.md` — that mapping is the completion metric.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session** (approved 2026-09-25)

## 1. Harness and dependencies

- [x] 1.1 Add SDK v2 deps `@modelcontextprotocol/server@^2.1.0`, `@modelcontextprotocol/client@^2.1.0`; `npm ls` audit shows only permissive licenses (P1/P5, FR-P6)
- [x] 1.2 Write failing direct-session tests for the hermetic echo server: initialize, tools/list, tools/call, matrix methods, batch frame, server→client request, stderr emission, crash switch (red)
- [x] 1.3 Implement the `examples/` hermetic echo server (raw deterministic fixture) until tests are green
- [x] 1.4 Write failing tests for the raw-frame test client helper (newline JSON child process: batches, unknown methods, unsupported revision) and implement the helper until green

## 2. Wrap and `run` command (FR-P1)

- [x] 2.1 Write failing tests: wrap end-to-end on the hermetic server, shorthand `mcprelay -- …`, missing server command exits 2 (red)
- [x] 2.2 Implement the `run` command plus upstream spawn/connect and the client-facing server until tests are green

## 3. Passthrough matrix (FR-P2)

- [x] 3.1 Write failing tests for every matrix scenario: client→server requests, client→server notifications, server→client requests, progress, unknown/custom methods, batch frames, initialize negotiation, no middleware-specific fields upstream (red)
- [x] 3.2 Implement the relay — fallback request/notification handlers, explicit server→client forwarding, batch-frame demux — until tests are green

## 4. `tools/call` interception and session context (FR-P3)

- [x] 4.1 Write failing tests: exactly one upstream call, result fidelity (success and `isError`), session context from initialize/tools/list, upstream tool error (red)
- [x] 4.2 Implement the `tools/call` handler and in-memory session context until tests are green

## 5. Correlation (FR-P5)

- [x] 5.1 Write failing tests: generated unique correlation id, OTel keys preserved and logged, namespaced `_meta` injection with other fields intact (red)
- [x] 5.2 Implement correlation id generation/injection and OTel propagation until tests are green

## 6. Process hygiene (FR-P4)

- [x] 6.1 Write failing tests: upstream stderr separation, stdout protocol purity, crash mid-call yields JSON-RPC error + exit code 3, already-written log line intact (red)
- [x] 6.2 Implement stderr forwarding, crash handling, and exit code 3 until tests are green

## 7. Protocol revision termination (FR-P6)

- [x] 7.1 Write failing tests: independent negotiation, 2026-07-28 preferred when both sides support it, unsupported revision returns a standard error (red)
- [x] 7.2 Spike and implement SDK v2 era/revision handling until tests are green; record the outcome in `design.md` and ADR-0002

## 8. Observability (FR-O1)

- [x] 8.1 Write failing tests for the log line: success (`allowed`), failure (`failed`, including `isError`), no argument values, caller object, one valid JSON object per line (red)
- [x] 8.2 Implement the call-log writer (injectable sink, JSON lines on stderr) until tests are green

## 9. Real-server gate and documentation (rule 10)

- [x] 9.1 Real-server check: a full session through `mcprelay run -- npx @modelcontextprotocol/server-filesystem .`, plus one readable call log line; record the evidence here
- [x] 9.2 Write ADR-0002: termination topology, supported-revision boundary, batch-frame demux, any SDK-injected fields (FR-P6)
- [x] 9.3 Update README status and the AGENTS status line (M1 done → next M2 `retry-pipeline`)

## 10. Verification and approval gates (rule 0)

- [x] 10.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [x] 10.2 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [x] 10.3 Human approval to archive (rule 0); archive the change after approval

## Verification results — 2026-09-25 (Node v22.17.0)

- `npm test` → 46/46 green across 4 suites: CLI (9), echo server (10), proxy fidelity/interception/hygiene/revision (21), call logs (6)
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` → clean
- Real-server gate (rule 10): `mcprelay run -- npx @modelcontextprotocol/server-filesystem .` — negotiated 2025-11-25 through the auto-probe fallback, 14 tools, `read_file` on `README.md` succeeded, call log line emitted (full evidence in `docs/adr/0002-stdio-proxy-termination.md`)
- SDK v2 spike outcomes recorded in ADR-0002: termination topology, revision boundary, batch demux, SDK-injected `_meta` envelope/serverInfo on the modern era, client capability advertisement, progress-token rewrite, microtask yield between frames
- Artifact sync during apply: hermetic echo server implemented as a raw deterministic fixture instead of SDK-based (design D9 + task 1.3 updated) so batch frames, legacy server→client requests, and crash control are exact

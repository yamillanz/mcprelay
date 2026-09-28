# Tasks — `readability-refactor`

Behavior-preserving refactor: the existing suite is the test-first safety net. Each extraction step runs the suite before moving on; no test assertions change.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session** (approved 2026-09-27)

## 1. Baseline evidence

- [x] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` (expect 46/46)
- [x] 1.2 Re-run the real-server check against `@modelcontextprotocol/server-filesystem` and record the log line (pre-refactor behavior reference)

## 2. Extract session scaffolding (same file)

- [x] 2.1 Extract `createCloseSignal`, `createUpstreamTransport`, `createClientTransport`; suite green
- [x] 2.2 Extract `relayBatchFrames` and `wireCloseSignals`; suite green
- [x] 2.3 Extract `createUpstreamClient`, `registerServerToClientRequestRelays` (with the pinned-server holder), `relayClientNotifications`, `relayUpstreamNotifications`; suite green

## 3. Extract upstream connect and session capture

- [x] 3.1 Extract `connectUpstream` and `captureSessionContext`; suite green

## 4. Extract server factory and interception

- [x] 4.1 Extract `createClientServerFactory` (fresh `Server` per call — the probe-discard invariant) and `createRelayRequest`; suite green
- [x] 4.2 Extract `prepareCallMetadata`, `buildCallLogEntry`, `interceptToolCall`, `relayPassthroughRequest`; suite green
- [x] 4.3 Rewrite `startBridge` as the ordered named-step sequence from design D3; suite green

## 5. Documentation and governance

- [x] 5.1 Update `docs/code-tours/bridge.md` to mirror the new structure block-by-block
- [x] 5.2 Add the readability/performance balance convention to `AGENTS.md` and mirror it in `openspec/project.md`

## 6. Verification and approval gates

- [x] 6.1 Full gate green (typecheck, lint, format, tests, build, `spec:validate`); real-server check repeated and recorded
- [x] 6.2 Architecture diagram: not regenerated — this change alters no architecture, flow, or component (confirmed against the maintainability spec); note it here
- [ ] 6.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [ ] 6.4 Human approval to archive (rule 0); archive the change after approval

## Baseline evidence (pre-refactor, 2026-09-27)

- `npm test` → 46/46 green (4 suites); typecheck/lint/format/build clean
- Real-server check: `secure-filesystem-server` wrapped, 14 tools, `read_file` 2264 chars, log line:
  `{"timestamp":"2026-09-27T23:50:34.650Z","correlation_id":"11c0a17b-…","caller":{"type":"stdio","identity":"local"},"server":"secure-filesystem-server","tool":"read_file","decision":"allowed","latency_ms":3,"request_bytes":166,"response_bytes":4832,"attempt":1}`

## Verification results — 2026-09-27 (post-refactor)

- `npm test` → 46/46 green, **sin cambios en los tests** (misma suite, mismas aserciones)
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` → limpios
- Real-server check repetido: `secure-filesystem-server`, 14 herramientas, `read_file` 2264 chars; log idéntico en campos al baseline (`latency_ms: 3`, `request_bytes: 166`, `response_bytes: 4832`, `decision: allowed`)
- Spec hygiene: los `## Purpose` de `openspec/specs/stdio-proxy` y `observability` (placeholders del archive) quedaron redactados; `spec:validate` sin warnings
- Diagrama de arquitectura: no regenerado (sin cambio de arquitectura/flujo/componentes)

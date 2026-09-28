# Tasks — `retry-pipeline`

Test-first (rule 11): each delta scenario becomes a failing test before its implementation. Scenario names in parentheses map to `specs/retry-pipeline/spec.md`, `specs/configuration/spec.md`, and `specs/observability/spec.md`.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session** (approved 2026-09-28)

## 1. Configuration foundation (FR-C begins)

- [x] 1.1 Add `yaml@^2` (ISC) and record the license justification
- [x] 1.2 Write failing tests: zero-config defaults, file values apply, per-tool overrides, malformed config error (path + field), unknown top-level warning, CLI flag beats file (red)
- [x] 1.3 Implement `src/config/config.ts` (defaults, YAML load, hand-rolled validation, merge, CLI overrides) until green
- [x] 1.4 Wire config + `--config` / `--timeout-ms` / `--max-attempts` into `run` (options before the separator); config errors exit 2 with an actionable message

## 2. D4 classifier (pure unit loop)

- [x] 2.1 Write failing table tests for every D4 row: pre-execution transport, post-execution transport, timeout, protocol errors, transient server errors, `isError`, `input_required`, cancellation, unknown/non-retryable (red)
- [x] 2.2 Implement `src/pipeline/classify.ts` + `resolveToolPolicy` until green

## 3. Retry pipeline (FR-R1–R2)

- [x] 3.1 Extend the hermetic echo server with failure injection: `flaky` (fails N times with `-32000`, then succeeds), `flaky-protocol` (`-32602`), and per-tool call counters
- [x] 3.2 Write failing tests: default timeout, per-tool timeout override, retry until success, attempt bound, exponential growth with `jitter: false`, jitter within envelope (red)
- [x] 3.3 Implement `src/pipeline/retry.ts` (`runWithRetry`, backoff with injectable sleep) and integrate the loop into `interceptToolCall` (metadata built once per logical call) until green
- [x] 3.4 Write failing tests for the retry gates: timeout retried only for idempotent tools; transient upstream error retried only for idempotent tools; protocol errors never retried; `isError` never retried; non-retryable never retried (red → green)

## 4. Cancellation (FR-R2)

- [x] 4.1 Write failing tests: cancellation aborts the in-flight attempt, stops retries, logs `cancelled`, upstream receives a cancellation notification, and the call is not captured (red)
- [x] 4.2 Implement signal propagation (`ctx.mcpReq.signal` → `RequestOptions.signal`) and the `cancelled` outcome path until green

## 5. Retry-aware observability

- [x] 5.1 Write failing tests: retried success logs `allowed` with attempt count > 1; exhausted retries log `failed` with final attempt count and error; cancelled logs `cancelled` (red)
- [x] 5.2 Make the log line report the real attempt count and total latency until green

## 6. Documentation, ADR, and architecture

- [x] 6.1 Write ADR-0003: the D4 table, the mid-call-crash ambiguity rule, idempotency defaults (FR-R2, D4)
- [x] 6.2 Update the living architecture diagram (`docs/architecture/mcprelay.json` + re-deliver HTML, showcase) to include the retry pipeline
- [x] 6.3 README config section (example `mcprelay.config.yaml`, defaults, flags) + AGENTS status line (M2 done → next M3)

## 7. Verification and approval gates

- [x] 7.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [x] 7.2 Real-server check with config + flag: filesystem server session through the proxy; happy path unchanged; record evidence here
- [x] 7.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [x] 7.4 Human approval to archive (rule 0); archive the change after approval

## Verification results — 2026-09-28 (Node v22.17.0)

- `npm test` → 82/82 green across 7 suites: CLI (9), echo server (10), proxy (21), call logs (6), config (9), classifier (11), retry pipeline (16)
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run spec:validate` → clean
- Real-server gate with config + flag: `secure-filesystem-server`, 14 tools, `read_file` OK through `run --config <file> --max-attempts 2`, log line `allowed`
- D4 taxonomy table tested class by class (pre/post transport, timeout, protocol vs transient upstream errors, isError, input_required, cancellation, unknown)
- Cancellation verified end-to-end: abort + no retry + `cancelled` log + upstream receives `notifications/cancelled`
- `input_required` integration test not feasible on the legacy era (modern-only result vocabulary); covered by the classifier table test (documented in design Open Questions)
- Diagram re-delivered (validate 9/9, visual-check pass); ADR-0003 written

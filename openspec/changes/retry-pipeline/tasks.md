# Tasks — `retry-pipeline`

Test-first (rule 11): each delta scenario becomes a failing test before its implementation. Scenario names in parentheses map to `specs/retry-pipeline/spec.md`, `specs/configuration/spec.md`, and `specs/observability/spec.md`.

## 0. Approval gate (rule 0 — blocks everything below)

- [ ] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**

## 1. Configuration foundation (FR-C begins)

- [ ] 1.1 Add `yaml@^2` (ISC) and record the license justification
- [ ] 1.2 Write failing tests: zero-config defaults, file values apply, per-tool overrides, malformed config error (path + field), unknown top-level warning, CLI flag beats file (red)
- [ ] 1.3 Implement `src/config/config.ts` (defaults, YAML load, hand-rolled validation, merge, CLI overrides) until green
- [ ] 1.4 Wire config + `--config` / `--timeout-ms` / `--max-attempts` into `run` (options before the separator); config errors exit 2 with an actionable message

## 2. D4 classifier (pure unit loop)

- [ ] 2.1 Write failing table tests for every D4 row: pre-execution transport, post-execution transport, timeout, protocol errors, transient server errors, `isError`, `input_required`, cancellation, unknown/non-retryable (red)
- [ ] 2.2 Implement `src/pipeline/classify.ts` + `resolveToolPolicy` until green

## 3. Retry pipeline (FR-R1–R2)

- [ ] 3.1 Extend the hermetic echo server with failure injection: `flaky` (fails N times with `-32000`, then succeeds), `flaky-protocol` (`-32602`), and per-tool call counters
- [ ] 3.2 Write failing tests: default timeout, per-tool timeout override, retry until success, attempt bound, exponential growth with `jitter: false`, jitter within envelope (red)
- [ ] 3.3 Implement `src/pipeline/retry.ts` (`runWithRetry`, backoff with injectable sleep) and integrate the loop into `interceptToolCall` (metadata built once per logical call) until green
- [ ] 3.4 Write failing tests for the retry gates: timeout retried only for idempotent tools; transient upstream error retried only for idempotent tools; protocol errors never retried; `isError` never retried; non-retryable never retried (red → green)

## 4. Cancellation (FR-R2)

- [ ] 4.1 Write failing tests: cancellation aborts the in-flight attempt, stops retries, logs `cancelled`, upstream receives a cancellation notification, and the call is not captured (red)
- [ ] 4.2 Implement signal propagation (`ctx.mcpReq.signal` → `RequestOptions.signal`) and the `cancelled` outcome path until green

## 5. Retry-aware observability

- [ ] 5.1 Write failing tests: retried success logs `allowed` with attempt count > 1; exhausted retries log `failed` with final attempt count and error; cancelled logs `cancelled` (red)
- [ ] 5.2 Make the log line report the real attempt count and total latency until green

## 6. Documentation, ADR, and architecture

- [ ] 6.1 Write ADR-0003: the D4 table, the mid-call-crash ambiguity rule, idempotency defaults (FR-R2, D4)
- [ ] 6.2 Update the living architecture diagram (`docs/architecture/mcprelay.json` + re-deliver HTML, showcase) to include the retry pipeline
- [ ] 6.3 README config section (example `mcprelay.config.yaml`, defaults, flags) + AGENTS status line (M2 done → next M3)

## 7. Verification and approval gates

- [ ] 7.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [ ] 7.2 Real-server check with config + flag: filesystem server session through the proxy; happy path unchanged; record evidence here
- [ ] 7.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [ ] 7.4 Human approval to archive (rule 0); archive the change after approval

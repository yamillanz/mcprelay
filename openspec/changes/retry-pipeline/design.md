## Context

M1's bridge performs exactly one attempt per `tools/call` and logs `attempt: 1` unconditionally. There is no timeout and no retry discipline. M2 adds the honest failure layer: timeout, bounded exponential-backoff retries, and the D4 failure-class taxonomy — the taxonomy table is this change's design deliverable (PRD §14 D4) and is recorded in ADR-0003.

The v2 SDK gives the seam we need: `RequestOptions` carries `timeout`, `signal`, and `onprogress`; failures surface as `ProtocolError` (JSON-RPC code) or `SdkError` (`SdkErrorCode.RequestTimeout`, `ConnectionClosed`); the client-facing `Server` aborts the handler's `ctx.mcpReq.signal` on `notifications/cancelled`.

Config must be honest too: YAML with safe defaults (FR-C1/C2 begin here), validated by hand with precise messages, and CLI flags that override file values.

## Goals / Non-Goals

**Goals**

- Every failed attempt is classified per the D4 table; retries happen only where side-effect risk allows.
- Timeout and retry bounds are configurable globally and per tool.
- Client cancellation aborts the in-flight attempt, stops retries, logs `cancelled`, and never captures.
- The single call log line reports the real attempt count and the final decision.
- The hermetic echo server can fail on purpose (flaky tool) so the pipeline is tested, not assumed.
- ADR-0003 + updated architecture diagram + README config section.

**Non-Goals**

- DLQ capture and replay (M3/M4), policy (M5), `validate` command (M3), redaction config (M3), HTTP (M6).
- Circuit breakers, adaptive retry budgets, per-error-code retry overrides beyond the table.
- Any change to passthrough behavior: only `tools/call` gets timeout/retry.

## Decisions

### D1 — The attempt loop lives in the pipeline, not the bridge

`src/pipeline/retry.ts` exposes `runWithRetry({ attempt, classify, policy, sleep })`, where `attempt` performs one upstream call and returns a typed outcome, and `sleep` is injectable (tests use a fake clock). `interceptToolCall` builds the call metadata **once per logical call** (same `correlation_id` across attempts), then loops. One log line is written after the loop ends.

Rejected: retry inside `createRelayRequest` (would retry passthrough calls too, which FR-R2 does not ask for) and retry inside the transport (cannot see the tool policy).

### D2 — D4 taxonomy (normative table)

| Signal from the attempt | Class | Retry rule | Notes |
|---|---|---|---|
| Transport not connected before send, spawn failed, or send failed | `transport_pre_execution` | Retry unconditionally | The request provably never reached the tool (FR-R2) |
| Connection closed after the request was sent | `transport_post_execution` | Retry only if `idempotent: true` | Mid-call crash is ambiguous: it may have executed; the conservative rule wins |
| SDK `RequestTimeout` | `timeout` | Retry only if `idempotent: true` | A timeout does not mean "not executed" (FR-R2) |
| JSON-RPC error `-32700`, `-32600`, `-32601`, `-32602` | `non_retryable` | Never | Structural/protocol errors; retrying cannot help |
| JSON-RPC error `-32603` or server errors `-32000..-32099` | `upstream_error` | Retry only if `idempotent: true` | Transient server-side failures |
| Result with `isError: true` | `tool_error` | Never | Completed call; logged and counted (DLQ capture opt-in arrives M3) |
| Result with `resultType: "input_required"` | `input_required` | Never (not a failure) | In-progress conversation; relayed unchanged; the follow-up passes through the same pipeline |
| `AbortError` / `signal.aborted` | `cancelled` | Never | Abort in-flight, stop retries, log `cancelled`, no capture |
| Any other error (capability, schema, unknown) | `non_retryable` | Never | Fail honest, relay the error |

Idempotency resolution: `reliability.idempotent_default` (default `false`) with per-tool `reliability.per_tool.<tool>.idempotent` override. Defaults are deliberately conservative.

### D3 — Timeout mechanism

Each attempt passes `timeout: policy.timeoutMs` to `upstream.request` via `RequestOptions`; the SDK owns the timer, clears handlers on expiry, and surfaces `SdkErrorCode.RequestTimeout`. No second timer is added. Default timeout: 30 000 ms (PRD Appendix B), per-tool override `per_tool.<tool>.timeout_ms`.

### D4 — Backoff

Exponential with full jitter: delay before attempt n+1 is `base_ms × 2^(n-1)` (n = the attempt that just failed), capped at a fixed 30 s; when `jitter: true` (default) the actual delay is uniform in `[0, delay]`. `jitter: false` exists so tests can assert exact exponential growth. Backoff runs only on failure paths — the success path adds nothing (NFR-3).

### D5 — Config load and merge order

`defaults ← file (default `./mcprelay.config.yaml`, or `--config <path>`) ← CLI flags (`--timeout-ms`, `--max-attempts`)`.

- YAML parsed with `yaml@^2` (ISC, the only new dependency); shape validated by hand with precise messages (`reliability.retry.max_attempts: expected integer >= 1, got "three"`).
- Unknown **top-level** sections → warning (forward compatibility with `policy`, `queue`, `store`, `redaction` landing later). Unknown keys **inside** `reliability`, `retry`, or `per_tool.<tool>` → error (a typo there silently changes reliability behavior).
- Config errors abort startup with exit code 2 (usage/config error) and no upstream spawn. A missing default file means defaults; a missing file at an explicit `--config` path is an error.
- `run` accepts options before the separator: `mcprelay run --timeout-ms 5000 -- <cmd>` and `mcprelay --timeout-ms 5000 -- <cmd>`.

### D6 — Cancellation propagation

The client-facing `Server` aborts `ctx.mcpReq.signal` on `notifications/cancelled`. `createRelayRequest` forwards that signal to `upstream.request` (`RequestOptions.signal`), so the in-flight attempt is aborted. The loop stops on `AbortError`, logs `cancelled`, and rethrows so the SDK settles the handler (a cancelled request gets no response). If the SDK does not emit the upstream cancellation notification itself, the bridge sends `notifications/cancelled` for the attempt (verified during apply; the hermetic test asserts the upstream received it).

### D7 — Log line

One line per logical call, written after the loop: `attempt` = attempts actually made, `latency_ms` = total including backoff, `decision` = `allowed` / `failed` / `cancelled`, `error` = final failure when applicable. No new log fields; the M1 `attempt` field simply becomes real.

### D8 — Module layout (same-file helpers per the readability rule)

```
src/config/config.ts     — types, defaults, YAML load, validation, merge, CLI overrides
src/pipeline/classify.ts — D4 classifier (pure function over attempt outcomes)
src/pipeline/retry.ts    — runWithRetry + backoff (sleep injectable)
src/proxy/bridge.ts      — integration: resolve policy, loop, log
```

`src/config/` and `src/pipeline/` are already in the AGENTS target layout; no other modules are added.

### D9 — Test strategy (rule 11)

- **Unit, tight loop:** `classifyAttempt` table (every D4 row, including `input_required` and cancellation); `resolveToolPolicy` merge; config parsing/validation/merge/CLI overrides.
- **Integration (hermetic):** the echo server gains `flaky` (returns `-32000` N times, then succeeds) and `flaky-protocol` (`-32602`) tools; timeout via `sleep` + small timeout; retry bound; deterministic backoff (`jitter: false`, small `base_ms`); cancellation via the raw client; upstream notification assertion via `x/notifications`.
- **Real-server gate (rule 10):** filesystem server with a config file and one CLI flag; the happy path is unchanged.
- **Diagram/ADR:** architecture diagram adds the retry pipeline; ADR-0003 records the table and the ambiguous-crash rule.

## Risks / Trade-offs

- **Timeout retries can duplicate side effects** (the abandoned attempt may still execute upstream) → idempotent gating + documented; DLQ/replay adds dry-run warnings later.
- **Mid-call crash ambiguity** → conservative idempotent gate, recorded in ADR-0003.
- **SDK timeout/cancellation semantics may differ from assumptions** → pinned by tests; open questions below resolved in apply.
- **Config strictness vs forward compatibility** → unknown top-level warns; typos inside known sections error.
- **Retrying against a dead upstream wastes attempts** → bounded and fast-failing; acceptable.

## Open Questions

- Exact `SdkErrorCode` names/values to match in the classifier (verify in apply).
- Whether the SDK sends `notifications/cancelled` upstream on abort, or the bridge must send it.
- Whether the hermetic legacy server can produce an `input_required` result for an integration test; if not, the classifier unit test carries that scenario.

# ADR-0003 — Failure classification and retry discipline (D4)

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-09-28 |
| **Milestone** | M2 `retry-pipeline` |
| **PRD refs** | FR-R1, FR-R2, §6.3, §14 D4 |

## Context

M2 adds timeout and retries around `tools/call`. Retrying a call that already executed can duplicate side effects, so retry eligibility cannot be heuristic "it looked transient" guessing. The PRD D4 decision requires a class table covering pre-execution transport failures, post-execution failures (upstream errors and timeouts), `isError` results, `input_required` results, non-retryable errors, and client cancellation — with the table itself as the M2 design deliverable. This ADR records the table and the reasoning behind its conservative edges.

## Decisions

### D1 — The taxonomy table (normative)

| Signal from one attempt | Class | Retry rule | Why |
|---|---|---|---|
| Transport not connected before send, spawn failed, or send failed (`SdkErrorCode.NotConnected` / `SendFailed`, or the pre-send guard) | `transport_pre_execution` | Retry unconditionally | The request provably never reached the tool (FR-R2) |
| Connection closed after the request was sent (`SdkErrorCode.ConnectionClosed`) | `transport_post_execution` | Retry only if `idempotent: true` | Mid-call crash is ambiguous: the tool may have executed. The conservative gate wins over the convenience of a retry |
| `SdkErrorCode.RequestTimeout` | `timeout` | Retry only if `idempotent: true` | A timeout does not mean "not executed" (FR-R2) |
| JSON-RPC `-32700`, `-32600`, `-32601`, `-32602` | `non_retryable` | Never | Structural/protocol errors; a retry cannot change the outcome |
| JSON-RPC `-32603` or `-32000..-32099` | `upstream_error` | Retry only if `idempotent: true` | Server-side failures are plausibly transient, but the tool may have side-effected |
| Result with `isError: true` | `tool_error` | Never | A completed call that reported failure; retrying duplicates work (DLQ capture becomes opt-in in M3) |
| Result with `resultType: "input_required"` | `input_required` | Never (not a failure) | An in-progress conversation, relayed unchanged; the follow-up passes through the same pipeline |
| `AbortError` / handler signal aborted | `cancelled` | Never | The client withdrew the request; abort in-flight, stop retries, log `cancelled`, never capture |
| Anything else (capability, schema, unknown) | `non_retryable` | Never | Fail honest and relay the error |

### D2 — Idempotency is opt-in, per tool

`reliability.idempotent_default` defaults to `false`; `reliability.per_tool.<tool>.idempotent` overrides it. Tools are assumed to have side effects unless the operator says otherwise — the safe default for a middleware whose promise is "side-effect risk is never guessed".

### D3 — Timeout mechanism

Each attempt passes its timeout to the SDK request (`RequestOptions.timeout`); the SDK owns the timer, clears handlers on expiry, and raises `RequestTimeout`. No second timer is added. Default 30 s, per-tool override `per_tool.<tool>.timeout_ms`.

### D4 — Backoff

Exponential with full jitter: delay before the next attempt is `base_ms × 2^(n-1)` (n = the attempt that just failed), capped at 30 s; with jitter enabled the actual delay is uniform in `[0, delay]`. `jitter: false` exists for deterministic tests. Backoff runs only on failure paths, so the success path is untouched (NFR-3).

### D5 — Cancellation propagates through the handler signal

The client-facing SDK server aborts the handler's `ctx.mcpReq.signal` on `notifications/cancelled`; the bridge forwards that signal to the upstream request, which aborts the in-flight attempt and emits the upstream cancellation notification. The attempt wrapper detects the abort (`signal.aborted` / `AbortError`) and classifies it `cancelled` — terminal, never retried, never captured.

### D6 — One log line per logical call

The loop writes exactly one structured line after it ends: `attempt` = attempts actually made, `latency_ms` = total including backoff, `decision` = `allowed` / `failed` / `cancelled`, and the final error when applicable. `input_required` results log `allowed` (not a failure).

## Alternatives rejected

- **Retry by error-message heuristics** (e.g., matching "timeout" in text): brittle and locale-dependent; the class must come from typed signals.
- **Retry everything with a fixed count** (the common library default): silently duplicates side effects; violates the product's core promise.
- **Optimistic mid-call-crash retry**: a crash after send may follow a completed write; treated as post-execution instead.
- **Circuit breaker / adaptive budgets**: out of scope for v1 (no measured need; would add state and config surface).
- **Retry inside the transport**: cannot see per-tool policy, and would also retry passthrough calls that FR-R2 does not cover.

## Consequences

- Timeout retries of idempotent tools can still duplicate work when the abandoned attempt completes upstream; this is inherent to timeouts and is documented (M4's replay `--dry-run` and idempotency guard add further warnings).
- The classifier is a pure function with table tests, so future classes (M3 DLQ capture, M5 policy denials) extend the table without touching the loop.
- `attempt` in the call log becomes real; the M1 observability requirement is extended by this change.

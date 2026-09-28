# retry-pipeline Specification

## Purpose
Timeout, bounded exponential-backoff retries, and the D4 failure-class taxonomy gating retries by side-effect risk, including client cancellation semantics.
## Requirements
### Requirement: Call timeout

Each `tools/call` SHALL have a configurable timeout (global default with per-tool override). When an attempt exceeds its timeout the attempt SHALL fail as a `timeout` and enter the retry pipeline; when the call ultimately fails, the client SHALL receive a standard MCP error.

#### Scenario: Default timeout applies
- **WHEN** a call exceeds the global timeout
- **THEN** the attempt is abandoned, classified as `timeout`, and the pipeline decides whether to retry

#### Scenario: Per-tool timeout overrides the global one
- **WHEN** a tool has a per-tool `timeout_ms`
- **THEN** its calls use that value instead of the global timeout

#### Scenario: Unresolved timeout returns a standard error
- **WHEN** a timeout is not retryable (the tool is not idempotent)
- **THEN** the client receives a standard MCP error and the call is logged as failed with one attempt

### Requirement: Bounded retry with exponential backoff

Retryable failures SHALL be retried with exponential backoff and jitter, bounded by a configurable maximum number of attempts (global with per-tool override). The number of upstream attempts SHALL never exceed the bound, and each attempt SHALL be a separate upstream call.

#### Scenario: Retry until success
- **WHEN** a retryable failure is followed by a successful attempt
- **THEN** the client receives the successful result and the log reports the attempts used

#### Scenario: Attempt bound is respected
- **WHEN** every attempt fails
- **THEN** the number of upstream calls equals `max_attempts` and the client receives a standard MCP error

#### Scenario: Exponential growth without jitter
- **WHEN** jitter is disabled
- **THEN** the delay before attempt n is `base_ms × 2^(n-2)` (exponential growth)

#### Scenario: Jitter stays within the exponential envelope
- **WHEN** jitter is enabled (the default)
- **THEN** each delay is at most the un-jittered exponential delay for that attempt

### Requirement: Failure classification and retry gating

Every failed attempt SHALL be classified per the D4 taxonomy and retried only when the class and the tool policy allow it: pre-execution transport failures retry unconditionally; timeouts retry only when the tool is `idempotent: true`; upstream error responses retry only when the tool is idempotent and the error is not a non-retryable protocol error (parse, invalid request, method not found, invalid params); `isError: true` results never retry; `input_required` results are not failures; non-retryable errors never retry; client cancellation aborts and never retries.

#### Scenario: Pre-execution transport failure is retried unconditionally
- **WHEN** the request provably never reached the tool (transport not connected before send, or the send failed)
- **THEN** the attempt is classified as a pre-execution transport failure and retried up to the bound regardless of idempotency

#### Scenario: Timeout retries only for idempotent tools
- **WHEN** an idempotent tool times out
- **THEN** it is retried; when a non-idempotent tool times out, it is not retried

#### Scenario: Upstream error retries only for idempotent tools
- **WHEN** an idempotent tool returns a transient server error
- **THEN** it is retried until success or the bound; when a non-idempotent tool returns the same error, it is not retried

#### Scenario: Protocol errors are never retried
- **WHEN** the upstream returns a protocol error such as `-32602` invalid params
- **THEN** it is not retried even for an idempotent tool

#### Scenario: isError results are never retried
- **WHEN** the tool executes and returns `isError: true`
- **THEN** exactly one upstream call is made, the result is relayed, and the call is logged as failed

#### Scenario: input_required is not a failure
- **WHEN** the upstream returns an `input_required` result
- **THEN** it is classified as not-a-failure, relayed unchanged, and never retried

#### Scenario: Non-retryable errors are not retried
- **WHEN** an attempt fails with a non-retryable error (for example a capability or schema error)
- **THEN** no retry occurs and the error is relayed to the client

### Requirement: Client cancellation

On `notifications/cancelled` for the in-flight request, the middleware SHALL abort the in-flight upstream attempt, stop the retry pipeline, log decision `cancelled`, and SHALL NOT retry or capture the call.

#### Scenario: Cancellation aborts and stops retries
- **WHEN** the client cancels an in-flight call
- **THEN** the in-flight upstream attempt is aborted and no further attempts are made

#### Scenario: Cancelled decision is logged
- **WHEN** a call is cancelled
- **THEN** its single log line reports decision `cancelled` with the attempts used

#### Scenario: Upstream is notified of the cancellation
- **WHEN** the client cancels
- **THEN** the upstream receives a cancellation notification for the attempt

#### Scenario: Cancelled calls are never captured
- **WHEN** a call is cancelled
- **THEN** it never enters the failure store (no DLQ capture; the DLQ arrives in a later change)


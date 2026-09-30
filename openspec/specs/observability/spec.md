# observability Specification

## Purpose
The structured observability surface: one JSON log line per intercepted `tools/call`, carrying correlation, latency, payload sizes, decision, and error.
## Requirements
### Requirement: One structured log line per intercepted call

Every intercepted `tools/call` SHALL emit exactly one structured JSON log line on stderr containing: timestamp, correlation id (plus OTel trace context when present), caller, server, tool, decision, latency_ms, request and response payload sizes, attempt count, and error when applicable. `decision` SHALL be one of `allowed` | `denied` | `failed` | `cancelled`; this change implements `allowed` and `failed` (the others are emitted by later changes). Secrets SHALL be redacted before persistence; at this stage the log line carries no argument values.

#### Scenario: Success line
- **WHEN** an intercepted call succeeds
- **THEN** exactly one JSON line is emitted on stderr with decision `allowed`, latency_ms greater than or equal to 0, attempt count 1, payload sizes greater than 0, and no error

#### Scenario: Failure line
- **WHEN** an intercepted call fails through an upstream error, an `isError: true` result, or a transport failure
- **THEN** exactly one JSON line is emitted with decision `failed` and an error field; an `isError: true` result is logged as failed and is never retried

#### Scenario: No argument values in logs
- **WHEN** a call's arguments contain secret-looking values
- **THEN** the log line contains no argument values (only payload sizes at this stage; redaction configuration arrives with later changes)

#### Scenario: Caller attribution
- **WHEN** a call is intercepted over stdio
- **THEN** the line carries a caller object with `type: "stdio"` and an identity value (placeholder at this stage; API-key identities land in a later change)

#### Scenario: Machine-readable lines
- **WHEN** logs are emitted
- **THEN** each line is a single valid JSON object on its own line, parseable independently of the others

### Requirement: Retry-aware call log

The single structured log line per intercepted call SHALL report the number of attempts actually made and the final decision. A call that succeeds after retries SHALL log `allowed` with an attempt count greater than 1; a call that exhausts its attempts SHALL log `failed` with the final attempt count and the final error; a call cancelled by the client SHALL log `cancelled`.

#### Scenario: Retried success is logged with the real attempt count
- **WHEN** a call succeeds on a retry
- **THEN** exactly one log line reports decision `allowed` and the attempt count actually used

#### Scenario: Exhausted retries are logged as failed
- **WHEN** every attempt fails
- **THEN** the log line reports decision `failed`, the final attempt count, and the final error

#### Scenario: Cancelled calls are logged as cancelled
- **WHEN** the client cancels an in-flight call
- **THEN** the log line reports decision `cancelled` and the attempt count used

### Requirement: Policy decision in the call log

The structured call log SHALL carry the policy outcome: a denied call logs decision `denied` with zero attempts and the denial reason, and a call evaluated under `--policy-dry-run` logs the would-be decision with `enforced: false` so it can never be confused with an enforced denial.

#### Scenario: Enforced denial is logged
- **WHEN** a call is denied by policy
- **THEN** the log line reports decision `denied`, attempt 0, and the matched rule

#### Scenario: Dry-run denial is marked unenforced
- **WHEN** a call would be denied under `--policy-dry-run`
- **THEN** the log line reports the would-be decision with `enforced: false` and the call is forwarded


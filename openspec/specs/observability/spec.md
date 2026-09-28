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


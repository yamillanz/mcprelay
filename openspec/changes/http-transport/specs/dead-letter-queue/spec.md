## MODIFIED Requirements

### Requirement: FailureRecord contents

The persisted record SHALL contain: `id` (ULID), `correlation_id`, `captured_at`, `caller {type, identity}`, `server {name, command, transport}`, `tool {name, arguments_hash, arguments}`, `failure {class, message, attempts}`, and `replay {status, attempts, last_outcome}`. `server.transport` SHALL be `stdio` or `http`; for `http` records `server.command` SHALL hold the endpoint URL. Records written before this field existed SHALL read as `stdio`. `arguments_hash` SHALL be sha256 over the **raw** arguments; persisted `arguments` SHALL be redacted.

#### Scenario: The full record shape is persisted
- **WHEN** a failure is captured
- **THEN** every field above is present (including `server.transport`), `replay.status` is `pending`, and `id` sorts lexicographically by capture time (ULID)

#### Scenario: The correlation id matches the call log
- **WHEN** a captured call has a log line
- **THEN** the record's `correlation_id` equals the log line's correlation id

#### Scenario: Failure classes map from the D4 taxonomy
- **WHEN** failures of each class are captured
- **THEN** `failure.class` is one of `transport`, `timeout`, `upstream_error`, `non_retryable`, `tool_error` (pre/post-execution transport both map to `transport`)

#### Scenario: HTTP records carry their transport
- **WHEN** a failure is captured while wrapping an HTTP upstream
- **THEN** `server.transport` is `http` and `server.command` is the endpoint URL

#### Scenario: Legacy records migrate in place
- **WHEN** a database created before this field existed is opened
- **THEN** its records read `server.transport: stdio` and remain listable

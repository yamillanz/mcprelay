## MODIFIED Requirements

### Requirement: Dry-run inspection with zero side effects

`mcprelay replay run <id> --dry-run` SHALL load the record, connect to the stored upstream **over the record's transport** (the stored stdio command, or the recorded HTTP endpoint with the current config's `upstream.http.headers`), list tools, and report whether the tool still exists, the dedup status, the per-tool `effects: read` hint, and the redacted arguments. It SHALL perform **zero** `tools/call` upstream calls.

#### Scenario: Dry-run performs no upstream tool calls
- **WHEN** `--dry-run` runs for a captured record
- **THEN** the upstream receives no `tools/call` and the record remains `pending`

#### Scenario: Missing tool is reported
- **WHEN** the stored tool no longer exists upstream
- **THEN** the dry-run reports it and exits non-zero

#### Scenario: Read-only hint is reported
- **WHEN** the tool is configured with `effects: read`
- **THEN** the dry-run warns that a read-only tool is rarely worth replaying

#### Scenario: Duplicate risk is reported
- **WHEN** the idempotency guard finds a successful execution within the dedup window
- **THEN** the dry-run reports that `--force` would be required

#### Scenario: HTTP dry-run reconnects over HTTP
- **WHEN** the record's transport is `http`
- **THEN** the dry-run connects to the recorded endpoint with the current config's headers, lists tools, and makes no `tools/call`

### Requirement: Replay execution and result capture

`mcprelay replay run <id>` SHALL claim the record atomically, re-execute the stored call against a fresh upstream connection **using the record's transport** (stdio command or HTTP endpoint with the current config's `upstream.http.headers`), and capture the replay's own **redacted** result or error into the record's `replay.last_outcome` and an audit entry linking the original record to the replay attempt. The record SHALL be resolved (`replayed`). Replay is a single attempt with the tool's configured timeout and no retries.

#### Scenario: Replay re-executes and the side effect lands
- **WHEN** `run` executes a captured call against a healthy upstream
- **THEN** the upstream receives exactly one `tools/call` with the record's tool and arguments, and the CLI reports success

#### Scenario: The replay result is captured redacted
- **WHEN** the replay succeeds or fails
- **THEN** `replay.last_outcome` and an audit entry (kind `replayed`, linking correlation id and failure id) hold the redacted result or error

#### Scenario: The record is resolved
- **WHEN** the replay completes
- **THEN** the record's status is no longer `pending` and it no longer appears in `--status pending` listings

#### Scenario: Replay does not retry
- **WHEN** the replay attempt fails
- **THEN** exactly one upstream call was made and the error is captured

#### Scenario: HTTP record re-executes over HTTP
- **WHEN** the record's transport is `http` and `run` executes it
- **THEN** the recorded endpoint receives exactly one `tools/call` with the record's tool and arguments

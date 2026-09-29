## ADDED Requirements

### Requirement: Dry-run inspection with zero side effects

`mcprelay replay run <id> --dry-run` SHALL load the record, connect to the stored server command, list tools, and report whether the tool still exists, the dedup status, the per-tool `effects: read` hint, and the redacted arguments. It SHALL perform **zero** `tools/call` upstream calls. Policy re-evaluation is documented as arriving with the policy engine.

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

### Requirement: Replay execution and result capture

`mcprelay replay run <id>` SHALL claim the record atomically, re-execute the stored call against a fresh upstream connection, and capture the replay's own **redacted** result or error into the record's `replay.last_outcome` and an audit entry linking the original record to the replay attempt. The record SHALL be resolved (`replayed`). Replay is a single attempt with the tool's configured timeout and no retries.

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

### Requirement: Redacted-argument guard

When the stored arguments contain redaction markers, `run` SHALL refuse to execute unless the operator supplies overrides via `--set key=value` (repeatable, top-level keys). Overrides SHALL replace only the named keys; if any marker remains, the run SHALL refuse.

#### Scenario: Refusal without overrides
- **WHEN** the stored arguments contain `[REDACTED]` and no `--set` is given
- **THEN** the run refuses with a clear message and makes no upstream call

#### Scenario: Overrides fill the redacted keys
- **WHEN** `--set` supplies the missing values for every marker
- **THEN** the run proceeds with the overridden arguments

#### Scenario: Remaining markers refuse the run
- **WHEN** `--set` covers only some of the markers
- **THEN** the run refuses and lists the keys still missing

### Requirement: Idempotency guard

Replay SHALL detect a previously successful execution of the same idempotency key — `_meta.idempotencyKey` or an args `idempotency_key`/`idempotencyKey` field — and, when no key exists, fall back to the record's arguments hash. A successful execution within `reliability.replay.dedup_window` SHALL require `--force` to re-execute; `--force` SHALL proceed and record the new execution.

#### Scenario: Duplicate within the window requires force
- **WHEN** the same key succeeded within the dedup window and `--force` is absent
- **THEN** the run refuses, names the previous execution, and makes no upstream call

#### Scenario: Force proceeds and records the execution
- **WHEN** `--force` is given
- **THEN** the call executes and the new execution is recorded

#### Scenario: Outside the window no force is needed
- **WHEN** the previous execution is older than the dedup window
- **THEN** the run proceeds without `--force`

#### Scenario: Hash fallback without a key
- **WHEN** the call carries no idempotency key and the same arguments hash succeeded within the window
- **THEN** the guard treats it as a duplicate

### Requirement: Successful keyed executions are indexed

When an intercepted `tools/call` succeeds and carries an idempotency key, the middleware SHALL record the execution (key, tool, arguments hash, timestamp) in the queue database so replay can detect duplicates. Calls without a key are not indexed.

#### Scenario: Keyed success is indexed
- **WHEN** a keyed call succeeds through the proxy
- **THEN** an execution entry exists for its key

#### Scenario: Unkeyed success is not indexed
- **WHEN** a call without a key succeeds
- **THEN** no execution entry is written

### Requirement: Concurrent replay safety

`run` SHALL claim the record with a lease before executing. Of concurrent runs for the same record, exactly one SHALL execute; the other SHALL exit non-zero with a clear message. A claim whose lease has expired MAY be reclaimed.

#### Scenario: Only one concurrent run executes
- **WHEN** two `run` invocations race for the same pending record
- **THEN** exactly one performs the upstream call and the other exits non-zero

#### Scenario: Expired lease is reclaimable
- **WHEN** a claim is older than its lease
- **THEN** a new run may claim and execute the record

# replay-cli Specification

## Purpose
Replay as redrive for side effects: dry-run inspection with zero upstream calls, replay execution with redacted result capture into the audit trail, the redacted-argument guard (--set), the idempotency/dedup guard with --force, and concurrent-replay safety via atomic claim/lease.
## Requirements
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

### Requirement: Batch replay

`mcprelay replay run --all` SHALL redrive pending records in batch, selected with the `list` filters (`--tool`, `--correlation-id`, `--since`, `--until`, `--limit`; default limit 50, maximum 500). Selection SHALL always be `status: pending`. `--dry-run` SHALL inspect each selected record with zero upstream `tools/call`; `--force` SHALL apply to every selected record; `--json` SHALL emit one machine-readable summary. `--set` with `--all` and a positional record id with `--all` SHALL be usage errors. Execution SHALL be sequential, and each record SHALL pass through the same guard → claim → attempt → persist sequence as `run <id>`, so concurrent batch runs — or a batch plus a single run — SHALL never execute the same record twice. A record that fails a guard or is claimed elsewhere SHALL be reported and skipped, remaining pending.

#### Scenario: Batch selects pending records with filters
- **WHEN** `run --all --tool X --since <iso>` runs
- **THEN** exactly the pending records matching the filters are attempted, in index order

#### Scenario: Batch and single forms are mutually exclusive
- **WHEN** `run --all` is combined with `--set` or with a positional id
- **THEN** it is a usage error and nothing is executed

#### Scenario: Batch dry-run makes no upstream calls
- **WHEN** `run --all --dry-run` runs
- **THEN** every selected record is inspected, the upstream receives no `tools/call`, and the records remain pending

#### Scenario: Per-record outcomes and summary
- **WHEN** a batch completes
- **THEN** each record reports its outcome and a summary line reports selected, ok, failed, and skipped counts

#### Scenario: Exit codes are CI-meaningful
- **WHEN** a batch completes with every attempted record successful (or with no matching records)
- **THEN** it exits 0; when any record failed or was skipped it exits non-zero

#### Scenario: Concurrent batches never double-execute
- **WHEN** two `run --all` invocations (or a batch and a single run) race for the same pending record
- **THEN** the record is executed at most once and the loser reports it as claimed/skipped

#### Scenario: JSON summary is machine-readable
- **WHEN** `run --all --json` runs
- **THEN** the output is a single parseable JSON document with the summary and per-record outcomes


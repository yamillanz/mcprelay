# dead-letter-queue Specification

## Purpose
Durable, redacted capture of failed tool calls before the client sees the error, the FailureRecord shape, the QueueProvider port with its SQLite adapter (atomic resolve, filters, purge, health, restart durability), and replay list/inspect inspection.
## Requirements
### Requirement: Durable capture before the error

When a `tools/call` ultimately fails (attempts exhausted, timeout, or a non-retryable error), the middleware SHALL durably enqueue a `FailureRecord` **before** returning the error to the client. Killing the middleware immediately after the error response SHALL leave the record persisted and listable after restart.

#### Scenario: Exhausted retries are captured before the client sees the error
- **WHEN** a call fails after its retry bound
- **THEN** the client receives the standard MCP error only after the record is durably written, and `replay list` shows the record

#### Scenario: A non-retryable failure is captured
- **WHEN** a call fails with a non-retryable class
- **THEN** it is captured with its failure class and attempts used

#### Scenario: Killing the middleware after the error leaves the record persisted
- **WHEN** the middleware is killed immediately after returning an error and a new process lists the queue
- **THEN** the record is present (durability, NFR-5)

#### Scenario: Successful and cancelled calls are never captured
- **WHEN** a call succeeds or is cancelled by the client
- **THEN** no record is written

### Requirement: FailureRecord contents

The persisted record SHALL contain: `id` (ULID), `correlation_id`, `captured_at`, `caller {type, identity}`, `server {name, command}`, `tool {name, arguments_hash, arguments}`, `failure {class, message, attempts}`, and `replay {status, attempts, last_outcome}`. `arguments_hash` SHALL be sha256 over the **raw** arguments; persisted `arguments` SHALL be redacted.

#### Scenario: The full record shape is persisted
- **WHEN** a failure is captured
- **THEN** every field above is present, `replay.status` is `pending`, and `id` sorts lexicographically by capture time (ULID)

#### Scenario: The correlation id matches the call log
- **WHEN** a captured call has a log line
- **THEN** the record's `correlation_id` equals the log line's correlation id

#### Scenario: Failure classes map from the D4 taxonomy
- **WHEN** failures of each class are captured
- **THEN** `failure.class` is one of `transport`, `timeout`, `upstream_error`, `non_retryable`, `tool_error` (pre/post-execution transport both map to `transport`)

### Requirement: Secrets never persist in the clear

Configured redaction patterns SHALL be applied to persisted arguments and failure messages before writing. The `arguments_hash` SHALL be computed over the raw (unredacted) arguments so dedup stays stable.

#### Scenario: Sensitive keys are redacted in persisted arguments
- **WHEN** arguments contain `api_key`, `token`, `password`, `authorization`, `secret`, or `credential` (any nesting depth)
- **THEN** the persisted arguments replace those values with a redaction marker and the raw values appear nowhere in the DB

#### Scenario: Redaction patterns are configurable
- **WHEN** `redaction.patterns` adds a custom key
- **THEN** that key is redacted too

#### Scenario: Failure messages are masked
- **WHEN** a failure message echoes a `key=value`-style secret for a configured pattern
- **THEN** the persisted message masks the value

#### Scenario: The hash is stable across redaction
- **WHEN** the same raw arguments are captured twice
- **THEN** `arguments_hash` is identical, independent of redaction

### Requirement: QueueProvider port and SQLite adapter

DLQ persistence SHALL sit behind the `QueueProvider` port (`enqueue`, `list`, `get`, `resolve`, `purge`, `health`, `claim`, `release`), selected by `queue.provider` (only `sqlite` at this milestone). The SQLite adapter SHALL be durable, use WAL and `busy_timeout`, and allow the middleware and the `replay` CLI to share the DB files. `resolve` SHALL be atomic: of concurrent resolvers, exactly one wins. `claim(id, leaseMs)` SHALL be an atomic guarded update that marks a pending record as claimed for the lease duration, so concurrent replays cannot both execute it; a claim whose lease expired MAY be reclaimed; `release(id)` SHALL clear a claim on a still-pending record (for example when the replay fails before executing). The adapter SHALL also expose the idempotency index (`recordExecution` and `lastExecution`) over the same database.

#### Scenario: Enqueue, get, and list with filters
- **WHEN** records exist and a caller lists by status, tool, correlation id, or time range
- **THEN** exactly the matching records are returned, and `get(id)` returns one record or null

#### Scenario: Atomic resolve
- **WHEN** two callers resolve the same pending record concurrently
- **THEN** exactly one succeeds and the other observes that the record was already resolved

#### Scenario: Atomic claim with lease
- **WHEN** two callers claim the same pending record concurrently
- **THEN** exactly one succeeds, and the loser observes that the record is already claimed

#### Scenario: Expired claim is reclaimable
- **WHEN** a claim is older than its lease and the record is still pending
- **THEN** a new claim succeeds

#### Scenario: Claim is released before execution
- **WHEN** a claimed replay fails before reaching the tool and calls `release`
- **THEN** the record is pending and claimable again

#### Scenario: Idempotency index round-trip
- **WHEN** an execution is recorded and later queried by key
- **THEN** the adapter returns its tool, arguments hash, and timestamp

#### Scenario: Purge removes matching records
- **WHEN** `purge` runs with a filter
- **THEN** it returns the number removed and the records no longer list

#### Scenario: Health reports the provider and path
- **WHEN** `health()` is called
- **THEN** it reports ok with the provider name and the database path

#### Scenario: Records survive reopening the database
- **WHEN** the adapter is closed and reopened against the same file
- **THEN** every previously enqueued record is still present (restart durability)

#### Scenario: WAL and busy timeout are configured
- **WHEN** the adapter opens the database
- **THEN** `journal_mode` is `wal` and `busy_timeout` is set

### Requirement: Replay inspection CLI

`mcprelay replay list` SHALL list captured records with filters and both human and `--json` output; `mcprelay replay inspect <id>` SHALL print one record. Both SHALL read the same database the middleware writes, using the same config resolution.

#### Scenario: Listing shows the captured failure
- **WHEN** a record exists and `replay list` runs
- **THEN** the output shows its id, correlation id, tool, failure class, attempts, and replay status

#### Scenario: Inspecting one record
- **WHEN** `replay inspect <id>` runs for an existing record
- **THEN** the full record is printed, including the redacted arguments

#### Scenario: Unknown id exits non-zero
- **WHEN** `replay inspect` is given an id that does not exist
- **THEN** it prints an error and exits with the documented not-found code

#### Scenario: JSON output is machine-readable
- **WHEN** `replay list --json` runs
- **THEN** the output is a single parseable JSON document


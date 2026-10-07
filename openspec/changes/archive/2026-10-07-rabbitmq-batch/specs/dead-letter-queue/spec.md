## MODIFIED Requirements

### Requirement: QueueProvider port and SQLite adapter

DLQ persistence SHALL sit behind the `QueueProvider` port (`enqueue`, `list`, `get`, `resolve`, `purge`, `health`, `claim`, `release`), selected by `queue.provider` (default `sqlite`). The SQLite adapter SHALL be durable, use WAL and `busy_timeout`, and allow the middleware and the `replay` CLI to share the DB files. `resolve` SHALL be atomic: of concurrent resolvers, exactly one wins. `claim(id, leaseMs)` SHALL be an atomic guarded update that marks a pending record as claimed for the lease duration, so concurrent replays cannot both execute it; a claim whose lease expired MAY be reclaimed; `release(id)` SHALL clear a claim on a still-pending record (for example when the replay fails before executing). The adapter SHALL also expose the idempotency index (`recordExecution` and `lastExecution`) over the same database.

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

`mcprelay replay list` SHALL list captured records with filters and both human and `--json` output; `mcprelay replay inspect <id>` SHALL print one record. Both SHALL read through the configured queue provider (`queue.provider`), using the same config resolution as the middleware.

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

## ADDED Requirements

### Requirement: RabbitMQ adapter

With `queue.provider: rabbitmq` the DLQ SHALL be a RabbitMQ topology — a durable direct exchange (default `mcp.dlx`) bound with routing key `mcp.failure` to a durable queue (default `mcp.dlq`) — and the adapter SHALL satisfy the same `QueueProvider` contract as SQLite. `enqueue` SHALL publish the redacted `FailureRecord` as a persistent JSON message and wait for publisher confirms before returning, while the local SQLite replay index (the configured `queue.sqlite.path`) SHALL be the durability point: a broker publish failure SHALL be reported as a warning and SHALL NOT lose the captured record. `list`/`get`/`resolve`/`purge`/`claim`/`release` and the idempotency index SHALL be served by that index with SQLite-identical semantics (filters, atomic resolve, atomic claim with lease, bounded limits). The broker copy SHALL be the immutable capture (one message per failure, not republished on resolve). `health()` SHALL check the broker and the index and SHALL report the provider and queue without echoing the URL or credentials.

#### Scenario: Capture is durable in the broker and listable through the index
- **WHEN** a failure is captured with `queue.provider: rabbitmq`
- **THEN** the broker queue holds one persistent message for it (confirmed) and `replay list` shows the record

#### Scenario: The replay flow is identical over the broker
- **WHEN** `replay run <id>` executes a record captured under the RabbitMQ provider
- **THEN** it claims, re-executes, resolves, and audits exactly as with SQLite, and the record no longer lists as pending

#### Scenario: Concurrent replay stays safe over the broker
- **WHEN** two runs race for the same pending record under the RabbitMQ provider
- **THEN** exactly one executes and the other observes the record as claimed

#### Scenario: Broker publish failure warns and never loses the record
- **WHEN** the broker is unreachable while a failure is captured
- **THEN** a warning is emitted, the capture still completes locally, and `replay list` shows the record

#### Scenario: Health reports the broker without credentials
- **WHEN** `health()` runs under the RabbitMQ provider
- **THEN** it reports the provider and queue name and the output contains no URL or credential material

#### Scenario: The same contract suite proves both adapters
- **WHEN** the port contract suite runs against a real broker (`MCPRELAY_RABBITMQ_URL` set)
- **THEN** every contract scenario passes for the RabbitMQ adapter exactly as for SQLite

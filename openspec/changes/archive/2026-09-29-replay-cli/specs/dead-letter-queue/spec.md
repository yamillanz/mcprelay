## MODIFIED Requirements

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

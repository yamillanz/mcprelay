# store Specification

## Purpose
The Store port and its SQLite adapter: call history and metrics substrate, with the audit trail implemented now (capture events linking correlation id and failure id).
## Requirements
### Requirement: Store port and audit trail

Call history and audit SHALL sit behind the `Store` port (`recordCall`, `metrics`, `audit`), backed by SQLite by default (`store.provider: sqlite`, `store.sqlite.path`). Capturing a failure SHALL write an audit entry linking the correlation id and the failure record id. `recordCall` and `metrics` are exercised by the metrics milestone; this milestone implements and tests the audit path.

#### Scenario: Capture writes an audit entry
- **WHEN** a failure is captured
- **THEN** an audit entry exists with kind `captured`, the call's correlation id, the failure record id, and a timestamp

#### Scenario: Audit survives restart
- **WHEN** the store is reopened against the same file
- **THEN** previously written audit entries are still present

#### Scenario: Queue and store are separate by default
- **WHEN** no config is provided
- **THEN** the queue writes to `./.mcprelay/queue.db` and the store to `./.mcprelay/history.db`


# store Specification

## Purpose
The Store port and its SQLite adapter: call history and metrics substrate, with the audit trail implemented now (capture events linking correlation id and failure id).
## Requirements
### Requirement: Store port and audit trail

Call history and audit SHALL sit behind the `Store` port (`recordCall`, `metrics`, `audit`), backed by SQLite by default (`store.provider: sqlite`, `store.sqlite.path`). Capturing a failure SHALL write an audit entry linking the correlation id and the failure record id. All three methods are implemented: `recordCall` persists call events, `metrics` aggregates them (per the call-events and retention requirements below), and `audit` backs the capture, denial, and replay trail.

#### Scenario: Capture writes an audit entry
- **WHEN** a failure is captured
- **THEN** an audit entry exists with kind `captured`, the call's correlation id, the failure record id, and a timestamp

#### Scenario: Audit survives restart
- **WHEN** the store is reopened against the same file
- **THEN** previously written audit entries are still present

#### Scenario: Queue and store are separate by default
- **WHEN** no config is provided
- **THEN** the queue writes to `./.mcprelay/queue.db` and the store to `./.mcprelay/history.db`

### Requirement: Call events and per-tool metrics

`recordCall` SHALL persist one call event per intercepted `tools/call` — `at`, `correlation_id`, caller (`type`, `identity`), `tool`, `decision` (`allowed` | `denied` | `failed` | `cancelled`), `latency_ms`, `request_bytes`, `response_bytes`, `attempt` — in a `call_events` table created on open so pre-M8 store files migrate in place. `metrics(filter)` SHALL return per caller + tool rows (`calls`, `errors`, `error_rate`, `latency_p50_ms`, `latency_p95_ms`, `avg_request_bytes`, `avg_response_bytes`) plus decision totals (`allowed`, `denied`, `failed`, `cancelled`) and the `replayed` count from audit entries with kind `replayed` in range. `errors` SHALL count decision `failed` only (denied and cancelled are decisions, not errors), and `error_rate` SHALL be `errors / calls` (0 with no calls). Percentiles SHALL use the nearest-rank method over the sorted latencies (the ⌈p/100 · n⌉-th value). Filters SHALL be `since`, `until` (ISO-8601 bounds, inclusive), `tool`, and `caller`.

#### Scenario: Every decision is persisted
- **WHEN** intercepted calls end as allowed, denied, failed, and cancelled
- **THEN** one call event per call exists with the matching decision, latency, payload sizes, final attempt count, and caller

#### Scenario: Metrics group per caller and tool
- **WHEN** `metrics` runs over events from two callers and two tools
- **THEN** exactly one row per caller+tool pair is returned with the correct counts

#### Scenario: Filters narrow the aggregate
- **WHEN** `metrics` is filtered by `since`, `until`, `tool`, or `caller`
- **THEN** only events matching every supplied bound contribute to the rows and totals

#### Scenario: Error rate excludes denials and cancellations
- **WHEN** a caller+tool row has calls, failures, denials, and cancellations
- **THEN** `errors` equals its `failed` count and `error_rate` is `errors / calls`

#### Scenario: Nearest-rank percentiles
- **WHEN** a row has latencies `[10, 20, 30, 40]` ms
- **THEN** `latency_p50_ms` is 20 and `latency_p95_ms` is 40

#### Scenario: Payload sizes average per row
- **WHEN** a row aggregates events with different request and response sizes
- **THEN** `avg_request_bytes` and `avg_response_bytes` are the rounded averages for that row

#### Scenario: Decision totals and replayed count
- **WHEN** `metrics` runs over a range containing replay audit entries
- **THEN** the decision totals cover every decision in range and `replayed` equals the audit `replayed` entries in range

#### Scenario: Metrics survive restart
- **WHEN** the store is reopened against the same file
- **THEN** previously recorded call events still aggregate

### Requirement: Call-event retention

Call-event growth SHALL be bounded by `store.retention_days` (default 30; `0` disables pruning). When the store opens, call events older than the retention window SHALL be deleted; the audit trail and the DLQ SHALL NOT be pruned by this mechanism. The default and the `0` semantics SHALL be documented in the README.

#### Scenario: Old events are pruned on open
- **WHEN** the store opens with a window and contains call events older than it
- **THEN** those events are gone and newer events remain

#### Scenario: Events inside the window are kept
- **WHEN** all call events are newer than the retention window
- **THEN** none are deleted

#### Scenario: Zero disables pruning
- **WHEN** `store.retention_days` is `0`
- **THEN** no call events are deleted on open

#### Scenario: Audit is not pruned
- **WHEN** retention pruning runs
- **THEN** audit entries older than the window remain


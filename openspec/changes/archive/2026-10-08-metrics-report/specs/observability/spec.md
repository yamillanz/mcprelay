## ADDED Requirements

### Requirement: Persisted call events mirror the log line

Every emitted structured log line SHALL have a matching persisted call event carrying the same decision, tool, caller, latency, payload sizes, and final attempt count — one event per intercepted call, not per attempt — so metrics reconcile with the logs. Lines with `enforced: false` (dry-run would-be denials) SHALL be logged but SHALL NOT be persisted. A store write failure SHALL be reported as a warning and SHALL NOT break the call.

#### Scenario: Decision parity between log and events
- **WHEN** a session produces allowed, denied, failed, and cancelled calls
- **THEN** the log lines and the persisted call events agree one-for-one on decision, tool, caller, sizes, and attempt count

#### Scenario: Retried success persists one event
- **WHEN** a call succeeds after retries
- **THEN** exactly one call event exists for it, with the final attempt count and decision `allowed`

#### Scenario: Dry-run denials are logged but not persisted
- **WHEN** a call is denied under `--policy-dry-run`
- **THEN** the log line carries the would-be decision with `enforced: false` and no call event is written

#### Scenario: Store failures never break a call
- **WHEN** the store cannot be written
- **THEN** a warning is emitted and the call still completes and is logged

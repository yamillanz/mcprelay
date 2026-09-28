## ADDED Requirements

### Requirement: Retry-aware call log

The single structured log line per intercepted call SHALL report the number of attempts actually made and the final decision. A call that succeeds after retries SHALL log `allowed` with an attempt count greater than 1; a call that exhausts its attempts SHALL log `failed` with the final attempt count and the final error; a call cancelled by the client SHALL log `cancelled`.

#### Scenario: Retried success is logged with the real attempt count
- **WHEN** a call succeeds on a retry
- **THEN** exactly one log line reports decision `allowed` and the attempt count actually used

#### Scenario: Exhausted retries are logged as failed
- **WHEN** every attempt fails
- **THEN** the log line reports decision `failed`, the final attempt count, and the final error

#### Scenario: Cancelled calls are logged as cancelled
- **WHEN** the client cancels an in-flight call
- **THEN** the log line reports decision `cancelled` and the attempt count used

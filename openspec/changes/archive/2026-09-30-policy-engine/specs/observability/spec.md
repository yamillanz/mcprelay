## ADDED Requirements

### Requirement: Policy decision in the call log

The structured call log SHALL carry the policy outcome: a denied call logs decision `denied` with zero attempts and the denial reason, and a call evaluated under `--policy-dry-run` logs the would-be decision with `enforced: false` so it can never be confused with an enforced denial.

#### Scenario: Enforced denial is logged
- **WHEN** a call is denied by policy
- **THEN** the log line reports decision `denied`, attempt 0, and the matched rule

#### Scenario: Dry-run denial is marked unenforced
- **WHEN** a call would be denied under `--policy-dry-run`
- **THEN** the log line reports the would-be decision with `enforced: false` and the call is forwarded

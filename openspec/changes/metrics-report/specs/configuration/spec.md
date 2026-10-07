## ADDED Requirements

### Requirement: Store retention

The config SHALL accept `store.retention_days` (an integer ≥ 0, default 30, `0` disables pruning) with strict key checking and precise path + field errors. The value bounds call-event growth as specified by the `store` capability and SHALL be documented in the README config example.

#### Scenario: Default retention
- **WHEN** no config file exists
- **THEN** `store.retention_days` is 30

#### Scenario: File value applies
- **WHEN** the config sets `store.retention_days: 7`
- **THEN** the store prunes call events older than 7 days on open

#### Scenario: Invalid value fails with path and field
- **WHEN** `store.retention_days` is negative, fractional, or not a number
- **THEN** startup fails naming `store.retention_days`

#### Scenario: Zero disables pruning
- **WHEN** the config sets `store.retention_days: 0`
- **THEN** the store keeps all call events

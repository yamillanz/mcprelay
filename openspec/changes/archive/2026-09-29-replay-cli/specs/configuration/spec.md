## ADDED Requirements

### Requirement: Replay dedup window

The config SHALL accept `reliability.replay.dedup_window` as a duration string (for example `24h`, `30m`, `7d`) with a default of `24h`. Invalid durations SHALL fail startup with the config path and field.

#### Scenario: Default window
- **WHEN** no config file exists
- **THEN** the dedup window is 24 hours

#### Scenario: Configured window applies
- **WHEN** the config sets `reliability.replay.dedup_window: 30m`
- **THEN** the guard uses a 30-minute window

#### Scenario: Invalid duration fails with path and field
- **WHEN** the config sets `reliability.replay.dedup_window: soon`
- **THEN** startup fails naming `reliability.replay.dedup_window`

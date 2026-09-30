## ADDED Requirements

### Requirement: Policy section and the dry-run flag

The config SHALL accept a `policy` section: `default` (`allow` or `deny`) and `rules` — an ordered list of `{ tool, caller?, args?, action }` entries, with strict key checking and precise path + field errors. With no `policy` section the default is `allow` and a startup warning states that all tools are allowed. `run --policy-dry-run` SHALL be accepted.

#### Scenario: Zero-config default allows with a warning
- **WHEN** no `policy` section exists
- **THEN** the session starts with default `allow` and prints a warning that no policy rules are configured

#### Scenario: Rules apply from the file
- **WHEN** the config declares rules
- **THEN** they are parsed in order and used for decisions

#### Scenario: Malformed rule fails with path and field
- **WHEN** a rule has an unknown key, a missing `action`, or a bad matcher
- **THEN** startup fails naming the config path and the offending field

#### Scenario: Dry-run flag is accepted
- **WHEN** `run --policy-dry-run -- <server>` runs
- **THEN** the session starts and policy decisions are reported without enforcement

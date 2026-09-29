## ADDED Requirements

### Requirement: Queue, store, and redaction sections

The config SHALL accept `queue` (`provider: sqlite`, `sqlite.path`), `store` (`provider: sqlite`, `sqlite.path`), and `redaction` (`patterns: string[]`) sections with safe defaults: `./.mcprelay/queue.db`, `./.mcprelay/history.db`, and the patterns `api_key`, `token`, `password`, `authorization`, `secret`, `credential`. Zero-config SHALL work without creating files until the first capture. Unknown keys inside these sections SHALL fail with the path and field; missing parent directories SHALL be created on first write.

#### Scenario: Defaults apply with no config file
- **WHEN** the session runs with no config file
- **THEN** the queue and store use the default `.mcprelay/` paths and the default redaction patterns

#### Scenario: File values override the defaults
- **WHEN** the config sets `queue.sqlite.path`, `store.sqlite.path`, or `redaction.patterns`
- **THEN** those values are used

#### Scenario: Malformed section fails with an actionable error
- **WHEN** `queue.provider` is an unsupported value or a path is not a string
- **THEN** startup fails with the config path and the offending field

#### Scenario: Missing directories are created on first write
- **WHEN** the configured `.mcprelay/` directory does not exist and a failure is captured
- **THEN** the directory is created and the record is written

### Requirement: The validate command

`mcprelay validate [--config <path>]` SHALL load and validate the complete configuration, print a short success summary when valid, and print precise path + field errors and exit non-zero when invalid. It SHALL NOT start an upstream process or touch the databases.

#### Scenario: Valid configuration exits zero
- **WHEN** `validate` runs against a valid config (or with no file)
- **THEN** it prints a summary and exits 0

#### Scenario: Invalid configuration reports path and field
- **WHEN** `validate` runs against a malformed config
- **THEN** it prints the config path and the offending field and exits non-zero

#### Scenario: Explicitly missing config path fails
- **WHEN** `validate --config` points to a file that does not exist
- **THEN** it exits non-zero with the path in the message

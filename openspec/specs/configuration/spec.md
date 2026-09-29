# configuration Specification

## Purpose
The YAML configuration surface: safe zero-config defaults, the reliability section with per-tool overrides, and CLI flag precedence.
## Requirements
### Requirement: YAML configuration with safe defaults

One YAML file SHALL configure the reliability section (`timeout_ms`, `retry`, `per_tool` overrides). The file is read from `./mcprelay.config.yaml` by default, or from the `--config <path>` location. With no file present, safe defaults apply: timeout 30 s, retries on (`max_attempts: 3`, `exponential`, `base_ms: 250`, `jitter: true`), tools non-idempotent. Malformed known sections SHALL abort startup with an actionable error naming the config path and the problem; unknown top-level sections SHALL produce a warning, not a failure (forward compatibility with sections that land in later changes).

#### Scenario: Zero-config defaults
- **WHEN** no config file exists
- **THEN** the session starts with the documented defaults and no error

#### Scenario: File values apply
- **WHEN** the config file sets `reliability.timeout_ms` and `reliability.retry.max_attempts`
- **THEN** those values govern the session

#### Scenario: Per-tool overrides apply
- **WHEN** `reliability.per_tool.<tool>` sets `timeout_ms`, `retry.max_attempts`, or `idempotent`
- **THEN** that tool's calls use the overrides and other tools keep the global values

#### Scenario: Malformed config fails with an actionable error
- **WHEN** a known section is malformed (wrong type or invalid value)
- **THEN** startup aborts with an error naming the config path and the offending field, and no upstream process is started

#### Scenario: Unknown top-level section warns
- **WHEN** the config contains a section this version does not implement
- **THEN** a warning is printed and the session starts normally

### Requirement: CLI flags override file values

The `run` command SHALL accept `--config <path>`, `--timeout-ms <ms>`, and `--max-attempts <n>`; the two value flags SHALL override the corresponding config file values for the session.

#### Scenario: Flag beats file
- **WHEN** the config file sets a value and the matching CLI flag is provided
- **THEN** the flag value is used

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


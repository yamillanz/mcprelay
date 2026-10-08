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

The config SHALL accept `queue` (`provider: sqlite | rabbitmq`, `sqlite.path`, `rabbitmq.{url,exchange,queue}`), `store` (`provider: sqlite`, `sqlite.path`), and `redaction` (`patterns: string[]`) sections with safe defaults: provider `sqlite`, `./.mcprelay/queue.db`, `./.mcprelay/history.db`, and the patterns `api_key`, `token`, `password`, `authorization`, `secret`, `credential`. With `queue.provider: rabbitmq`, `queue.sqlite.path` SHALL serve as the local replay index. Zero-config SHALL work without creating files until the first capture. Unknown keys inside these sections SHALL fail with the path and field; missing parent directories SHALL be created on first write.

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

### Requirement: Upstream HTTP section and the HTTP run flag

The config SHALL accept an `upstream` section with `http.headers` (a mapping of header name to string value) and strict key checking; malformed headers SHALL fail with the config path and field. The headers are the middleware's own upstream credentials and apply to every HTTP upstream request. `run --http <url>` SHALL be accepted as the HTTP upstream form, mutually exclusive with the stdio `-- <server command…>` form.

#### Scenario: Configured headers are parsed
- **WHEN** the config sets `upstream.http.headers`
- **THEN** the session uses them for upstream HTTP requests

#### Scenario: Malformed headers fail with path and field
- **WHEN** `upstream.http.headers` is not a mapping of strings
- **THEN** startup fails naming the config path and the offending field

#### Scenario: The HTTP flag is accepted
- **WHEN** `run --http <url>` runs
- **THEN** the session starts against the remote endpoint

#### Scenario: Conflicting upstream forms are a usage error
- **WHEN** `run` receives both `--http <url>` and `-- <server command…>`
- **THEN** it exits with a usage error and starts nothing

#### Scenario: Zero-config stays unchanged
- **WHEN** no config file exists
- **THEN** the stdio form works with the documented defaults and the HTTP section is absent

### Requirement: RabbitMQ queue configuration

The config SHALL accept `queue.rabbitmq` with `url` (default `amqp://localhost`; SHALL parse as an `amqp:` or `amqps:` URL), `exchange` (default `mcp.dlx`), and `queue` (default `mcp.dlq`), with strict key checking. Errors SHALL name the config path and the offending field and SHALL NOT echo the URL value (it may carry credentials). `validate` SHALL parse this section offline — no broker connection — and broker reachability SHALL surface at run/replay time with an actionable error. With `queue.provider: rabbitmq`, the configured `queue.sqlite.path` SHALL be the local replay index.

#### Scenario: Defaults apply without a rabbitmq section
- **WHEN** `queue.provider: rabbitmq` is set with no `queue.rabbitmq` section
- **THEN** the session uses `amqp://localhost`, exchange `mcp.dlx`, and queue `mcp.dlq`

#### Scenario: File values override the defaults
- **WHEN** the config sets `queue.rabbitmq.url`, `exchange`, or `queue`
- **THEN** those values are used

#### Scenario: Invalid URL fails without echoing the value
- **WHEN** `queue.rabbitmq.url` is not an `amqp:`/`amqps:` URL
- **THEN** startup fails naming `queue.rabbitmq.url` and the message contains no URL value

#### Scenario: Unknown keys fail with path and field
- **WHEN** `queue.rabbitmq` contains an unknown key
- **THEN** startup fails naming the config path and the offending field

#### Scenario: Validate is offline
- **WHEN** `validate` runs with `queue.provider: rabbitmq` and no broker reachable
- **THEN** it still validates and exits 0

#### Scenario: The sqlite path is the replay index under the broker provider
- **WHEN** `queue.provider: rabbitmq` and `queue.sqlite.path` are set
- **THEN** the replay index lives at that path and `replay list` reads it

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


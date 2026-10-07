## MODIFIED Requirements

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

## ADDED Requirements

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

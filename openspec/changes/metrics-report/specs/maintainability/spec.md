## MODIFIED Requirements

### Requirement: Port-only provider selection

Core paths (the proxy bridge, the replay CLI, the policy CLI, and the report CLI) SHALL obtain their `QueueProvider` / `IdempotencyIndex` and `Store` instances only through the `createPersistence(config)` factory, which SHALL be the single place that maps `queue.provider` to a concrete adapter. No core module outside the factory and the adapter files SHALL import a concrete adapter, so adding or switching an adapter changes only the factory and configuration.

#### Scenario: The replay CLI selects through the factory
- **WHEN** a maintainer opens the replay run path
- **THEN** it constructs no concrete adapter and receives its providers from the factory

#### Scenario: The report CLI selects through the factory
- **WHEN** a maintainer opens the report path
- **THEN** it reads metrics through the store obtained from the factory and imports no concrete adapter

#### Scenario: Adapter imports stay contained
- **WHEN** the source tree is inspected for concrete queue/store adapter imports
- **THEN** only the factory and the adapter files reference them; the bridge, replay CLI, policy CLI, and report CLI reference port types only

#### Scenario: Switching providers changes no core logic
- **WHEN** `queue.provider` changes between `sqlite` and `rabbitmq`
- **THEN** the same core code runs and only the factory chooses a different adapter

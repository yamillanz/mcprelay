## ADDED Requirements

### Requirement: One-command RabbitMQ demo

The repository SHALL provide a Docker Compose setup that starts a real RabbitMQ broker, the middleware configured with `queue.provider: rabbitmq`, and the hermetic example server, plus a one-shot demo service that drives the flow fail → DLQ (with the capture visible in the broker) → successful replay. The demo SHALL exit non-zero when any step fails, SHALL use no network egress beyond the Compose network, and SHALL be documented in the README with the expected output. The RabbitMQ adapter SHALL be exercised against a real broker in tests when a broker URL is provided (`MCPRELAY_RABBITMQ_URL`), and by the Compose demo otherwise.

#### Scenario: Compose configuration is valid
- **WHEN** `docker compose config` runs in the repository
- **THEN** the configuration validates with no errors

#### Scenario: The demo reproduces the flow
- **WHEN** the demo service runs against the Compose stack
- **THEN** a failed call is captured, the broker queue shows the capture, and a replay of the record succeeds, exiting 0

#### Scenario: The demo fails loudly
- **WHEN** any demo step fails (capture, broker visibility, or replay)
- **THEN** the demo exits non-zero with the failing step named

#### Scenario: Broker-backed tests are gated by the broker URL
- **WHEN** `MCPRELAY_RABBITMQ_URL` is unset
- **THEN** the broker-dependent tests are skipped with a visible notice and the rest of the suite stays green

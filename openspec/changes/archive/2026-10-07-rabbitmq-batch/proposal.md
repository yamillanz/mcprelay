## Why

The `QueueProvider` port is the product's "bring your own queue" promise (P4, §6.2) and so far only SQLite proves it. M7 makes the port real: the same capture → DLQ → replay flow runs over a real broker (`queue.provider: rabbitmq`), the replay CLI gains the batch redrive it was designed for (`run --all --filter`, FR-R4), and the whole flow is reproducible with `docker compose up` (§9). This closes D5 (RabbitMQ `list`/`get` semantics and topology).

## What Changes

- **RabbitMQ adapter (D5 resolution)**: a durable direct exchange (`mcp.dlx`, configurable) bound to a durable queue (`mcp.dlq`, configurable) receives every captured `FailureRecord` as a persistent, confirm-acknowledged message — the broker holds the immutable capture. Because AMQP has no query, `list`/`get`/`resolve`/`purge`/`claim`/`release` and the idempotency index are served by the existing SQLite implementation acting as the **local replay index** (default `./.mcprelay/queue.db`, NFR-9): exact filters, atomic resolve, atomic claim with lease — replay stays correct and concurrent-safe. Broker publish failures surface as warnings and never lose a captured record (the index write is the durability point, NFR-5). Rejected alternatives (peek-via-requeue, pure event publish) recorded in ADR-0008.
- **Port-only core**: `replay-run.ts` stops importing concrete adapters and selects providers through the existing `createPersistence` factory, so `queue.provider: rabbitmq` changes only config (FR-R6: adding an adapter requires no core changes).
- **Batch replay**: `mcprelay replay run --all` with the `list` filters (`--tool`, `--correlation-id`, `--since`, `--until`, `--limit`), `--dry-run`, `--force`, `--json`; pending records only; sequential; concurrent-safe via the atomic claim; per-record lines plus a summary and CI-meaningful exit codes. `--set` is rejected with `--all`.
- **Configuration**: `queue.rabbitmq { url, exchange, queue }` parsing with defaults and precise validation errors; the configured `queue.sqlite.path` is documented as the replay index when the provider is RabbitMQ; credentials never appear in output.
- **`docker compose up` demo**: RabbitMQ + middleware + example server, driven by a demo script that shows fail → DLQ (visible in the broker) → replay, documented in the README. The RabbitMQ adapter is tested against a real broker (contract suite gated by `MCPRELAY_RABBITMQ_URL`; CI job with a broker service — NFR-8).
- **Dependency**: `amqplib` (MIT) + `@types/amqplib` (MIT, dev) — permissive, de-facto-standard AMQP client; justification recorded per rule 7. `@cloudamqp/amqp-client` (Apache-2.0) rejected in ADR-0008.
- PRD: D5 moves to Resolved (§14) with a document-history entry; ADR-0008; README (RabbitMQ quickstart, batch replay, compose demo); living architecture diagram updated (broker + adapter + compose path).

## Capabilities

### New Capabilities

- `compose-demo`: the one-command RabbitMQ demo — `docker compose up` starts the middleware, a real broker, and the example server, and a reproducible scripted flow ends on a successful replay.

### Modified Capabilities

- `dead-letter-queue`: provider-selected DLQ (`sqlite | rabbitmq`); the RabbitMQ adapter's durable publish + local replay index contract, health, and broker-outage behavior; inspection reads the configured provider.
- `replay-cli`: batch replay (`run --all` + filters) — selection, pending-only, dry-run/force, concurrency, summary and exit codes.
- `configuration`: `queue.rabbitmq` section (url/exchange/queue), defaults, validation errors, and the replay-index role of `queue.sqlite.path`.
- `maintainability`: core paths (bridge and replay CLI) consume providers only through the `Persistence` factory; no concrete adapter imports outside it.

## Impact

- **Code**: new `src/queue/rabbitmq-queue.ts`; `src/queue/providers.ts` (provider selection); `src/config/config.ts` (rabbitmq section); `src/replay/replay-run.ts` (port-based providers, per-record helper reused by batch), `src/replay/replay-cli.ts` (batch parsing/flow); `src/queue/failure-record.ts` (health detail if needed).
- **New files**: `compose.yaml`, `Dockerfile`, `examples/rabbitmq-demo/` (config + demo script), `docs/adr/0008-rabbitmq-adapter.md`, tests (`queue-contract`, `rabbitmq-queue`, `replay-batch`), CI job with a RabbitMQ service.
- **Dependencies**: `amqplib` (MIT), `@types/amqplib` (dev, MIT). No SaaS/cloud dependency; the broker runs locally in Docker.
- **Docs**: README, PRD (D5 resolved + history), AGENTS status line, architecture diagram; no breaking CLI changes (batch is additive).

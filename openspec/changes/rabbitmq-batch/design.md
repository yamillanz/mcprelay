## Context

M7 is the D5 milestone (§6.2, FR-R6): prove the `QueueProvider` port with a second adapter over a real broker, add the batch replay FR-R4 deferred since M4, and make the flow reproducible with `docker compose up` (§9). Today only `SqliteQueueProvider` exists, `replay-run.ts` imports it directly (plus `SqliteStore`), and `queue.provider` accepts only `sqlite`.

The port's known impedance (§6.2): `list`/`get` are store semantics and AMQP has no query. The PRD's D5 recommendation: the replay path is the only list/filter consumer — favor the simplest design that keeps replay correct and concurrent-safe; in-process backoff may make a full DLX topology unnecessary. Constraints: FR-R6 (atomic resolve, no double execution), FR-R3/NFR-5 (durable capture before the client error), NFR-4 (no credentials or secrets in output), NFR-8 (broker tests against a real broker), NFR-9 (local-first, SQLite files shared safely), rule 7 (permissive deps only).

## Goals / Non-Goals

**Goals:**

- `queue.provider: rabbitmq` runs the identical capture → DLQ → replay flow with the broker holding the durable capture.
- Replay stays exact and concurrent-safe: filters, atomic resolve, atomic claim with lease, idempotency index — the same semantics as SQLite (one contract suite proves both).
- `mcprelay replay run --all --filter` redrives pending records in batch, concurrently safe.
- `docker compose up` reproduces fail → DLQ → replay against a real broker, and the adapter is tested against a real broker (local Docker / CI service).
- Core paths select providers only through the `Persistence` factory (FR-R6: adding an adapter changes no core logic).

**Non-Goals:**

- AMQP-native `list`/`get`/claims (peek-via-requeue) — rejected below; the local index is the query path.
- Broker-side retry/backoff or a full DLX-from-work-queue topology (retries are in-process since M2).
- Redis/NATS/ElasticMQ adapters (v1 cap: 2 queue adapters — §10).
- A management UI, dashboards, or broker-side redrive tooling (ops use RabbitMQ's own tooling).
- Changes to the capture path's redaction, the FailureRecord shape, or the single-record replay semantics.

## Decisions

### D1 — D5 resolution: durable DLX-shaped capture in the broker + local replay index (metadata mirror)

Topology: a durable **direct** exchange `mcp.dlx` (configurable) bound with routing key `mcp.failure` to a durable queue `mcp.dlq` (configurable). `enqueue` publishes the redacted `FailureRecord` as a persistent JSON message and waits for publisher confirms, so the broker copy is durable before the client receives the error (FR-R3/NFR-5). The broker holds the **immutable capture** — one message per failure, never republished on resolve; replay state lives in the index.

Query half: `list`/`get`/`resolve`/`purge`/`claim`/`release` and the idempotency index are served by the existing SQLite implementation as the **local replay index** at `queue.sqlite.path` (default `./.mcprelay/queue.db`). Rationale: AMQP has no query; the replay path is the only consumer; the SQLite implementation already provides exact filters, atomic resolve, atomic claim + lease, and an indexed idempotency lookup — replay stays correct and concurrent-safe (FR-R6) with zero new query semantics, and NFR-9 keeps it local-first.

Enqueue order: (1) index insert (the durability point), (2) broker publish with confirms. A publish failure emits a warning and the record stays replayable — never a silent drop; the broker copy is ops/retention. `health()` checks the broker (connection + passive declare) and the index, reports `provider: 'rabbitmq'` and the queue name, and never echoes the URL (credentials, NFR-4).

Rejected: **peek-via-requeue + unacked-get claims** (O(n) scans per list/get; "claimed by another" vs "not found" is undetectable; ack/publish crash windows duplicate records; amqplib exposes no transactions, so atomic resolve cannot be built); **durable record + event publish without an index** (no list/get at all); **full DLX from a work queue** (no broker-side consumer exists — mcprelay retries in-process).

### D2 — Port-only core: one factory, no adapter imports in core paths

`createPersistence(config)` switches on `queue.provider` and returns `QueueProvider & IdempotencyIndex` plus `Store`. `replay-run.ts` replaces its direct `SqliteQueueProvider`/`SqliteStore` construction and type annotations with the factory and the port types; `bridge.ts` already uses the factory. `RabbitMqQueueProvider` composes the SQLite index (delegating the query half) with the amqplib connection (enqueue/health), implementing the port's existing composite type — no interface change. A `maintainability` requirement makes this a contract.

### D3 — Batch replay: `run --all` reuses the single-record pipeline

Surface: `replay run --all [--tool <name>] [--correlation-id <id>] [--since <iso>] [--until <iso>] [--limit <n>] [--dry-run] [--force] [--json] [--config <path>]`. Selection is always `status: pending` (`--status` remains unknown for `run`); filters map to `FailureFilter`; default limit 50, max 500 (the `list` bounds). `--set` with `--all` and a positional id with `--all` are usage errors.

Execution is sequential; each record goes through the same guard → claim → attempt → persist sequence as `run <id>`, extracted into one named helper reused by both paths. A record that fails its guard (remaining redaction markers) or is claimed elsewhere is reported and skipped, staying pending. Output: one line per record plus a summary (`replay --all: N selected, M ok, K failed, L skipped`); `--json` emits one summary document with per-record outcomes. Exit 0 when every attempted record succeeded (or none selected), 1 when any failed or was skipped. `--dry-run --all` inspects each record with zero `tools/call` and exits 1 if any inspection reports a problem. Concurrency is inherited from the atomic claim: two batch runs, or a batch plus a single run, never execute the same record twice.

### D4 — Configuration surface

`queue.provider: sqlite | rabbitmq` (default `sqlite`); `queue.rabbitmq { url: amqp://localhost, exchange: mcp.dlx, queue: mcp.dlq }` with per-key defaults, strict parsing (unknown keys rejected, `path: message` errors), and URL validation for `amqp:`/`amqps:`. Error messages name the config path, never echo the URL value (credentials). `queue.sqlite.path` stays and is documented as the replay index when the provider is RabbitMQ. `validate` parses without network access; broker reachability surfaces at run/replay time with an actionable error.

### D5 — Testing against a real broker (NFR-8)

A port **contract suite** (`tests/queue-contract.test.ts`) runs the same scenarios against both adapters — `sqlite` always, `rabbitmq` only when `MCPRELAY_RABBITMQ_URL` is set (otherwise skipped with a visible notice, so broker-free environments stay green). Broker-specific tests (`tests/rabbitmq-queue.test.ts`) cover confirmed durable publish, publish-failure warning with the record still replayable, health without credentials, and connection-error surfacing. CI gains a RabbitMQ-service job with the env var set; the main job stays broker-free. Batch replay, config, and the port refactor are hermetic (SQLite) in the main suite. The compose demo is the documented local step and the M7 exit evidence.

### D6 — Dependency: amqplib

`amqplib` 2.x (MIT) + `@types/amqplib` (dev, MIT). Rationale (rule 7): de-facto-standard AMQP 0-9-1 client, permissive, actively maintained, no vendor services; exposes publisher confirms and passive declares needed for durability and health. Rejected: `@cloudamqp/amqp-client` (Apache-2.0 — license fine, but less widely deployed and its API adds nothing for this design); a hand-rolled AMQP client (rule 7 / maintenance burden).

### D7 — Compose demo

`compose.yaml` with three services: `rabbitmq` (official `rabbitmq:4-alpine`, healthcheck), `middleware` (built from the repo via a small Dockerfile; `queue.provider: rabbitmq`; a volume for `.mcprelay/`), and `demo` (one-shot driver: fails a call, shows the message in `mcp.dlq`, replays it successfully, exits non-zero on failure). The README documents `docker compose up --build` and the expected output. The demo uses the hermetic echo server (no network egress, NFR-1).

## Risks / Trade-offs

- **Mirror drift** (broker has a capture the index missed) → index-first ordering makes the index the durability point and the publish failure is warned; broker-side reconciliation is documented as out of scope.
- **Broker outage** → captures stay durable locally with warnings; replay is unaffected (index local) — documented local-first behavior, not silent degradation.
- **Batch side effects** → dry-run first, per-record guards, `--force` required for duplicates, sequential execution, no `--set` in batch.
- **Broker queue growth** → retention is broker policy (TTL/limits); the index is the only query path; documented.
- **amqplib callback API in a strict-TS repo** → wrapped in a small same-file promise helper inside the adapter; no other file sees it.
- **Contract divergence between adapters** (ordering, limits) → ordering and limits are index-defined and identical for both providers; broker-specific behavior is documented in ADR-0008 and covered by broker-only tests.

## Migration Plan

No data migration: `sqlite` remains the default and existing configs are valid. With `queue.provider: rabbitmq`, the index is a fresh local SQLite file (existing `queue.sqlite.path`). Rollback is a revert of the change; captured records remain in the index and the broker.

## Open Questions

(none)

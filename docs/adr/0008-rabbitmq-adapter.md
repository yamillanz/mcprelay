# ADR-0008 — RabbitMQ adapter: DLX-shaped durable capture with a local replay index

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-10-05 |
| **Milestone** | M7 `rabbitmq-batch` |
| **PRD refs** | FR-R3–R4, FR-R6, NFR-4/5/8/9, D5, §6.2, §9, §12 |

## Context

The `QueueProvider` port (PRD §6.2) shipped with a single SQLite adapter (M3). M7 must prove the port is real with a RabbitMQ adapter, adding batch replay (`run --all`, FR-R4) and a reproducible `docker compose` demo (§9). D5 recorded the known impedance: `list`/`get` are store semantics and AMQP has no query; the PRD recommendation is the simplest design that keeps replay correct and concurrent-safe, noting that in-process backoff (M2) may make a full dead-letter topology unnecessary. The port contract demands durable enqueue, filters, atomic `resolve()`, atomic `claim()` with lease, purge, health, and the idempotency index (FR-R6).

## Decisions

### D1 — Topology: durable direct exchange + durable queue, no broker-side retry

`enqueue` publishes the redacted `FailureRecord` as a persistent JSON message to a durable direct exchange (default `mcp.dlx`) bound with routing key `mcp.failure` to a durable queue (default `mcp.dlq`), and waits for publisher confirms before returning, so the broker copy is durable before the client sees the error (FR-R3/NFR-5). There is no work queue and no `x-dead-letter-exchange` on it: retries run in-process (M2), so a broker-side DLX chain would have no consumer. The "DLX" names describe intent (failures are dead-lettered to the broker), not a second hop. Rejected: fanout/topic exchanges (nothing needs them) and a full work-queue + DLX topology (ceremony without a consumer).

### D2 — D5 resolution: metadata mirror — broker holds the capture, local index serves the query

The broker queue holds the **immutable capture** — one persistent message per failure, never republished on resolve. The port's query half (`list`, `get`, `resolve`, `purge`, `claim`, `release`) and the idempotency index are served by the existing SQLite implementation acting as the **local replay index** at `queue.sqlite.path` (default `./.mcprelay/queue.db`, NFR-9). Rationale: the replay path is the only list/filter consumer; the SQLite implementation already provides exact filters, atomic `resolve()`, atomic `claim()` with lease, indexed dedup lookups, and identical ordering/limits on both providers — replay stays correct and concurrent-safe with zero new query semantics, and one contract suite proves both adapters. Rejected: **peek-via-requeue** (`basic.get` + `nack(requeue)` scans are O(n) per list/get, "claimed by another" is indistinguishable from "not found", the ack/publish crash window duplicates records, and amqplib exposes no transactions to make resolve atomic); **durable record + event publish only** (no `list`/`get` at all); an AMQP executions queue for the idempotency index (unbounded growth, O(n) scans per replay).

### D3 — Enqueue order and broker failure behavior

`enqueue` writes the index first (the durability point) and then publishes with confirms. A publish failure (broker down, channel error) is reported through an `onWarning` hook — defaulting to `mcprelay: warning: …` on stderr — and the record stays listable and replayable locally. Failure to publish never loses a capture (NFR-5); a broker outage degrades to local-only capture with visible warnings, and the broker copy remains ops/retention data.

### D4 — Atomicity stays on the index; adapters are interchangeable

`resolve`, `claim`, `release`, and dedup use the same SQL as the SQLite adapter (via the composed index), so the concurrency guarantees of FR-R6 are identical across providers; the port contract suite runs the same scenarios against both. `health()` checks the broker (connection + passive queue declare) and the index, reports `provider: 'rabbitmq'` and the queue name, and never echoes the URL (credentials, NFR-4).

### D5 — Port-only core

The port (interfaces + errors) moved to `src/queue/port.ts`; `createPersistence(config)` is the single place that maps `queue.provider` to a concrete adapter. The bridge, the replay CLI (list/inspect/run/batch), and `policy test --id` consume port types only; `sqlite-queue.ts` and `rabbitmq-queue.ts` are the only modules that import an adapter. `Persistence.close()` became async so the RabbitMQ connection is closed deterministically.

### D6 — Dependency: amqplib

`amqplib` 2.x (MIT, **zero transitive dependencies**) plus `@types/amqplib` (MIT, dev). De-facto-standard AMQP 0-9-1 client, actively maintained, exposes publisher confirms (`createConfirmChannel`/`waitForConfirms`) and passive declares needed for durability and health; no vendor services (P1/NFR-1). Rejected: `@cloudamqp/amqp-client` (Apache-2.0 — license fine, but less widely deployed and its API adds nothing for this design) and a hand-rolled AMQP client (rule 7; maintenance burden).

## Consequences

- **Positive:** the same capture → DLQ → replay flow runs over a real broker; ops can see captures with standard RabbitMQ tooling; replay semantics (filters, atomic resolve, claim/lease, dedup) are exactly the SQLite ones; the port is proven by one contract suite; the compose demo and CI service job exercise a real broker.
- **Negative / accepted:** with `queue.provider: rabbitmq`, the query index lives locally (documented in the README and config); `purge` clears the index but not broker messages — broker retention is ops policy (queue TTL/limits); a broker/index reconciliation tool is out of scope for v1. These limits are recorded so a future change can revisit them (e.g. an AMQP-native query path if a second query consumer appears).

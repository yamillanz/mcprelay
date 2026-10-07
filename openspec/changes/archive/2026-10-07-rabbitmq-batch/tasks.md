# Tasks — `rabbitmq-batch`

Test-first (rule 11): every implementation group starts with its failing tests. Broker-dependent tests are gated by `MCPRELAY_RABBITMQ_URL` (skipped with a notice when unset); everything else is hermetic.

Scenario → test traceability: "Capture is durable in the broker and listable through the index" / "The same contract suite proves both adapters" / "Concurrent replay stays safe over the broker" → `tests/queue-contract.test.ts` (+ `tests/rabbitmq-queue.test.ts`); "Broker publish failure warns and never loses the record" / "Health reports the broker without credentials" → `tests/rabbitmq-queue.test.ts`; "The replay flow is identical over the broker" → contract + real-server evidence; batch scenarios → `tests/replay-batch.test.ts`; RabbitMQ config scenarios → `tests/config.test.ts`; port-only scenarios → `tests/providers.test.ts`; compose scenarios → `docker compose config` + the recorded demo run.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-05 ("approved, make the commit" + `/opsx-apply rabbitmq-batch`)

## 1. Baseline and dependency

- [x] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 303/303)
  - Baseline 2026-10-05: typecheck/lint/format/build/build:examples clean; **303/303** (22 suites); `spec:validate` 11/11
- [x] 1.2 Add `amqplib` (MIT) + `@types/amqplib` (dev, MIT); record the license audit (`npm ls --all` permissive) and the rule-7 justification (ADR-0008)
  - `amqplib@2.2.0` MIT **with zero transitive dependencies**; `@types/amqplib@0.10.8` MIT (dev); runtime deps remain MIT/ISC only
- [x] 1.3 Start a local RabbitMQ for development/evidence and record the URL: `docker run -d --name mcprelay-rabbit -p 5672:5672 rabbitmq:4-alpine` (or compose service); export `MCPRELAY_RABBITMQ_URL=amqp://localhost`
  - `mcprelay-rabbit` (rabbitmq:4-alpine) up on `amqp://localhost`; needed `--user rabbitmq` on this machine (root entrypoint hit an `.erlang.cookie` eacces quirk); verified with `rabbitmq-diagnostics -q ping` + amqplib assert/delete of `mcp.dlq.smoke`

## 2. Port contract suite (red first)

- [x] 2.1 Write the failing contract suite `tests/queue-contract.test.ts` parameterized over adapters: `sqlite` always, `rabbitmq` only when `MCPRELAY_RABBITMQ_URL` is set — enqueue/list/get with filters, atomic resolve, atomic claim + release, purge, health, idempotency round-trip, restart durability ("The same contract suite proves both adapters"; "Atomic resolve"; "Atomic claim with lease"; "Claim is released before execution")
  - 7 scenarios × 2 adapters (14 with broker, 7 + skip notice without); red confirmed as module-not-found before 3.1
- [x] 2.2 Write the failing broker tests `tests/rabbitmq-queue.test.ts`: confirmed persistent publish (message present after a fresh connection), broker publish failure warns and the record stays listable, health reports provider + queue with no URL/credentials, connection error surfaces actionably ("Capture is durable in the broker and listable through the index"; "Broker publish failure warns and never loses the record"; "Health reports the broker without credentials")
  - 4 cases; red confirmed before 3.1

## 3. RabbitMQ adapter (until green)

- [x] 3.1 Implement `src/queue/rabbitmq-queue.ts`: lazy amqplib connection (promise-wrapped), durable direct exchange + durable queue declare/bind (`mcp.dlx`/`mcp.dlq`, routing key `mcp.failure`), enqueue = index insert then confirmed persistent publish (warning on publish failure), query half delegated to the SQLite index, health without credentials
  - `RabbitMqQueueProvider` + `RABBIT_ROUTING_KEY`; lazy `ensureChannel` with 5 s connect timeout; `HealthStatus.queue` added; typecheck/lint clean after the `exactOptionalPropertyTypes` fix
- [x] 3.2 Green: contract suite against the real broker (`MCPRELAY_RABBITMQ_URL` set) and hermetic suite without it; concurrency scenarios pass ("Concurrent replay stays safe over the broker")
  - With `MCPRELAY_RABBITMQ_URL=amqp://localhost`: **18/18** (14 contract + 4 broker); without: sqlite contract green, broker suites skipped with notice
- [x] 3.3 Config-first: write failing `tests/config.test.ts` cases (rabbitmq defaults, overrides, invalid URL without echoing the value, unknown key, offline validate) then implement the `queue.rabbitmq` section in `src/config/config.ts` until green ("RabbitMQ queue configuration" scenarios)
  - 5 failing cases first (red), then `applyQueueSection`/`applyRabbitMqSection`/`isAmqpUrl` + `STORE_KEYS` split; config 32/32 and `validate` 5/5 (offline case against dist)

## 4. Port-only core (maintainability)

- [x] 4.1 Write the failing `tests/providers.test.ts`: `createPersistence` returns the SQLite adapter by default and the RabbitMQ adapter when selected (lazy — no broker needed at construction), and the store is selected the same way ("Switching providers changes no core logic")
  - 4 cases (selection, lazy RabbitMQ, store, instance reuse); red before the factory change
- [x] 4.2 Implement provider selection in `src/queue/providers.ts`; refactor `src/replay/replay-run.ts` to use `createPersistence` and port types only (no concrete adapter imports) until green ("The replay CLI selects through the factory"; "Adapter imports stay contained")
  - Port extracted to `src/queue/port.ts` (interfaces + errors); `replay-run`, `replay-cli` list/inspect, and `policy-cli` now go through `createPersistence`; `Persistence.close()` is async and awaited by `bridge.ts`; sqlite-queue/rabbitmq are the only concrete imports (plus the factory)
- [x] 4.3 Confirm the full suite is green and `src/proxy/bridge.ts` needed no changes
  - Only the `close()` await changed in `bridge.ts` (one line); full suite **331/331** with the broker (25 suites); one stale assertion updated (`cannot open the queue provider`)

## 5. Batch replay (red first)

- [x] 5.1 Write the failing `tests/replay-batch.test.ts`: selection with filters and default limit, `--all` + `--set` / positional id usage errors, batch dry-run with zero `tools/call`, per-record outcomes + summary, exit codes (all-ok/none = 0, any failed/skipped = 1), `--json` summary, and two concurrent batches executing each record at most once ("Batch selects pending records with filters"; "Batch and single forms are mutually exclusive"; "Batch dry-run makes no upstream calls"; "Per-record outcomes and summary"; "Exit codes are CI-meaningful"; "Concurrent batches never double-execute"; "JSON summary is machine-readable")
  - 10 failing cases first (red); also hardened the pre-existing single-run race assertion to accept `claim|already resolved` (both prove exactly-one execution)
- [x] 5.2 Implement batch parsing (`--all` + filters in `src/replay/replay-cli.ts`) and the batch flow in `src/replay/replay-run.ts`, extracting the shared per-record helper; until green
  - `--all` + shared `consumeFilterOption`/`consumeLimit`, mutual-exclusion checks; `replayBatchRecord` reuses guard/claim/attempt/persist; summary + exit codes; **10/10**, full suite **341/341**

## 6. Compose demo and docs

- [x] 6.1 Add `compose.yaml` + `Dockerfile` + `examples/rabbitmq-demo/` (configs + demo driver script); `docker compose config` validates ("Compose configuration is valid")
  - `compose.yaml` (rabbitmq:4-alpine + demo, healthcheck, volume), multi-stage `Dockerfile` + `.dockerignore`, `examples/rabbitmq-demo/demo.mjs` (generates both configs, drives fail→DLQ→replay); `docker compose config` OK; eslint Node globals block for `examples/**/*.mjs`
- [x] 6.2 Run the demo end to end (`docker compose up --build`) and record the output: capture in `mcp.dlq`, replay success, exit 0 ("The demo reproduces the flow"; "The demo fails loudly")
  - 2026-10-05: middleware up (echo-server) → `sleep` timed out and captured → `mcp.dlq holds 1 capture(s)` → pending record → `replay ok` → `demo: OK`, exit 0 (first run failed loudly on the volume `rmdir` and was fixed)
- [x] 6.3 Write `docs/adr/0008-rabbitmq-adapter.md` (D5 resolution: topology, metadata mirror, rejected alternatives, dependency justification); update README (RabbitMQ quickstart, batch replay, compose demo, broker test instructions)
  - ADR-0008 (topology, metadata mirror + rejected alternatives, enqueue order/warnings, atomicity on the index, port-only core, amqplib); README status M7 + batch replay + RabbitMQ provider + compose demo + broker test instructions + ADR-0008 in the index
- [x] 6.4 PRD (rule 1): move D5 to Resolved (§14) with the resolution and date; document history v0.10
  - D5 moved to Resolved (metadata mirror, 2026-10-05), removed from Open; history v0.10 added
- [x] 6.5 Living architecture diagram: add the broker + RabbitMQ adapter path and the compose demo; validate + re-deliver the HTML (Archify, showcase) and visual-check
  - Title M7; persistence node now reads `sqlite | rabbitmq dlx` with `replay index · confirms` (the adapter lives inside the DLQ node; a separate broker node could not keep a clean corridor at the showcase layout — tried and reverted with validator evidence); validate 0 errors/0 warnings, delivered, visual-check light/dark at 1440x900
- [x] 6.6 Update the AGENTS status line (M7 landed → next M8 `metrics-report`)
  - Done

## 7. Verification and approval gates

- [x] 7.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 303 + new)
  - 2026-10-05 hermetic (no broker): typecheck/lint/format/build/build:examples clean; **330 passed + 5 skipped** (broker suites skip with notice); `spec:validate` 11/11
- [x] 7.2 Broker evidence: contract + broker suites green against the local broker (`MCPRELAY_RABBITMQ_URL` set); record the run
  - `MCPRELAY_RABBITMQ_URL=amqp://localhost`: **18/18** (14 contract + 4 broker)
- [x] 7.3 Real-server evidence: filesystem (stdio) and the hermetic HTTP fixture under `queue.provider: rabbitmq` — fail → DLQ in the broker → replay → audit, plus one batch run (`run --all`)
  - 2026-10-05 evidence run (`amqp://localhost`, unique `mcp.dlx.evidence.*`/`mcp.dlq.evidence.*`): stdio filesystem `write_file` isError captured (`tool_error:stdio`) and HTTP `sleep` timeout captured (`timeout:http`) → broker holds **2** captures → filesystem replay `replay ok` with the **side effect landed** (file exists with content) → batch `--all --tool sleep`: `1 selected, 1 ok, 0 failed` → broker still **2** (immutable capture) → audit: `captured` x2 + `replayed` x2
- [x] 7.4 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
  - Approved 2026-10-05: `a059cac` feat (+ `9dfe1ab` spec) pushed to `origin/main`
- [x] 7.5 Human approval to archive (rule 0); archive the change after approval
  - Approved 2026-10-05 and archived as `2026-10-07-rabbitmq-batch`

# Tasks — `rabbitmq-batch`

Test-first (rule 11): every implementation group starts with its failing tests. Broker-dependent tests are gated by `MCPRELAY_RABBITMQ_URL` (skipped with a notice when unset); everything else is hermetic.

Scenario → test traceability: "Capture is durable in the broker and listable through the index" / "The same contract suite proves both adapters" / "Concurrent replay stays safe over the broker" → `tests/queue-contract.test.ts` (+ `tests/rabbitmq-queue.test.ts`); "Broker publish failure warns and never loses the record" / "Health reports the broker without credentials" → `tests/rabbitmq-queue.test.ts`; "The replay flow is identical over the broker" → contract + real-server evidence; batch scenarios → `tests/replay-batch.test.ts`; RabbitMQ config scenarios → `tests/config.test.ts`; port-only scenarios → `tests/providers.test.ts`; compose scenarios → `docker compose config` + the recorded demo run.

## 0. Approval gate (rule 0 — blocks everything below)

- [ ] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**

## 1. Baseline and dependency

- [ ] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 303/303)
- [ ] 1.2 Add `amqplib` (MIT) + `@types/amqplib` (dev, MIT); record the license audit (`npm ls --all` permissive) and the rule-7 justification (ADR-0008)
- [ ] 1.3 Start a local RabbitMQ for development/evidence and record the URL: `docker run -d --name mcprelay-rabbit -p 5672:5672 rabbitmq:4-alpine` (or compose service); export `MCPRELAY_RABBITMQ_URL=amqp://localhost`

## 2. Port contract suite (red first)

- [ ] 2.1 Write the failing contract suite `tests/queue-contract.test.ts` parameterized over adapters: `sqlite` always, `rabbitmq` only when `MCPRELAY_RABBITMQ_URL` is set — enqueue/list/get with filters, atomic resolve, atomic claim + release, purge, health, idempotency round-trip, restart durability ("The same contract suite proves both adapters"; "Atomic resolve"; "Atomic claim with lease"; "Claim is released before execution")
- [ ] 2.2 Write the failing broker tests `tests/rabbitmq-queue.test.ts`: confirmed persistent publish (message present after a fresh connection), broker publish failure warns and the record stays listable, health reports provider + queue with no URL/credentials, connection error surfaces actionably ("Capture is durable in the broker and listable through the index"; "Broker publish failure warns and never loses the record"; "Health reports the broker without credentials")

## 3. RabbitMQ adapter (until green)

- [ ] 3.1 Implement `src/queue/rabbitmq-queue.ts`: lazy amqplib connection (promise-wrapped), durable direct exchange + durable queue declare/bind (`mcp.dlx`/`mcp.dlq`, routing key `mcp.failure`), enqueue = index insert then confirmed persistent publish (warning on publish failure), query half delegated to the SQLite index, health without credentials
- [ ] 3.2 Green: contract suite against the real broker (`MCPRELAY_RABBITMQ_URL` set) and hermetic suite without it; concurrency scenarios pass ("Concurrent replay stays safe over the broker")
- [ ] 3.3 Config-first: write failing `tests/config.test.ts` cases (rabbitmq defaults, overrides, invalid URL without echoing the value, unknown key, offline validate) then implement the `queue.rabbitmq` section in `src/config/config.ts` until green ("RabbitMQ queue configuration" scenarios)

## 4. Port-only core (maintainability)

- [ ] 4.1 Write the failing `tests/providers.test.ts`: `createPersistence` returns the SQLite adapter by default and the RabbitMQ adapter when selected (lazy — no broker needed at construction), and the store is selected the same way ("Switching providers changes no core logic")
- [ ] 4.2 Implement provider selection in `src/queue/providers.ts`; refactor `src/replay/replay-run.ts` to use `createPersistence` and port types only (no concrete adapter imports) until green ("The replay CLI selects through the factory"; "Adapter imports stay contained")
- [ ] 4.3 Confirm the full suite is green and `src/proxy/bridge.ts` needed no changes

## 5. Batch replay (red first)

- [ ] 5.1 Write the failing `tests/replay-batch.test.ts`: selection with filters and default limit, `--all` + `--set` / positional id usage errors, batch dry-run with zero `tools/call`, per-record outcomes + summary, exit codes (all-ok/none = 0, any failed/skipped = 1), `--json` summary, and two concurrent batches executing each record at most once ("Batch selects pending records with filters"; "Batch and single forms are mutually exclusive"; "Batch dry-run makes no upstream calls"; "Per-record outcomes and summary"; "Exit codes are CI-meaningful"; "Concurrent batches never double-execute"; "JSON summary is machine-readable")
- [ ] 5.2 Implement batch parsing (`--all` + filters in `src/replay/replay-cli.ts`) and the batch flow in `src/replay/replay-run.ts`, extracting the shared per-record helper; until green

## 6. Compose demo and docs

- [ ] 6.1 Add `compose.yaml` + `Dockerfile` + `examples/rabbitmq-demo/` (configs + demo driver script); `docker compose config` validates ("Compose configuration is valid")
- [ ] 6.2 Run the demo end to end (`docker compose up --build`) and record the output: capture in `mcp.dlq`, replay success, exit 0 ("The demo reproduces the flow"; "The demo fails loudly")
- [ ] 6.3 Write `docs/adr/0008-rabbitmq-adapter.md` (D5 resolution: topology, metadata mirror, rejected alternatives, dependency justification); update README (RabbitMQ quickstart, batch replay, compose demo, broker test instructions)
- [ ] 6.4 PRD (rule 1): move D5 to Resolved (§14) with the resolution and date; document history v0.10
- [ ] 6.5 Living architecture diagram: add the broker + RabbitMQ adapter path and the compose demo; validate + re-deliver the HTML (Archify, showcase) and visual-check
- [ ] 6.6 Update the AGENTS status line (M7 landed → next M8 `metrics-report`)

## 7. Verification and approval gates

- [ ] 7.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 303 + new)
- [ ] 7.2 Broker evidence: contract + broker suites green against the local broker (`MCPRELAY_RABBITMQ_URL` set); record the run
- [ ] 7.3 Real-server evidence: filesystem (stdio) and the hermetic HTTP fixture under `queue.provider: rabbitmq` — fail → DLQ in the broker → replay → audit, plus one batch run (`run --all`)
- [ ] 7.4 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [ ] 7.5 Human approval to archive (rule 0); archive the change after approval

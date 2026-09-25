# Project — mcprelay

## Product truth

[`docs/PRD.md`](../docs/PRD.md) is the single source of product truth (currently **v0.6**). If code and the PRD disagree, the PRD wins: fix the code or amend the PRD with a document-history entry. Implementation detail belongs in each change's `design.md` and in [`docs/adr/`](../docs/adr/), never in the PRD.

**One-liner:** middleware that sits between MCP clients and MCP servers and gives tool calls what production systems take for granted — policies, observability, and a dead-letter queue with replay.

## Method

Spec-driven via OpenSpec. Each milestone in PRD §12 is one change under `openspec/changes/<id>/` (proposal → design → delta specs → tasks). One change = one capability, one demo beat, ≤ ~4 FRs; split if it grows. Code is written only after the change exists. On completion, archive the change (deltas promote into `openspec/specs/`) and update the status line in [`AGENTS.md`](../AGENTS.md).

**Test-first (AGENTS.md rule 11):** every delta scenario (Given/When/Then) becomes a failing test before its implementation exists; proceed red → green → refactor, task by task. Task phases start with test-writing (see `openspec/schemas/spec-driven/templates/tasks.md`). Rule-based logic (failure classes, policy matchers, idempotency guard, redaction) gets tight unit loops; adapters get contract tests against the port interfaces. Completion metric: every delta scenario maps to a green test.

## Milestones (PRD §12)

| # | OpenSpec id | Deliverable |
|---|---|---|
| M0 | `bootstrap` *(infra chore — no deltas; archived with `--skip-specs`)* | scaffold, toolchain, CI, ADR-0001, LICENSE, CLI skeleton, npm name reservation |
| M1 | `proxy-stdio` | transparent stdio proxy + structured logs (FR-P1–P6, FR-O1) |
| M2 | `retry-pipeline` | timeout + D4 retry taxonomy; config file + CLI flags |
| M3 | `dlq-sqlite` | DLQ capture, `QueueProvider` + SQLite, Store + audit, `replay list/inspect` |
| M4 | `replay-cli` | replay `--dry-run`/`run`, result capture, dedup; first public release |
| M5 | `policy-engine` | FR-Y1–Y6, `policy test` |
| M6 | `http-transport` | Streamable HTTP upstream (same pipeline) |
| M7 | `rabbitmq-batch` | RabbitMQ adapter (D5), batch replay, compose demo |
| M8 | `metrics-report` | FR-O2–O3, `report`, retention |
| M9 | `auth-identities` | FR-A1, FR-A3 |
| M10 | `release-1-0` | README/GIF, examples, launch |

## Stack & constraints

- TypeScript (strict), Node.js ≥ 20.19 (toolchain floor; PRD says ≥ 20), ESM, official MCP TypeScript SDK v2 line, spec revision 2026-07-28.
- OSS-only runtime dependencies (MIT/Apache-2.0/BSD/ISC); prefer Node built-ins. No SaaS/cloud dependency; full functionality offline.
- Exactly two extension ports: `QueueProvider`, `Store`. v1 caps at 2 queue adapters + 1 store adapter.
- Zero intrusion: upstream servers run unmodified; `tools/call` is the only intercepted method.
- Secrets never persist in the clear: redact before persistence; `arguments_hash` over raw args, redacted values stored.
- Local-first defaults: SQLite queue/store, allow-with-warning policy, retries on, redaction on.

## M0 kickoff decision (2026-09-25)

`openspec validate` rejects delta-less changes (verified against OpenSpec 1.3.0). Per PRD §12, M0 therefore ran as a **plain chore**: it kept a proposal + tasks record and was archived with `openspec archive --skip-specs` (OpenSpec's documented path for infrastructure, tooling, and doc-only changes) instead of carrying synthetic delta specs. All later milestones carry real delta specs and archive normally.

## Conventions

- Conventional commits, lowercase, imperative (`docs: …`, `spec: …`, `feat: …`).
- ADRs are numbered (`0001-…`) and record rejected alternatives.
- Public product repo: keep artifacts product-framed; never commit secrets; keep diffs scoped to the milestone's change.

# AGENTS.md

Operating rules for AI agents working in this repository. Applies to humans too.

## Project context

**mcprelay** — the reliability layer for MCP tool calls. A transparent, local-first middleware that wraps any stdio MCP server and adds policy, observability, and a **dead-letter queue with replay** around `tools/call`. The DLQ+replay path (retry → capture → replay) is the core differentiator — do not let it become a footnote.

- **Product truth:** [`docs/PRD.md`](docs/PRD.md) (v0.6). Everything else derives from it.
- **Status (update this line at each milestone):** docs-only — no code yet. Next milestone: **M0 `bootstrap`** (PRD §12).
- **Method:** spec-driven via OpenSpec — every milestone is one change; specs precede code.
- **Acceptance spine:** the §1 60-second demo (wrap → deny → fail → DLQ → replay → report). Every milestone advances exactly one demo beat.

## The rules (non-negotiable)

1. **The PRD wins.** If code and the PRD disagree, the PRD is right — fix the code or file a PRD change. New behavior starts as a PRD change (with a document-history entry), never as code-first drift. Implementation detail lives in `design.md` files and ADRs, not in the PRD.
2. **Spec-first.** Code for a milestone is written only after its OpenSpec change exists (`openspec/changes/<id>/`: proposal → design → delta specs → tasks). Size rule: one change = one capability, one demo beat, ≤ ~4 FRs — split if it grows.
3. **Zero intrusion.** Upstream MCP servers run unmodified — no SDK patching, forks, or sidecars. `tools/call` is the only method with intercepted semantics; every other request/notification passes through unchanged (passthrough matrix, FR-P2). `tools/list` is never filtered by policy (FR-Y5).
4. **Replay semantics.** Replay is redrive for side effects; its (redacted) result is captured into the audit entry — the original caller's session is gone. Never design anything on the assumption that a replay response can be returned to the original agent (PRD §1, *What replay means*).
5. **Failure-class discipline.** Retry eligibility follows the D4 taxonomy (FR-R2): pre-execution transport failures retry; timeouts only for tools marked `idempotent: true`; `isError: true` results never auto-retry (opt-in capture only); `input_required` is not a failure; client cancellation aborts and never enters the DLQ.
6. **Secrets never persist in the clear.** Redact before persistence — arguments, error messages, and replay/audit result payloads. `arguments_hash` is computed over raw args; redacted values are what get stored (NFR-4). Never forward client bearer tokens upstream (FR-A3 — spec-forbidden).
7. **OSS-only, minimal deps.** Every runtime dependency needs a permissive license (MIT/Apache-2.0/BSD/ISC) and a written justification. Prefer Node built-ins. No SaaS/cloud dependency, no network egress to vendor services (P1, P5, NFR-1).
8. **Local-first defaults.** Zero-config must work with safe defaults — SQLite queue/store, allow-with-warning policy, retries on, redaction on (FR-C2, FR-C1).
9. **Scope cap.** Exactly two extension ports (`QueueProvider`, `Store`); v1 caps at 2 queue adapters + 1 store adapter. New adapters, plugins, dashboards, multi-server routing, prompt-injection scanning = out of scope (PRD §10).
10. **Evidence over promises.** Nothing is "done" until it works against a real MCP server. Hermetic tests in CI; anything touching real protocol behavior needs a real-server check (the filesystem server or an `/examples` server) before it counts.
11. **Test-first (TDD).** Every OpenSpec change is developed test-first: each delta scenario (Given/When/Then) becomes a failing test before its implementation exists; work proceeds red → green → refactor, task by task. Rule-based logic (D4 failure classes, policy matchers, idempotency guard, redaction) gets tight unit loops; adapters and process seams get contract tests against the two port interfaces first. Spikes are allowed, but a spike without a following test is debt. The completion metric is scenario → test traceability (every delta scenario maps to a green test), not line coverage. The real-server check (rule 10) stays the final gate — TDD does not replace it.

## Stack & protocol constraints

- TypeScript (strict), Node.js ≥ 20, official MCP TypeScript SDK (v2 line), spec revision 2026-07-28 (FR-P6).
- YAML config (`mcprelay.config.yaml`); CLI flags override file values.
- SQLite for the default queue/store: WAL + busy_timeout — the `replay` CLI and the middleware share the DB files; multiple wrapped servers may share `./.mcprelay/` (NFR-9).
- Middleware overhead budget: ≤ 5 ms p95 excluding upstream, measured by the `bench/` script (NFR-3) — measured, not vibes.

## Workflow

1. Work only the current milestone from PRD §12. If no OpenSpec change exists for it, create it first (proposal + tasks; infra-only changes like M0 carry no delta specs).
2. Implement task-by-task from `tasks.md`, test-first: turn a delta scenario into a failing test, make it green, refactor; keep the delta specs in sync with behavior.
3. Verify: tests + typecheck + lint green; protocol behavior verified against a real server.
4. On completion: archive the change (deltas → `openspec/specs/`), write ADRs for notable decisions in `docs/adr/`, update the status line above, and update the PRD document history if anything was learned that changes the product.

## Repository layout (target — lands at M0; do not scaffold ahead of it)

```
src/          cli/ proxy/ pipeline/ queue/ store/ policy/ config/
examples/     ≥3 public-server recipes + the hermetic failure-injection test server
openspec/     project.md, specs/, changes/
docs/         PRD.md, adr/
bench/        NFR-3 overhead benchmark
```

## Commands

None yet — this is a docs-only repo until M0 lands the toolchain (build/test/lint scripts and `openspec validate` in CI). Do not invent scaffolding before the M0 change; that ordering is the point of the method. When M0 lands, it must bake the test-first cadence (rule 11) in: change templates whose task phases start with test-writing, and CI running the suite on every PR.

## Conventions

- Conventional commits, lowercase, imperative (`docs: …`, `spec: …`, `feat: …`).
- PRD edits bump the version + document history (italic footer). ADRs are numbered (`0001-…`) and record rejected alternatives.
- This is a public product repo: keep all artifacts product-framed — no personal context in code, docs, or commits.
- Never commit secrets. Keep diffs scoped to the milestone's change.

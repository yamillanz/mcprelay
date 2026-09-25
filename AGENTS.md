# AGENTS.md

Operating rules for AI agents working in this repository. Applies to humans too.

> **RULE 0 — HUMAN APPROVAL GATE (the supreme rule; never skip, every session).** No implementation without the human explicitly approving the OpenSpec change. The **human creates the change** with the command (`openspec new change <id>`, or `/opsx:propose`), **reads it** (proposal → design → delta specs → tasks), and **explicitly approves it**. Agents draft and wait — approval is per change and per session and is never assumed. **Commits and pushes are gated the same way: never run `git commit` or `git push` — for any change or refactor to any file — without the human's explicit approval for that specific commit/push.** Full text: rule 0 below; mirrored in `.opencode/` commands/skills and `openspec/schemas/spec-driven/schema.yaml`.

## Project context

**mcprelay** — the reliability layer for MCP tool calls. A transparent, local-first middleware that wraps any stdio MCP server and adds policy, observability, and a **dead-letter queue with replay** around `tools/call`. The DLQ+replay path (retry → capture → replay) is the core differentiator — do not let it become a footnote.

- **Product truth:** [`docs/PRD.md`](docs/PRD.md) (v0.6). Everything else derives from it.
- **Status (update this line at each milestone):** M0 `bootstrap` landed 2026-09-25 — strict TS + vitest + eslint/prettier, CI (incl. `openspec validate`), ADR-0001, CLI skeleton (`version`/`help`, exit codes). Follow-up: npm placeholder publish pending machine auth (`npm publish`). Next milestone: **M1 `proxy-stdio`** (PRD §12).
- **Method:** spec-driven via OpenSpec — every milestone is one change; specs precede code.
- **Acceptance spine:** the §1 60-second demo (wrap → deny → fail → DLQ → replay → report). Every milestone advances exactly one demo beat.

## The rules (non-negotiable)

0. **HUMAN APPROVAL GATE — the supreme rule; overrides every other rule, every agent plan, and every convenience.** Every change requires explicit human approval before implementation. This is never skipped, never assumed, and never "obvious":
   - **The human creates the change** with the command (`openspec new change <id>`, or `/opsx:propose`). Agents MUST NOT create an OpenSpec change on their own initiative — if a change does not exist, stop and ask the human to create it.
   - **The human reads the complete change** (proposal → design → delta specs → tasks) and **explicitly approves it** (e.g. “approved”, “go”, “implement it”). An agent may draft artifacts when the human asks, but drafting is not approval and the agent must never treat its own draft as approved.
   - **Only after that approval** may any agent implement: write code/tests/config, mark tasks complete, or archive. Implementation before approval is forbidden — always, no matter how small, clear, or urgent the work looks.
   - **Commits and pushes need their own explicit approval.** Approval to implement a change is NOT approval to commit or push it. Before every `git commit` or `git push` — for any change or refactor to any file, including docs, config, and governance files — ask the human, state the exact staged scope and commit message, and wait for an explicit yes for *that* commit/push. No checkpoint commits, no progress pushes, no "tests pass so I'll commit". Never commit or push on your own initiative, and never treat implementation approval or a previous commit approval as covering a new one.
   - **Approval is per change and per session, and is never assumed.** It does not carry over from a previous change, milestone, or session, and is never inferred from silence, vague encouragement, urgency, or "you already know what to do". If the human has not approved *this* change *in this session*, stop and ask.
   - **No exceptions** for bug fixes, refactors, docs, config, one-liners, or anything outside the approved change's scope. Out-of-scope work = stop; it needs a new or updated change and a new explicit approval.
   - Mirror points (keep the gate in sync if tooling regenerates them): `.opencode/commands/opsx-*.md`, `.opencode/skills/openspec-*/SKILL.md`, `openspec/schemas/spec-driven/schema.yaml`.
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

1. Work only the current milestone from PRD §12. **The human creates the OpenSpec change with the command** (`openspec new change <id>`, or `/opsx:propose`) — agents never create one on their own initiative (rule 0). Infra-only changes like M0 carry proposal + tasks; capability changes carry proposal → design → delta specs → tasks.
2. **STOP — HUMAN APPROVAL GATE (rule 0).** The human reads the complete change and explicitly approves it *in this session* before anything is implemented. No code, no tests, no config, no task checkmarks until then. If approval has not been given, ask and wait.
3. Implement task-by-task from `tasks.md`, test-first: turn a delta scenario into a failing test, make it green, refactor; keep the delta specs in sync with behavior. Stay strictly inside the approved change's scope — anything else needs a new/updated change and a new approval.
4. Verify: tests + typecheck + lint green; protocol behavior verified against a real server.
5. **Commit & push gate (rule 0).** Before any `git commit` or `git push`, ask the human for explicit approval of *that* commit/push — state the exact staged scope and message — and wait. Passing tests are not approval; implementation approval is not approval to commit or push. Never commit or push partially, speculatively, or "just the docs".
6. On completion: **ask the human before archiving** (archiving is part of the change; rule 0). Then archive the change (deltas → `openspec/specs/`), write ADRs for notable decisions in `docs/adr/`, update the status line above, and update the PRD document history if anything was learned that changes the product. Committing the result follows step 5 — with its own explicit approval.

## Repository layout (target; directories land with their milestone — do not scaffold ahead)

```
src/          cli/ proxy/ pipeline/ queue/ store/ policy/ config/
examples/     ≥3 public-server recipes + the hermetic failure-injection test server
openspec/     project.md, specs/, changes/
docs/         PRD.md, adr/
bench/        NFR-3 overhead benchmark
```

## Commands

M0 landed the toolchain (2026-09-25): `npm run build | typecheck | test | lint | format:check | spec:validate`. CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, tests, build, CLI smoke, and `openspec validate --all` on Node 20 + 22 for every push/PR. The project-local `spec-driven` schema bakes in the test-first cadence (rule 11): task phases start with test-writing.

## Conventions

- Conventional commits, lowercase, imperative (`docs: …`, `spec: …`, `feat: …`).
- PRD edits bump the version + document history (italic footer). ADRs are numbered (`0001-…`) and record rejected alternatives.
- This is a public product repo: keep all artifacts product-framed — no personal context in code, docs, or commits.
- Never commit secrets. Keep diffs scoped to the milestone's change. Never run `git commit` or `git push` without explicit human approval for that specific commit/push (rule 0) — this applies to every change and refactor, in every file.

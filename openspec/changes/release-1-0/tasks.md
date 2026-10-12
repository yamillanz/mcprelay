# Tasks — `release-1-0`

Scenario → evidence traceability: "Three public recipes present" / "Every recipe is smoke-tested" → `tests/examples.test.ts` + README links; "Demo runs end-to-end" → `npm run demo` transcript ending with the file on disk; "GIF is regenerable" → `scripts/demo-gif.mjs` run producing `docs/assets/demo.gif`; "README carries the release surface" → README checklist review; "Published package smoke" → `npx @yamillanz/mcprelay --version` after publish (human step). Docs/tooling groups are not unit-testable product code (rule 11): each states its verification gate instead. §9 gating matrix: group 7.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-12 ("approved, commit and push")

## 1. Baseline

- [ ] 1.1 Full gate on the current code and record: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 380 passed + 5 skipped; specs 14/14 with this change)
- [ ] 1.2 Record the pre-release §9 metric state (already green: compose demo from M7, CI, npm package exists at 0.1.0, FR-P2 test in suite; missing: GIF, public examples, 1.0.0 publish) — the delta group 7 closes

## 2. §1 demo + GIF (D1, D2)

- [ ] 2.1 `scripts/demo.mjs` + `npm run demo`: full §1 flow against the real filesystem server in a temp workspace (call → dry-run + enforced deny → failing write → DLQ → `replay --dry-run` → fix → `replay <id>` → file lands → `report`), printing the ANSI-free transcript — verification gate: run it, transcript ends with the file present
  - Also `package.json` `demo` script entry; document prerequisites in the script header
- [ ] 2.2 `scripts/demo-gif.mjs`: transcript → frames → `docs/assets/demo.gif` (D2 pipeline; ffmpeg, ImageMagick fallback) — verification gate: GIF produced, < ≈ 2 MB, legible at render width
- [ ] 2.3 README hero embeds the GIF (absolute raw URL, D4) — verification gate: GitHub render + npm render after publish (7.4)

## 3. Public examples (D3)

- [ ] 3.1 Write failing `tests/examples.test.ts`: for each recipe, wrap its public server through the middleware, initialize, assert `tools/list` ≥ 1 tool ("Three public recipes present", "Every recipe is smoke-tested") (red — the recipes do not exist yet)
- [ ] 3.2 Add `examples/filesystem/`, `examples/memory/`, `examples/everything/` (config + README each) until the suite is green
- [ ] 3.3 Confirm CI runs the new suite while the hermetic suites stay hermetic (network usage is confined to `tests/examples.test.ts`, pinned versions)

## 4. README release surface (D4)

- [ ] 4.1 Competitive table with per-row repository links (from PRD §5); re-verify every star count at publish time and record date + values in the task ("Release surface" scenario)
- [ ] 4.2 Design-decisions section: 3–4 ADRs with rejected alternatives (0004 DLQ persistence, 0005 replay semantics, 0008 RabbitMQ topology, 0010 identity) — verification gate: checklist review
- [ ] 4.3 Release polish pass: hero order (GIF → one-liner → client-config quickstart), npm scoped-name note, replay-semantics and `tools/list` answers present — verification gate: checklist review ("README carries the release surface")

## 5. Launch kit

- [ ] 5.1 `docs/release/launch-post.md` — "Why your agent's tool calls need a dead-letter queue" (problem-first framing, DLQ GIF, honest replay semantics) — verification gate: review against §9 wording
- [ ] 5.2 `docs/release/submissions.md` — awesome-mcp-servers entry text + r/MCP and Discord drafts (problem, not repo); actual submissions are human actions, listed as such

## 6. Version + publish prep (D5)

- [ ] 6.1 `package.json` → 1.0.0 + `CHANGELOG.md` (1.0.0 entry, keep-a-changelog format)
- [ ] 6.2 `npm pack` → inspect the tarball (dist only + README) and smoke the packed tarball locally (`npx <tarball> --version` → 1.0.0) — verification gate: recorded output
- [ ] 6.3 **Human gate (rule 0):** `npm publish` of 1.0.0 is a human action — then `npx @yamillanz/mcprelay --version` → 1.0.0, recorded ("Published package smoke")

## 7. §9 gating verification matrix (record evidence per metric)

- [ ] 7.1 §1 demo passes on a real server, ending on the visible replayed side effect, recorded as the README GIF (evidence from 2.1/2.2/2.3)
- [ ] 7.2 `docker compose up` demo works (re-run; ends on `demo: OK`)
- [ ] 7.3 CI green on the release commits
- [ ] 7.4 Package published to npm and runnable via `npx` (evidence from 6.3)
- [ ] 7.5 ≥ 3 documented examples with public MCP servers in `/examples` (evidence from group 3)
- [ ] 7.6 Zero-intrusion proof test (FR-P2) present in the suite (name the test file + case)

## 8. Completion (project rules)

- [ ] 8.1 Architecture diagram: **not regenerated** — this change alters no architecture, flow, or component (state the N/A reason here; the diagram stays M9)
- [ ] 8.2 README + AGENTS status line (v1.0 shipped) + PRD document history v0.13 (M10 complete; release notes)
- [ ] 8.3 `craft-reviewer` pass over the change's code artifacts (`scripts/`, `tests/examples.test.ts`, example configs) — verdict APPROVED with gate numbers
- [ ] 8.4 Human approval gates (rule 0): commit/push and archive — ask, state scope and message, and wait

# Tasks — `release-1-0`

Scenario → evidence traceability: "Three public recipes present" / "Every recipe is smoke-tested" → `tests/examples.test.ts` + README links; "Demo runs end-to-end" → `npm run demo` transcript ending with the file on disk; "GIF is regenerable" → `scripts/demo-gif.mjs` run producing `docs/assets/demo.gif`; "README carries the release surface" → README checklist review; "Published package smoke" → `npx @yamillanz/mcprelay --version` after publish (human step). Docs/tooling groups are not unit-testable product code (rule 11): each states its verification gate instead. §9 gating matrix: group 7.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-12 ("approved, commit and push")

## 1. Baseline

- [x] 1.1 Full gate on the current code and record: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 380 passed + 5 skipped; specs 14/14 with this change)
  - Baseline 2026-10-12: all clean; **380 passed + 5 skipped**; `spec:validate` 14/14
- [x] 1.2 Record the pre-release §9 metric state (already green: compose demo from M7, CI, npm package exists at 0.1.0, FR-P2 test in suite; missing: GIF, public examples, 1.0.0 publish) — the delta group 7 closes
  - 2026-10-12: green — compose demo (`examples/rabbitmq-demo`, M7), CI (run 38250975593), npm package exists at 0.1.0, FR-P2 proof test (`tests/proxy.test.ts` → `FR-P2 — passthrough matrix`). Missing: README GIF, public-server examples, 1.0.0 publish + `npx` smoke

## 2. §1 demo + GIF (D1, D2)

- [x] 2.1 `scripts/demo.mjs` + `npm run demo`: full §1 flow against the real filesystem server in a temp workspace (call → dry-run + enforced deny → failing write → DLQ → `replay --dry-run` → fix → `replay <id>` → file lands → `report`), printing the ANSI-free transcript — verification gate: run it, transcript ends with the file present
  - Working end-to-end on the first run: dry-run probe shows `enforced:false` would-deny + the write proceeding; enforced deny `-32001`; `EACCES` write → `tool_error` capture; `replay run` → `replay ok`; `ls` shows `report.txt`; report `calls 4 · allowed 2 · denied 1 · failed 1 · replayed 1`; ends `demo: OK`
- [x] 2.2 `scripts/demo-gif.mjs`: transcript → frames → `docs/assets/demo.gif` (D2 pipeline; ffmpeg, ImageMagick fallback) — verification gate: GIF produced, < ≈ 2 MB, legible at render width
  - 25 frames, 1200×679, **1.16 MB**; scrolling viewport + progressive reveal; color-coded (prompt/log/error); visually verified (first/mid/final frames); `%` escaped for ImageMagick annotate
- [x] 2.3 README hero embeds the GIF (absolute raw URL, D4) — verification gate: GitHub render + npm render after publish (7.4)
  - Absolute raw URL added after the npm note (renders on GitHub + npm once pushed/published)

## 3. Public examples (D3)

- [x] 3.1 Write failing `tests/examples.test.ts`: for each recipe, wrap its public server through the middleware, initialize, assert `tools/list` ≥ 1 tool ("Three public recipes present", "Every recipe is smoke-tested") (red — the recipes do not exist yet)
  - 4 failing cases first (missing configs/READMEs); `startRaw` gained an optional `cwd`; frame reads are keyed by response id (server→client requests answered)
- [x] 3.2 Add `examples/filesystem/`, `examples/memory/`, `examples/everything/` (config + README each) until the suite is green
  - filesystem: `.git/` write/edit guardrail (regex arg rule); memory: `delete_entities` denied (tool-level rule); everything: 5s timeout + idempotent `longRunningOperation` (timeout/DLQ playground) — **4/4 green** (all three public servers wrap and list tools)
- [x] 3.3 Confirm CI runs the new suite while the hermetic suites stay hermetic (network usage is confined to `tests/examples.test.ts`, pinned versions)
  - Network use is confined to the three `npx -y` wraps in the new suite (unpinned on purpose, matching the recipes — D3); all other suites unchanged; full suite **384 passed + 5 skipped**

## 4. README release surface (D4)

- [x] 4.1 Competitive table with per-row repository links (from PRD §5); re-verify every star count at publish time and record date + values in the task ("Release surface" scenario)
  - "How it compares" added with per-row links; counts verified 2026-10-12 via GitHub API: microsoft/mcp-gateway 874★ · P4ST4S/mcp-audit 8★ · rsh1k/mcp-gate 3★ · mcpgatehq/gateward 0★ · JinBeiCN/mcp-gateway 0★ · kgeg401/mcp-guard 0★ · yogesh895/gate-mcp 0★ · bentabol/mcp-retry 0★ · CK-Rajput/mcp-resilient 0★ (re-verify on the day of posting)
- [x] 4.2 Design-decisions section: 3–4 ADRs with rejected alternatives (0004 DLQ persistence, 0005 replay semantics, 0008 RabbitMQ topology, 0010 identity) — verification gate: checklist review
  - "Design decisions" section added; each entry cites its ADR's rejected alternatives (verified against the ADR texts)
- [x] 4.3 Release polish pass: hero order (GIF → one-liner → client-config quickstart), npm scoped-name note, replay-semantics and `tools/list` answers present — verification gate: checklist review ("README carries the release surface")
  - Hero GIF above Quickstart; one-liner + npm note intact; `What replay means` and `tools/list is never filtered` present; status line → v1.0

## 5. Launch kit

- [x] 5.1 `docs/release/launch-post.md` — "Why your agent's tool calls need a dead-letter queue" (problem-first framing, DLQ GIF, honest replay semantics) — verification gate: review against §9 wording
  - Draft written: problem-first, GIF via raw URL, replay-honesty section, "what it is not", try-it block
- [x] 5.2 `docs/release/submissions.md` — awesome-mcp-servers entry text + r/MCP and Discord drafts (problem, not repo); actual submissions are human actions, listed as such
  - Submission kit with both awesome-list candidates, entry line, PR title/body, r/MCP title, Discord message, and the human checklist

## 6. Version + publish prep (D5)

- [x] 6.1 `package.json` → 1.0.0 + `CHANGELOG.md` (1.0.0 entry, keep-a-changelog format)
  - Version bumped; CHANGELOG.md written (Keep a Changelog, full 1.0.0 feature set)
- [x] 6.2 `npm pack` → inspect the tarball (dist only + README) and smoke the packed tarball locally (`npx <tarball> --version` → 1.0.0) — verification gate: recorded output
  - 119 entries (dist + LICENSE + README + package.json, no test/docs bloat); `npx ./yamillanz-mcprelay-1.0.0.tgz --version` → **1.0.0**
- [ ] 6.3 **Human gate (rule 0):** `npm publish` of 1.0.0 is a human action — then `npx @yamillanz/mcprelay --version` → 1.0.0, recorded ("Published package smoke")

## 7. §9 gating verification matrix (record evidence per metric)

- [x] 7.1 §1 demo passes on a real server, ending on the visible replayed side effect, recorded as the README GIF (evidence from 2.1/2.2/2.3)
  - Real filesystem server; `report` shows `replayed 1`; GIF 1.16 MB committed at `docs/assets/demo.gif`
- [x] 7.2 `docker compose up` demo works (re-run; ends on `demo: OK`)
  - 2026-10-12 re-run: `docker compose up --build --abort-on-container-exit --exit-code-from demo` → exit 0; log ends `demo: broker amqp://rabbitmq, queue mcp.dlq` · `step 5: replay ok: 01M4R6G6J4YKHB4ZXQESQV94H8` · **`demo: OK`**; `docker compose down -v` clean
- [ ] 7.3 CI green on the release commits
- [ ] 7.4 Package published to npm and runnable via `npx` (evidence from 6.3)
- [x] 7.5 ≥ 3 documented examples with public MCP servers in `/examples` (evidence from group 3)
  - filesystem · memory · everything — configs + READMEs; `tests/examples.test.ts` 4/4 (all three wrapped, `tools/list` ≥ 1)
- [x] 7.6 Zero-intrusion proof test (FR-P2) present in the suite (name the test file + case)
  - `tests/proxy.test.ts` → `FR-P2 — passthrough matrix` (green in the full suite)

## 8. Completion (project rules)

- [x] 8.1 Architecture diagram: **not regenerated** — this change alters no architecture, flow, or component (state the N/A reason here; the diagram stays M9)
  - N/A confirmed: no `src/` change, no new component or flow; the diagram's M9 revision remains accurate
- [x] 8.2 README + AGENTS status line (v1.0 shipped) + PRD document history v0.13 (M10 complete; release notes)
  - README status → v1.0; AGENTS status line → v1.0.0 released 2026-10-12 + post-v1 backlog; PRD history v0.13 added
- [x] 8.3 `craft-reviewer` pass over the change's code artifacts (`scripts/`, `tests/examples.test.ts`, example configs) — verdict APPROVED with gate numbers
  - Round 1: CHANGES_REQUIRED (1 BLOCKER: `npm run lint` failed — 14 × no-undef in `scripts/**.mjs`, masked locally by a `| tail` pipeline; 4 MAJORs). All fixed: eslint globals extended to `scripts/**/*.mjs`; demo self-enforces the side effect (`replay.status === 0 && existsSync` → else `demo: FAILED` + exit 1); `execCli`/`runCli` split, dead `cwd` removed; session plumbing extracted to `scripts/demo-session.mjs` (named `drainLines`, waiter records, internal id counter); log-line cross-pipe race fixed (`collectLogLines`, stable-count wait); try/finally cleanup in demo + test; `DEMO_GIF_FONT`/`BOTTOM_PAD`/`PALETTE_COLORS`/`ERROR_MESSAGE_MAX` constants.
  - Round 2 (delta re-review): **VERDICT: APPROVED** — 0 BLOCKERS, 0 MAJORS (demo.mjs 211-line band explicitly justified: single-responsibility linear flow + embedded config fixture, `// gate-exemption:` receipt added), 1 MINOR (takeFrame callback-depth 2) fixed on the spot; all functions re-measured within gates; no `src/` changes; suite 384+5, lint exit 0 direct.
- [ ] 8.4 Human approval gates (rule 0): commit/push and archive — ask, state scope and message, and wait

# Tasks — `replay-cli-refactor`

Behavior-preserving refactor: characterization tests are written **first** (they lock current behavior), then each extraction step keeps the full suite green. No existing assertion changes.

Scenario → test traceability: "Characterization tests lock every case" → `tests/replay-cli.test.ts` (parser characterization); "Existing suite passes unchanged" → full suite; "Parsers read as named steps" / "Helpers stay co-located" → code inspection plus the untouched suite.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session** (approved 2026-09-30)

## 1. Baseline evidence

- [x] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` (expect 227/227)
  - Baseline 2026-09-30: typecheck/lint/format/build/build:examples clean; **227/227** tests (20 suites)
- [x] 1.2 Record the current CLI behavior (exit code + message) for every parser case below as the pre-refactor reference
  - Baseline 2026-09-30 (`dist/cli/index.js`, all exit 2 + first stderr line):
    - `replay list --config|--tool|--correlation-id|--since|--until|--status` → `Missing value for '<flag>'.`
    - `replay list --status bogus` → `Invalid status 'bogus'.`
    - `replay list --limit` → `Invalid value for '--limit': undefined`
    - `replay list --limit abc|0` → `Invalid value for '--limit': <value>`
    - `replay list --bogus` / `replay run --bogus` → `Unknown option '<token>'.`
    - `replay inspect` / `replay inspect --json` → `Missing record id. Usage: mcprelay replay inspect <id>`
    - `replay inspect one two` → `Unknown option 'two'.`
    - `replay run` / `replay run --dry-run` / `replay run --force --json` → `Missing record id. Usage: mcprelay replay run <id>`
    - `replay run --set` → `Missing value for '--set'.`
    - `replay run --set nope` → `Invalid --set 'nope'; expected key=value.`
    - `replay run a b` → `Unknown option 'b'.`

## 2. Characterization tests (lock every parser case before extraction)

- [x] 2.1 Write characterization tests in `tests/replay-cli.test.ts`: missing values for `--config` / `--tool` / `--status` / `--set`; invalid `--status`; invalid and missing `--limit` (including the `undefined` message); invalid `--set` shapes; unknown options for list/inspect/run; positional-id rules (`inspect` accepts one, `run` requires one, extra positionals are unknown options); `--dry-run` / `--force` / `--json` accepted — all green on the unchanged code
  - 21 characterization cases added (`replay parser characterization`), green on the unchanged code
- [x] 2.2 Confirm no existing assertion changed and the suite is green (227 + new)
  - No existing assertion touched; **248/248** (227 + 21)

## 3. Extract `parseReplayTokens` cases (same file)

- [x] 3.1 Add the `Step` union and `readOptionValue`; extract `consumeConfigPath`, `consumeJsonFlag`, `consumeFilterOption`, `consumeStatus`, `consumeLimit`, `consumeInspectId` plus the `consumeReplayToken` dispatcher; suite green after each extraction
  - Extracted in one pass; `tests/replay-cli.test.ts` 29/29, full suite 248/248
- [x] 3.2 Rewrite `parseReplayTokens` as loop + dispatcher + final id check ("Parsers read as named steps"); suite green
  - Body is now: token loop → `consumeReplayToken` → final inspect-id check

## 4. Extract `parseRunTokens` cases (same file)

- [x] 4.1 Extract `consumeSetOverride`, `consumeBooleanFlag`, `consumeRunId` plus the `consumeRunToken` dispatcher; suite green
  - `tests/replay-cli.test.ts` + `tests/replay-run.test.ts` 42/42
- [x] 4.2 Rewrite `parseRunTokens` as loop + dispatcher + final id check ("Helpers stay co-located": no new file, module, or class); suite green
  - Only `src/replay/replay-cli.ts` changed; helpers are private top-level functions

## 5. Verification and approval gates

- [x] 5.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
  - 2026-09-30: typecheck/lint/format/build/build:examples clean; **248/248**; `spec:validate` 10/10
- [x] 5.2 Repeat the recorded baseline CLI invocations and confirm identical output/exit codes ("Parser behavior preserved")
  - 21/21 cases identical to the 1.2 baseline (exit 2 + same first stderr line)
- [x] 5.3 Docs/diagram: none — file-local refactor alters no architecture, flow, or component; README, AGENTS status line, and PRD stay untouched (note it here)
  - Confirmed: only `src/replay/replay-cli.ts` changed (plus characterization tests); no diagram regeneration, no docs changes
- [x] 5.4 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
  - Approved 2026-09-30: `428b650` refactor (+ `e5a0d0a` spec) pushed to `origin/main`
- [x] 5.5 Human approval to archive (rule 0); archive the change after approval
  - Approved and archived 2026-09-30 as `2026-09-30-replay-cli-refactor`

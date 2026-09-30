# Tasks — `replay-cli-refactor`

Behavior-preserving refactor: characterization tests are written **first** (they lock current behavior), then each extraction step keeps the full suite green. No existing assertion changes.

Scenario → test traceability: "Characterization tests lock every case" → `tests/replay-cli.test.ts` (parser characterization); "Existing suite passes unchanged" → full suite; "Parsers read as named steps" / "Helpers stay co-located" → code inspection plus the untouched suite.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session** (approved 2026-09-30)

## 1. Baseline evidence

- [ ] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` (expect 227/227)
- [ ] 1.2 Record the current CLI behavior (exit code + message) for every parser case below as the pre-refactor reference

## 2. Characterization tests (lock every parser case before extraction)

- [ ] 2.1 Write characterization tests in `tests/replay-cli.test.ts`: missing values for `--config` / `--tool` / `--status` / `--set`; invalid `--status`; invalid and missing `--limit` (including the `undefined` message); invalid `--set` shapes; unknown options for list/inspect/run; positional-id rules (`inspect` accepts one, `run` requires one, extra positionals are unknown options); `--dry-run` / `--force` / `--json` accepted — all green on the unchanged code
- [ ] 2.2 Confirm no existing assertion changed and the suite is green (227 + new)

## 3. Extract `parseReplayTokens` cases (same file)

- [ ] 3.1 Add the `Step` union and `readOptionValue`; extract `consumeConfigPath`, `consumeJsonFlag`, `consumeFilterOption`, `consumeStatus`, `consumeLimit`, `consumeInspectId` plus the `consumeReplayToken` dispatcher; suite green after each extraction
- [ ] 3.2 Rewrite `parseReplayTokens` as loop + dispatcher + final id check ("Parsers read as named steps"); suite green

## 4. Extract `parseRunTokens` cases (same file)

- [ ] 4.1 Extract `consumeSetOverride`, `consumeBooleanFlag`, `consumeRunId` plus the `consumeRunToken` dispatcher; suite green
- [ ] 4.2 Rewrite `parseRunTokens` as loop + dispatcher + final id check ("Helpers stay co-located": no new file, module, or class); suite green

## 5. Verification and approval gates

- [ ] 5.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [ ] 5.2 Repeat the recorded baseline CLI invocations and confirm identical output/exit codes ("Parser behavior preserved")
- [ ] 5.3 Docs/diagram: none — file-local refactor alters no architecture, flow, or component; README, AGENTS status line, and PRD stay untouched (note it here)
- [ ] 5.4 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [ ] 5.5 Human approval to archive (rule 0); archive the change after approval

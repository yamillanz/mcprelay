# Tasks — `refactor-intercept-call`

Behavior-preserving refactor: the existing suite is the characterization (the method's branches are locked by the identity, policy, retry, idempotency, capture, and cancellation session tests). Each extraction step keeps the full suite green with zero assertion edits; a gap found during extraction gets a characterization test **before** the extraction that touches it.

Scenario → test traceability: "Handler reads as named gates" / "Helpers stay co-located" → code inspection; "Helpers stay within measured limits" → measured numbers in task 3.1; "Existing suite passes unchanged" → full suite with `tests/` diff empty; "Protocol parity on the real server" → task 3.3 smoke; "No hot-path overhead added" → code inspection (per-call write counts unchanged; `bench/` remains the future arbiter).

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-11 ("this change is approved commit and push"); the `bench/` NFR-3 follow-up was also approved for the record (proposal · Follow-ups)

## 1. Baseline evidence

- [x] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 380 passed + 5 skipped; specs 13/13)
  - Baseline 2026-10-11: typecheck/lint/format/build/build:examples clean; **380 passed + 5 skipped**; `spec:validate` 14/14 (the new change included)
- [x] 1.2 Record the measured before-numbers of `interceptToolCall` as the pre-refactor reference (2026-10-11: ~183 body lines, nesting 5, complexity 18, callback depth 1, params 3; `bridge.ts` 835 lines)
  - Measured on the M9 code: body ~183 (BLOCKER >60), nesting 5 (BLOCKER ≥4 — `if(kind)` → `if(!isError&&key)` → `try` → `catch`), complexity 18 (BLOCKER >10), callback depth 1 ok, params 3 ok

## 2. Extract gates/steps (same file; suite green after each step, no assertion edits)

- [x] 2.1 `prepareCallContext` + `CallContext`/`logFields` (replaces the preamble and the `logBase` literal + five spreads); suite green
  - Context resolves identity + policy + metadata once; **380 passed + 5 skipped** after the step
- [x] 2.2 Credential gate: `denyCredential` (log + audit) with the `-32003` throw kept in the handler; suite green
  - `authFailureMessage` shared by the log entry and the throw; **380 passed + 5 skipped**
- [x] 2.3 Policy gate: `logPolicyWouldDeny` (dry-run, enforced:false, call proceeds) and `denyByPolicy` (log + audit) with the `-32001` throw kept in the handler; suite green
  - `policyDeniedMessage` shared by both log entries + audit + the throw; **380 passed + 5 skipped**
- [x] 2.4 `attemptToolCall` named function lifting the `runWithRetry` attempt arrow; suite green
  - Split into `attemptToolCall` (connected guard) + `relayToolCall` (try/catch) so each stays ≤2 nesting; **380 passed + 5 skipped**
- [x] 2.5 Result tail: `finalizeSuccessfulCall` + `recordIdempotentExecution` (nested `try/catch` moves into that helper at depth ≤ 2); suite green
  - Capture/idempotency/log restructured as `if (isError) {…} else if (key) {…}` (equivalent to the two guards); **380 passed + 5 skipped**
- [x] 2.6 `failToolCall` terminal (cancelled log+throw / D4 capture + failed log+throw) and the handler's final shape (`return kind === 'result' ? finalizeSuccessfulCall(…) : failToolCall(…)`); suite green
  - Terminal via if/else return (`Promise<never>` helper); no unreachable tail; **380 passed + 5 skipped**
  - `git diff --name-only tests/` empty after every step — zero assertion edits

## 3. Verification

- [x] 3.1 Re-measure every extracted helper and the handler; record the table here — all within gates (body ≤ 40, nesting ≤ 2, complexity ≤ 6, params ≤ 3)
  - Analyzer-counted (body lines = non-blank, excl. signature/braces; try/catch counted as one construct level):
    `prepareCallContext` 16/0/2·p2 · `logFields` 9/0/1·p2 · `authFailureMessage` 1/0/1·p1 · `denyCredential` 15/0/1·p3 · `policyDeniedMessage` 1/0/1·p2 · `logPolicyWouldDeny` 12/0/1·p3 · `denyByPolicy` 11/0/1·p3 · `attemptToolCall` 7/1/2·p3 · `relayToolCall` 13/1/3·p3 · `recordIdempotentExecution` 12/1/3·p3 · `finalizeSuccessfulCall` 30/2/6·p3 · `failToolCall` 37/1/5·p3 · `interceptToolCall` 35/2/5·p3 — **all OK** (vs before: 183/5/18)
- [x] 3.2 Full gate hermetic: typecheck/lint/format/build/build:examples clean, suite green, `spec:validate` green; confirm `git diff` shows no test edits
  - 2026-10-11: all clean; **380 passed + 5 skipped**; `spec:validate` 14/14; `git diff --name-only tests/` → empty
- [x] 3.3 Real-server smoke (rule 10) against the filesystem server: profile call allowed, caller-rule denial, keyed call allowed, unknown key rejected — record the outputs and compare with the M9 evidence
  - 2026-10-11 (refactored build, real filesystem server): identical to the M9 record — decisions by caller `agent-a:read_file:allowed`, `reviewer-bot:read_file:allowed`, `reviewer-bot:write_file:denied`, `unauthenticated:read_file:denied`; rejected write never executed; credential absent from stderr; report totals `{calls:4, allowed:2, denied:2}` with the same 4 per-identity rows; **metrics match logs: true**
- [x] 3.4 Delegate to `craft-reviewer` with the changed-file list and the acceptance criteria; iterate to **VERDICT: APPROVED** with the per-function numbers printed
  - **VERDICT: APPROVED** — 0 BLOCKERS, 0 MAJORS, 4 MINORS; all 13 units independently re-measured within gates (interceptToolCall 35/2/5·p3 vs before 183/5/18 — the three BLOCKERs resolved); behavior parity verified line-by-line vs HEAD; full gate re-run by the reviewer clean
  - MINOR 1 (file 955 lines >400 — pre-existing, follow-up recorded in the proposal; needs its own change, rule 0) · MINOR 2 (two `result.outcome` narrowing casts, runtime-sound, documented in D5 — accepted, "do not churn now") · MINOR 3 (D5 ternary wording — corrected now) · MINOR 4 (D2 allocations wording — corrected now)

## 4. Ship gates (rule 0 — each needs explicit approval)

- [x] 4.1 Human approval for the commit/push — state the exact staged scope and message and wait
  - Approved 2026-10-12 ("yes, approved, commit and push, next archive it, commit and push again")
- [ ] 4.2 Human approval to archive; archive the change after approval

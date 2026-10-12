# Tasks — `refactor-intercept-call`

Behavior-preserving refactor: the existing suite is the characterization (the method's branches are locked by the identity, policy, retry, idempotency, capture, and cancellation session tests). Each extraction step keeps the full suite green with zero assertion edits; a gap found during extraction gets a characterization test **before** the extraction that touches it.

Scenario → test traceability: "Handler reads as named gates" / "Helpers stay co-located" → code inspection; "Helpers stay within measured limits" → measured numbers in task 3.1; "Existing suite passes unchanged" → full suite with `tests/` diff empty; "Protocol parity on the real server" → task 3.3 smoke; "No hot-path overhead added" → code inspection (per-call write counts unchanged; `bench/` remains the future arbiter).

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-11 ("this change is approved commit and push"); the `bench/` NFR-3 follow-up was also approved for the record (proposal · Follow-ups)

## 1. Baseline evidence

- [ ] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 380 passed + 5 skipped; specs 13/13)
- [ ] 1.2 Record the measured before-numbers of `interceptToolCall` as the pre-refactor reference (2026-10-11: ~183 body lines, nesting 5, complexity 18, callback depth 1, params 3; `bridge.ts` 835 lines)

## 2. Extract gates/steps (same file; suite green after each step, no assertion edits)

- [ ] 2.1 `prepareCallContext` + `CallContext`/`logFields` (replaces the preamble and the `logBase` literal + five spreads); suite green
- [ ] 2.2 Credential gate: `denyCredential` (log + audit) with the `-32003` throw kept in the handler; suite green
- [ ] 2.3 Policy gate: `logPolicyWouldDeny` (dry-run, enforced:false, call proceeds) and `denyByPolicy` (log + audit) with the `-32001` throw kept in the handler; suite green
- [ ] 2.4 `attemptToolCall` named function lifting the `runWithRetry` attempt arrow; suite green
- [ ] 2.5 Result tail: `finalizeSuccessfulCall` + `recordIdempotentExecution` (nested `try/catch` moves into that helper at depth ≤ 2); suite green
- [ ] 2.6 `failToolCall` terminal (cancelled log+throw / D4 capture + failed log+throw) and the handler's final shape (`return kind === 'result' ? finalizeSuccessfulCall(…) : failToolCall(…)`); suite green

## 3. Verification

- [ ] 3.1 Re-measure every extracted helper and the handler; record the table here — all within gates (body ≤ 40, nesting ≤ 2, complexity ≤ 6, params ≤ 3)
- [ ] 3.2 Full gate hermetic: typecheck/lint/format/build/build:examples clean, suite green, `spec:validate` green; confirm `git diff` shows no test edits
- [ ] 3.3 Real-server smoke (rule 10) against the filesystem server: profile call allowed, caller-rule denial, keyed call allowed, unknown key rejected — record the outputs and compare with the M9 evidence
- [ ] 3.4 Delegate to `craft-reviewer` with the changed-file list and the acceptance criteria; iterate to **VERDICT: APPROVED** with the per-function numbers printed

## 4. Ship gates (rule 0 — each needs explicit approval)

- [ ] 4.1 Human approval for the commit/push — state the exact staged scope and message and wait
- [ ] 4.2 Human approval to archive; archive the change after approval

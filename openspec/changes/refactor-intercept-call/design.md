# Design — `refactor-intercept-call`

## Context

`interceptToolCall` is the interception spine: it carries the M9 auth gate (FR-A1/A3, ADR-0010), policy enforcement with dry-run (FR-Y4), the retry pipeline with D4 failure classes (FR-R2), idempotency recording, tool-error capture, and the FR-O1 log line — all behavior specced and locked by tests. What has no contract is the structure, and the structure is now the risk: **183 body lines / nesting 5 / complexity 18** (all three craft-gates BLOCKERs), measured 2026-10-11. `bridge.ts` totals 835 lines (file gate BLOCKER — recorded as a follow-up, out of scope).

Constraints: the handler is the hot path (once per intercepted call), so extraction must not add per-call I/O, serialization, or allocations beyond what exists (the `logBase` object is already allocated per call); behavior must be preserved byte-for-byte; repo convention (`maintainability`) is same-file helpers with descriptive names — no new modules, classes, or indirection without a measured reason.

## Goals / Non-Goals

**Goals:**

- The handler body reads as ordered named gates: prepare → credential gate → policy gate → execute → outcome, with control flow (throws, dry-run continue) visible in the handler.
- Every extracted helper is a top-level function in `src/proxy/bridge.ts` measuring within the gates: body ≤ 40 lines, nesting ≤ 2, complexity ≤ 6, params ≤ 3.
- Behavior preservation proven by the unchanged existing suite (the session tests are the characterization), the real-server smoke parity check, and re-measured gate numbers recorded in the tasks.

**Non-Goals:**

- Any behavior, message, exit-code, log-shape, or public-interface change.
- Splitting `bridge.ts` (follow-up), new files/modules/exports/dependencies, diagram regeneration.
- Performance work beyond not regressing NFR-3.

## Decisions

### D1 — Orchestrator as ordered gates; helpers own side effects, the handler owns control flow

The handler keeps every `throw` and the dry-run continue adjacent to its gate condition; helpers perform only the persistence/log side effects. Rejected: gate helpers that throw internally (hides control flow inside names), a pipeline/strategy abstraction over the gates (no second user — speculative generality).

### D2 — One context object replaces the `logBase` clump (Parameter Object — trigger: the same field set rebuilt at 6 sites)

`CallContext` = `{ tool, rawArguments, idempotencyKey, policy, metadata (correlationId, progressToken, params, trace), requestBytes, startedAt, caller }`, built by `prepareCallContext(deps, request)`; `logFields(deps, context)` derives the existing `CallLogFields` once per call, replacing the inline `logBase` literal and its five spreads. Per-call allocations are unchanged.

### D3 — Gates

- Credential gate: `resolveIdentity` inline in the handler; on failure `denyCredential(deps, context, reason)` logs `denied` (caller `unauthenticated`) + audits `{ action: 'auth' }`, then the handler throws `ProtocolError(-32003, …)`.
- Policy gate: nested two-level — `if (deny) { if (dryRun) await logPolicyWouldDeny(…) (stderr + log `enforced:false`, call proceeds); else { await denyByPolicy(…) (log + audit); throw ProtocolError(-32001, …); } }`.

### D4 — Execution: named attempt, unchanged retry contract

`attemptToolCall(deps, context, signal): Promise<AttemptOutcome>` — a named top-level function replacing the inline `attempt` arrow: connected guard → `try` relay → `catch` → `failurePhase`. `classify` and `policy` objects pass through unchanged.

### D5 — Outcome tail

`result.outcome.kind === 'result'` → `finalizeSuccessfulCall(deps, context, result): Promise<CallToolResult>` (tool-error capture when configured; `recordIdempotentExecution` when a key exists — the nested `try/catch` lives in that helper at depth ≤ 2; log `allowed`/`failed`; return value). Otherwise `failToolCall(deps, context, result): Promise<never>` — cancelled logs + throws; other outcomes capture per D4 when recordable, log `failed`, throw. The handler returns the ternary `return kind === 'result' ? finalizeSuccessfulCall(…) : failToolCall(…)` so there is no unreachable tail.

## Testing / Verification Strategy

1. Baseline: full hermetic gate + the before-numbers recorded in the tasks.
2. After each extraction step: full suite green, zero assertion edits (`git diff` on `tests/` empty).
3. Final: re-measure every helper + handler; all within gates; numbers recorded.
4. Rule 10: real-server smoke on the filesystem server (profile call allowed, caller-rule denial, keyed call allowed, unknown key rejected) with outcomes matching the M9 evidence.
5. `craft-reviewer` verdict APPROVED with the printed per-function numbers.

## Risks / Trade-offs

- Per-call indirection risk is mitigated by same-file top-level functions and unchanged per-call work; `bench/` remains the future arbiter (same caveat as `refactor-run-transport`).
- `Promise<never>` terminal helpers rely on TS control flow; both are two-line-return helpers with documented contracts — chosen over duplicating throws in the handler.

# Proposal — `refactor-intercept-call`

## Why

`interceptToolCall` (`src/proxy/bridge.ts:503`) is the spine every intercepted `tools/call` runs through, and it has regressed to BLOCKER-level craft gates, measured 2026-10-11 on the archived M9 code:

- **~183 body lines** (gate ≤ 40; BLOCKER > 60)
- **max nesting 5** (gate ≤ 2; BLOCKER ≥ 4) — the idempotency `try/catch` sits inside `if (!isError && key !== undefined)` inside `if (result.outcome.kind === 'result')`
- **cyclomatic complexity 18** (gate ≤ 6; BLOCKER > 10) — 16 branch points across four distinct policies

Across milestones the handler absorbed four concerns inline: the M9 auth-denial block (log + audit + throw built inline), the M6 policy deny/dry-run pair with two mirrored log constructions, the retry pipeline's anonymous `attempt` arrow, and the result tail (tool-error capture, idempotent-execution record with its own nested `try/catch`, cancelled-vs-failed logging). Each milestone added "one more thing" to the same block; the project owner asked for the same treatment `parseRunInvocation` and the transports received in `refactor-run-transport`: entry points that read as ordered named steps, with per-concern helpers carrying descriptive names.

## What Changes

- Restructure `interceptToolCall` into an ordered sequence of named gates/steps — **prepare → credential gate → policy gate → execute → outcome** — with every extracted helper a top-level function in the same file (`src/proxy/bridge.ts`). Control flow (the `-32001`/`-32003` throws, the dry-run continue) stays visible in the handler body; helpers own the side effects (log, audit, capture, idempotency record).
- Extract, same file: `prepareCallContext` (the preamble: tool, raw arguments, idempotency key, resolved policy, call metadata, request bytes, started-at, caller), `denyCredential` (auth-rejection log + audit), `logPolicyWouldDeny` / `denyByPolicy` (dry-run vs enforced denial persistence), `attemptToolCall` (named function lifting the `runWithRetry` attempt arrow), `finalizeSuccessfulCall` + `recordIdempotentExecution` (result tail; the nested `try/catch` moves into its own helper at depth ≤ 2), and `failToolCall` (cancelled vs captured-failure terminal).
- Replace the inline `logBase` literal and its five spreads with one context object + one `logFields` derivation (Parameter Object — trigger: the same field clump rebuilt at 6 log-construction sites).
- Preserve behavior exactly: error codes (`-32001`, `-32003`), messages, log/event/audit/record shapes, dry-run semantics, D4 capture classes, cancellation, idempotency recording, and hot-path structure (no new per-call I/O, serialization, or allocations beyond what exists). The existing suite passes **without assertion edits**.
- Extend the `maintainability` capability with the interception-shape contract (named gates, co-located helpers, measured limits). No delta to capability behavior specs.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `maintainability`: adds `Readable tools/call interception` — the handler body reads as the named gates in order with every throw site adjacent to its gate condition, helpers stay co-located in `src/proxy/bridge.ts`, every extracted helper stays within the measured function gates (body ≤ 40 lines, nesting ≤ 2, complexity ≤ 6, params ≤ 3), the existing suite passes unchanged, protocol parity holds on the real filesystem server, and no hot-path overhead is added.

## Impact

- **Code**: `src/proxy/bridge.ts` (structure only). `InterceptionDeps`, `createClientServerFactory`, and every export keep their signatures.
- **Tests**: none added up front — the method's branches are already locked by session tests (identity resolution/rejection/report in `tests/call-log.test.ts`, policy enforcement + dry-run, retry failure classes, idempotency recording, tool-error/failure capture, cancellation). Tasks verify no assertion changes; any gap found during extraction gets a characterization test **before** the extraction that touches it.
- **Unchanged**: protocol behavior, CLI/config surface, dependencies, architecture, flow, components (the living diagram is not regenerated).

## Follow-ups (out of scope, recorded)

- `src/proxy/bridge.ts` measures 835 lines pre-refactor (>400 file gate) — 955 after, since extraction nets +120 in-file while resolving the three function BLOCKERs — a same-file-helpers split into a second bridge module needs its own decision and change (craft-reviewer 2026-10-11: "must not be deferred indefinitely").
- The NFR-3 arbiter does not exist yet: `bench/` (middleware-only p95 ≤ 5 ms) needs its own change. Recorded 2026-10-11 with measured context — extraction boundary cost ~184 ns/call (microbench, best of 5 × 200k iterations) vs p50 0.34 ms / p95 1.03 ms per real intercepted call on the current build.

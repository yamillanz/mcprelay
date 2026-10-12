# Tasks — `code-tours`

Scenario → evidence traceability: "Format present" / "Blocks match the source" → per-tour spot-check recorded here + the reviewer pass; "Catalog present and indexed" → `docs/code-tours/README.md` inspection; "Bridge tour is current" → rewritten tour vs `src/proxy/bridge.ts`; "Source change carries its tour" → convention specced in the capability (enforced by review, not a machine gate); "Mirror commit recorded" → header diff target. Docs-only change (rule 11 note): the verification gate for every task is the spot-check against the source at the recorded commit + the final reviewer pass; `docs/` is outside the prettier gate.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-12 ("approved, only commit and push... no apply yet") — implementation deferred by choice; run `/opsx-apply code-tours` when ready

## 1. Baseline

- [x] 1.1 Record the catalog state and the mirrored-commit target: `git rev-parse --short HEAD` (every new/updated tour header will name it); confirm `docs/code-tours/` currently holds only the M1-era `bridge.md`
  - Mirrored commit: `cefe854`; catalog confirmed: only the M1-era `bridge.md` (628 lines, superseded)
- [x] 1.2 Re-confirm the ranked file list against the design's D1 table (line counts and paths still current)
  - 2026-10-12: bridge 955 · transports 372 · replay-run 548 · sqlite-queue 351 · retry 69 + classify 95 · store 334 — unchanged from the design

## 2. Rewrite `docs/code-tours/bridge.md`

- [x] 2.1 Rewrite the tour against the current `src/proxy/bridge.ts` (blocks: imports/contracts, internal vocabulary incl. `CallContext`/`LogBase`, data helpers, close signals, transports/batches wiring, upstream client + server→client relays, connect/session, `createRelayRequest`, the interception gates — `prepareCallContext`, credential gate `denyCredential`, policy gate, `attemptToolCall`/`relayToolCall`, `finalizeSuccessfulCall`/`recordIdempotentExecution`, `failToolCall` — plus `relayPassthroughRequest`, the server factory, and `startBridge`), keeping the established format and pointing "next stop" at `transports.md`
  - Rewritten as 13 blocks (A–M) mirroring the file's real organization; header updated (layers M1–M9, mirror commit `cefe854`); glossary refreshed (gate, D4, capture, HTTP); "next stop" → `transports.md`
- [x] 2.2 Spot-check every block against the source at the recorded commit (signatures + key branches; elisions marked) and record the compared symbols here
  - Mechanical fidelity check (every non-elision line inside the 13 ```ts fences must exist verbatim in `src/proxy/bridge.ts` @ `cefe854`): **13 blocks, 0 missing lines** (`/tmp/opencode/tour-check.py`); no elisions needed

## 3. `docs/code-tours/transports.md`

- [x] 3.1 Write the tour for `src/proxy/transports.ts` (`FrameDecoder`, both stdio transports, `HttpUpstreamLink`, lifecycle steps, batch/notification dispatch)
  - Written as 9 blocks (A–H, C split in two); stories covered: the shared decoder + microtask yield, closing-vs-crash semantics, the transport-agnostic `UpstreamLink` port, and the wrap-`onmessage`-after-connect subtlety over HTTP
- [x] 3.2 Spot-check blocks vs source; record compared symbols
  - Mechanical check: **9 blocks, 0 missing lines** vs `src/proxy/transports.ts` @ `cefe854`

## 4. `docs/code-tours/replay-run.md`

- [x] 4.1 Write the tour for `src/replay/replay-run.ts` (redrive execution, dedup guard, atomic claim/resolve, result capture into audit; cross-reference `guards.ts`/`command-line.ts`/`replay-cli.ts` as thin neighbors)
  - Written as 11 blocks (A–K); stories covered: unreachable-vs-executed, redaction-in-the-boundary, guard-before-claim-before-execute, release/resolve semantics, the `effects: read` hint, and the batch's skipped-counts-for-exit-code decision
- [x] 4.2 Spot-check blocks vs source; record compared symbols
  - Mechanical check: **11 blocks, 0 missing lines** vs `src/replay/replay-run.ts` @ `cefe854`

## 5. `docs/code-tours/sqlite-queue.md`

- [x] 5.1 Write the tour for `src/queue/sqlite-queue.ts` (capture-before-error, the `QueueProvider` contract as implemented, atomic `claim`/`resolve`, dedup index; note the RabbitMQ mirror)
  - Written as 9 blocks (A–I); stories covered: schema-as-record-mirror, in-place migration, busy_timeout-before-WAL, atomic UPDATE…WHERE resolve/claim with typed disambiguation, claim lease, upsert executions
- [x] 5.2 Spot-check blocks vs source; record compared symbols
  - Mechanical check: **9 blocks, 0 missing lines** vs `src/queue/sqlite-queue.ts` @ `cefe854`

## 6. `docs/code-tours/retry-pipeline.md`

- [x] 6.1 Write the tour for `src/pipeline/retry.ts` + `src/pipeline/classify.ts` (the D4 taxonomy, retry eligibility, bounded backoff, the attempt loop)
  - Written as 5 blocks (A–E); stories covered: the pure contract with injectable sleep/random, full-jitter backoff, the loop's single continuation door (`classification.retry`), and the full D4 decision order (conservative on every ambiguity)
- [x] 6.2 Spot-check blocks vs source; record compared symbols
  - Mechanical check: **5 blocks, 0 missing lines** vs the concatenation of both sources @ `cefe854`

## 7. `docs/code-tours/sqlite-store.md`

- [x] 7.1 Write the tour for `src/store/sqlite-store.ts` (audit entries, call events, `metrics`, retention; replay outcomes live here)
  - Written as 7 blocks (A–G); stories covered: log-parity call events, nearest-rank percentiles, errors=failed-only, `replayed` counted from the audit, retention pruning call_events on open (audit untouched), append-only audit
- [x] 7.2 Spot-check blocks vs source; record compared symbols
  - Mechanical check: **7 blocks, 0 missing lines** vs `src/store/sqlite-store.ts` @ `cefe854`

## 8. Index + completion

- [x] 8.1 `docs/code-tours/README.md`: catalog table (source, lines, tour, rank rationale), deferred wave with reasons (D1), drift rule
  - Index written: catalog with the 6 ranked entries, two suggested reading orders, deferred wave with reasons, per-tour structure and the drift rule
- [x] 8.2 Final link sweep: every tour's source link and next-stop link resolves; every header records the mirrored commit
  - Scripted sweep: all relative links resolved (see record below); all 6 tours carry the `espejo de … cefe854` header
- [x] 8.3 `craft-reviewer` pass over the catalog (fidelity sample vs sources at the recorded commit, format compliance, index accuracy) — verdict APPROVED
  - Round 1: CHANGES_REQUIRED (2 MAJORs: unmarked elisions — `HttpUpstreamLink.close()` + the replay-run import block; 3 MINORs: identity line count, ADR-0003 display text, §6.2 wording). All fixed on the spot (close() and the imports restored verbatim; nothing elided remains unmarked).
  - Round 2 (delta re-review): **VERDICT: APPROVED — 0 BLOCKERS, 0 MAJORS, 0 MINORS**; the reviewer's stricter contiguous-run checker: every fence is an exact contiguous source run (0 skips); bridge/queue/retry/store carried forward clean (100% coverage each); link sweep 37/37; no `src/` changes.
- [x] 8.4 Human approval gates (rule 0): commit/push and archive — ask, state scope and message, and wait
  - Commit/push approved 2026-10-12 (`a7ebd16` docs: rewrite the bridge tour and add five key-file tours); archive approved and applied 2026-10-12 as `2026-10-12-code-tours`

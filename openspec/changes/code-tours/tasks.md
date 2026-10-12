# Tasks — `code-tours`

Scenario → evidence traceability: "Format present" / "Blocks match the source" → per-tour spot-check recorded here + the reviewer pass; "Catalog present and indexed" → `docs/code-tours/README.md` inspection; "Bridge tour is current" → rewritten tour vs `src/proxy/bridge.ts`; "Source change carries its tour" → convention specced in the capability (enforced by review, not a machine gate); "Mirror commit recorded" → header diff target. Docs-only change (rule 11 note): the verification gate for every task is the spot-check against the source at the recorded commit + the final reviewer pass; `docs/` is outside the prettier gate.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-12 ("approved, only commit and push... no apply yet") — implementation deferred by choice; run `/opsx-apply code-tours` when ready

## 1. Baseline

- [ ] 1.1 Record the catalog state and the mirrored-commit target: `git rev-parse --short HEAD` (every new/updated tour header will name it); confirm `docs/code-tours/` currently holds only the M1-era `bridge.md`
- [ ] 1.2 Re-confirm the ranked file list against the design's D1 table (line counts and paths still current)

## 2. Rewrite `docs/code-tours/bridge.md`

- [ ] 2.1 Rewrite the tour against the current `src/proxy/bridge.ts` (blocks: imports/contracts, internal vocabulary incl. `CallContext`/`LogBase`, data helpers, close signals, transports/batches wiring, upstream client + server→client relays, connect/session, `createRelayRequest`, the interception gates — `prepareCallContext`, credential gate `denyCredential`, policy gate, `attemptToolCall`/`relayToolCall`, `finalizeSuccessfulCall`/`recordIdempotentExecution`, `failToolCall` — plus `relayPassthroughRequest`, the server factory, and `startBridge`), keeping the established format and pointing "next stop" at `transports.md`
- [ ] 2.2 Spot-check every block against the source at the recorded commit (signatures + key branches; elisions marked) and record the compared symbols here

## 3. `docs/code-tours/transports.md`

- [ ] 3.1 Write the tour for `src/proxy/transports.ts` (`FrameDecoder`, both stdio transports, `HttpUpstreamLink`, lifecycle steps, batch/notification dispatch)
- [ ] 3.2 Spot-check blocks vs source; record compared symbols

## 4. `docs/code-tours/replay-run.md`

- [ ] 4.1 Write the tour for `src/replay/replay-run.ts` (redrive execution, dedup guard, atomic claim/resolve, result capture into audit; cross-reference `guards.ts`/`command-line.ts`/`replay-cli.ts` as thin neighbors)
- [ ] 4.2 Spot-check blocks vs source; record compared symbols

## 5. `docs/code-tours/sqlite-queue.md`

- [ ] 5.1 Write the tour for `src/queue/sqlite-queue.ts` (capture-before-error, the `QueueProvider` contract as implemented, atomic `claim`/`resolve`, dedup index; note the RabbitMQ mirror)
- [ ] 5.2 Spot-check blocks vs source; record compared symbols

## 6. `docs/code-tours/retry-pipeline.md`

- [ ] 6.1 Write the tour for `src/pipeline/retry.ts` + `src/pipeline/classify.ts` (the D4 taxonomy, retry eligibility, bounded backoff, the attempt loop)
- [ ] 6.2 Spot-check blocks vs source; record compared symbols

## 7. `docs/code-tours/sqlite-store.md`

- [ ] 7.1 Write the tour for `src/store/sqlite-store.ts` (audit entries, call events, `metrics`, retention; replay outcomes live here)
- [ ] 7.2 Spot-check blocks vs source; record compared symbols

## 8. Index + completion

- [ ] 8.1 `docs/code-tours/README.md`: catalog table (source, lines, tour, rank rationale), deferred wave with reasons (D1), drift rule
- [ ] 8.2 Final link sweep: every tour's source link and next-stop link resolves; every header records the mirrored commit
- [ ] 8.3 `craft-reviewer` pass over the catalog (fidelity sample vs sources at the recorded commit, format compliance, index accuracy) — verdict APPROVED
- [ ] 8.4 Human approval gates (rule 0): commit/push and archive — ask, state scope and message, and wait

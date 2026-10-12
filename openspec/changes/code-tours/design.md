# Design — `code-tours`

## Context

- Catalog today: one tour, `docs/code-tours/bridge.md` (628 lines), mirroring the M1-era bridge — nine milestones out of date. AGENTS: *"docs/code-tours/ mirrors key files block-by-block and is updated when those files change."*
- The owner's ask: bring the bridge tour current; propose four or five files for new tours, ranked by role on the project / importance.
- Measured sources (2026-10-12): `bridge.ts` 955 · `transports.ts` 372 · `replay-run.ts` 548 (`replay-cli.ts` 371, `guards.ts` 50, `command-line.ts` 60) · `sqlite-queue.ts` 351 · `retry.ts` 69 + `classify.ts` 95 · `sqlite-store.ts` 334. Deferred candidates: `policy.ts` 159, `config.ts` 617, `cli/run.ts` 332.
- Established format (bridge.md): Spanish prose + English code; per-block *qué hace / por qué / si no estuviera*; glossary; "next stop"; header declaring the mirror.
- `.prettierignore` excludes `docs/` — tours are not machine-formatted; quality is enforced by spot-check + review.

## Goals / Non-Goals

**Goals:**

- `bridge.md` mirrors the current bridge (M9 interception shape + the `refactor-intercept-call` named gates) with the mirrored commit recorded.
- Five new tours for the ranked files, each spot-checked against its source.
- An index (`docs/code-tours/README.md`) with the catalog, ranking rationale, and deferred wave.
- The catalog contract specced (`code-tours` capability) so future changes carry their tours.

**Non-Goals:**

- Any `src/` change; any architecture/flow change (no diagram regeneration).
- Tours for the deferred wave (policy, config, cli/run, identity, replay-cli/guards, rabbitmq-queue) — listed in the index with reasons; each lands as its own future change.
- Translating prose to English (established convention is Spanish explanation + English code) or vice versa.
- A CI fidelity checker that diffs code blocks against sources — real tooling, parked as a follow-up until the catalog stabilizes.

## Decisions

### D1 — Ranking: §5 differentiator × risk × §1 spine

| # | Source | Why this rank |
|---|---|---|
| 1 | `src/proxy/bridge.ts` (rewrite) | Every subsystem plugs in here; the interception spine of the §1 flow. |
| 2 | `src/proxy/transports.ts` | The wire every session depends on; the highest bug history (framing, ordering, microtasks); the old tour's own "next stop". |
| 3 | `src/replay/replay-run.ts` | The core differentiator's engine (redrive, dedup, atomic claims, result capture); §1 replay beat. |
| 4 | `src/queue/sqlite-queue.ts` | DLQ persistence + the `QueueProvider` port's reference adapter (capture-before-error, atomic `claim`/`resolve`, dedup index); §1 capture beat; the RabbitMQ adapter mirrors its contract. |
| 5 | `src/pipeline/retry.ts` + `classify.ts` (one tour) | "Classify failures honestly": the D4 taxonomy + bounded backoff; §1 fail beat; two small files that are one pipeline. |
| 6 | `src/store/sqlite-store.ts` | Audit + call events + metrics; the report beat and where replay outcomes live. |

Deferred with reasons (recorded in the index): `policy.ts` (thin surface, fully covered by ADR-0006), `config.ts` (churn-prone surface), `cli/run.ts`, `identity.ts`, `replay-cli.ts`/`guards.ts`/`command-line.ts` (cross-referenced from the replay-run tour), `rabbitmq-queue.ts` (an adapter mirror of the port reference).

### D2 — Mirror fidelity: real code, marked elisions, mirrored commit

Blocks copy the current source verbatim; for the large files (`bridge`, `replay-run`) blocks are selected around entry points, decision points, and cross-boundary contracts, with elisions marked `// …` and an explicit note. Each header records `Espejo de: <path> @ <short-commit>` (the commit at write time) so drift is detectable. Fidelity is verified by a per-tour spot-check task (signatures + key branches against the source) plus the reviewer pass — not by a CI checker this wave (rejected: block-vs-source tooling is real work better deferred).

### D3 — Format: keep the established convention

Spanish explanations, English code and identifiers — the existing `bridge.md` convention and the owner's request. The repo's "artifacts in English" rule yields to this documented exception (the tour header already states it). Per-block triple, glossary, and next-stop are preserved; the bridge rewrite's "next stop" now points at `transports.md` (it exists).

### D4 — Index = the coverage contract's surface

`docs/code-tours/README.md` holds the catalog table (file → lines → tour → rank rationale), the deferred wave with reasons, and the drift rule (update-in-the-same-change + mirrored commit). The spec's coverage requirement points readers at this index rather than duplicating the list in code.

## Risks / Trade-offs

- **Docs drift again** → mirrored commit in the header + the update-in-the-same-change convention (specced); future CI fidelity checker noted as a follow-up.
- **Bridge tour length** (955-line source) → D2 selection with marked elisions; the tour remains a study guide, not a full dump. Reviewers spot-check the interception gates (the part that changed most since M1).
- **Spanish-in-an-English-repo** → documented convention in every header; no change proposed.
- **Spot-check discipline** → recorded per tour in the tasks with the compared signatures; the final reviewer pass re-verifies a sample.

## Open Questions

(none — the ranking and format are decidable from the repo's own conventions; deferred-wave ordering is recorded in the index for a future change.)

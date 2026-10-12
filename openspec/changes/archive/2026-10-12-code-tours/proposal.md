# Proposal — `code-tours`

## Why

`docs/code-tours/` is the repo's block-by-block study material — the AGENTS convention says tours mirror key files and are updated when those files change. Today the catalog is a single file, `docs/code-tours/bridge.md`, and it mirrors the **M1-era** bridge: no credential gate, no policy gate, no retry pipeline, no DLQ capture, no identity, no call events — it still teaches hardcoded `attempt: 1` and `caller: local`. The real `src/proxy/bridge.ts` is now the 955-line interception spine of nine milestones; the doc teaches code that no longer exists. The project owner asked for the bridge tour to be brought current and for tours of the most important files, ranked by their role in the product.

## What Changes

- **Rewrite `docs/code-tours/bridge.md`** to mirror the current `src/proxy/bridge.ts` — the M9 interception shape (prepare context → credential gate → policy gate → retry-wrapped execution → outcome helpers, plus capture/audit/idempotency/metrics parity) — keeping the established format (Spanish explanation, English code, per-block *qué hace / por qué / si no estuviera*) and recording the mirrored commit in the header.
- **Add five new tours, ranked by role** (§5 differentiators × risk × the §1 acceptance spine):
  1. `src/proxy/transports.ts` (372 lines) — the wire: stdio framing, batch demux, HTTP transport, lifecycle.
  2. `src/replay/replay-run.ts` (548) — the differentiator's engine: redrive, dedup guard, atomic claims, result capture.
  3. `src/queue/sqlite-queue.ts` (351) — DLQ persistence: capture-before-error, atomic `claim`/`resolve`, the `QueueProvider` port's reference adapter.
  4. `src/pipeline/retry.ts` + `src/pipeline/classify.ts` (69 + 95, one tour) — the failure-class taxonomy and bounded backoff.
  5. `src/store/sqlite-store.ts` (334) — audit + call events + metrics: the report beat and where replay outcomes live.
- **`docs/code-tours/README.md` index**: the catalog with source, size, and ranking rationale; the deferred next wave; the drift rule.
- **Formalize the catalog contract** as the `code-tours` capability: mirror format, ranked coverage, and drift discipline. Docs-only: **zero `src/` changes**, no architecture, flow, or component change (the living diagram is not regenerated).

## Capabilities

### New Capabilities

- `code-tours`: the study-guide catalog contract — the mirror format (real code + Spanish explanation, source and mirrored commit in the header), ranked coverage of the key files, and the drift discipline (tours update in the change that touches their source).

### Modified Capabilities

(none — no runtime requirement changes)

## Impact

- **Docs**: `docs/code-tours/` (bridge.md rewritten; five new tours; README index). Note: `docs/` sits outside the prettier gate (`.prettierignore`), so tour quality is enforced by fidelity spot-check + review, not `format:check`.
- **Unchanged**: `src/`, tests, dependencies, CI, architecture (no diagram regeneration).

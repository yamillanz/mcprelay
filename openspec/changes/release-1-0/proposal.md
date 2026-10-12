# Proposal — `release-1-0`

## Why

M0–M9 built the product; v1.0 is the moment it ships to the world. §9 makes the release itself the milestone: the §1 demo (call → deny → fail → DLQ → replay → report, ending on the visible replayed side effect) recorded as the README GIF — "the acceptance test of the whole product" per §1 — plus ≥3 documented public-server recipes, the README release surface (design decisions, competitive table with links), the launch post and submission kit, and 1.0.0 published — with **every §9 gating metric verified green** and the evidence recorded. Nothing new is built for users here; what exists becomes visible, reproducible, and shippable.

## What Changes

- **Reproducible §1 demo**: `scripts/demo.mjs` (+ `npm run demo`) runs the full flow against the **real filesystem server** in a temp workspace — policy deny (dry-run first), a genuinely failing write → DLQ (redacted capture), `replay --dry-run` → `replay <id>` → **the file lands** — and prints a transcript of real outputs. `scripts/demo-gif.mjs` regenerates `docs/assets/demo.gif` from that transcript (dev-only tooling; system ffmpeg/ImageMagick, no new deps).
- **README release surface**: hero GIF (absolute raw URL, renders on GitHub + npm), design-decisions section (3–4 ADRs with rejected alternatives), competitive table with per-row repository links (star counts re-verified at publish time), quickstart stays the client-config snippet; the `tools/list` (FR-Y5) and replay-semantics answers are already present and get re-checked.
- **≥3 public-server examples**: `examples/filesystem/`, `examples/memory/`, `examples/everything/` — config + README each — verified by a new `tests/examples.test.ts` that wraps each server through the middleware and lists its tools (recipes that rot fail the suite).
- **Launch kit**: `docs/release/launch-post.md` ("Why your agent's tool calls need a dead-letter queue", carrying the DLQ GIF) and `docs/release/submissions.md` (awesome-list entry text + r/MCP + Discord drafts). Actual third-party submissions are human actions.
- **Release mechanics**: `package.json` 1.0.0 + `CHANGELOG.md`; `npm pack` tarball inspection; `npm publish` remains a human-gated manual action, followed by the `npx @yamillanz/mcprelay --version` smoke. **BREAKING: none** (no runtime behavior changes).
- **§9 gating verification matrix** recorded in the tasks (demo/GIF, compose demo, CI, npm+npx, examples, FR-P2 zero-intrusion test) + PRD history v0.13 and the AGENTS status line.

## Capabilities

### New Capabilities

- `release-readiness`: the release contracts behind §9's gating metrics — verified public-server examples, the reproducible demo asset, and the release surface (README + publishable package).

### Modified Capabilities

(none — no runtime requirement changes; the existing capabilities stay as specced)

## Impact

- **Docs**: `README.md`, `docs/assets/demo.gif` (new), `docs/release/` (new), `docs/PRD.md` history, `AGENTS.md` status line.
- **Examples/tests**: three new recipe directories; `tests/examples.test.ts` (new; runs in CI — the hermetic suites stay hermetic).
- **Tooling**: `scripts/` (new, dev-only: demo runner + GIF generator; requires system ffmpeg or ImageMagick, documented); `package.json` gains `demo` scripts + version 1.0.0; `CHANGELOG.md` (new).
- **Unchanged**: `src/` (zero runtime changes), architecture/flow/components (the living diagram is not regenerated), dependencies (no new runtime deps; GIF tooling is system-level, dev-only), CI workflow shape.

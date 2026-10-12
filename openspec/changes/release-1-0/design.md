# Design — `release-1-0`

## Context

M0–M9 built the product (13 live capabilities); M10 changes **no runtime behavior** — it makes the existing product visible, reproducible, and shippable. §9 defines the gating metrics; §1 fixes the demo's content and its payoff ("This flow is the GIF in the README and the acceptance test of the whole product"). Current state that matters:

- README already carries the client-config quickstart, the npm scoped-name note, the `tools/list` note, and *What replay means*; it has **no GIF, no design-decisions section, no competitive table**.
- `examples/` has the two hermetic fixtures + the RabbitMQ compose demo; **no public-server recipes**.
- `package.json` is 0.1.0, `files: ["dist"]`, publish is manual (`prepublishOnly` = build + test); CI is `ci.yml` only.
- No `scripts/` directory. Local tooling available for asset generation: ffmpeg, ImageMagick, DejaVu Sans Mono fonts. Constraint: OSS-only, minimal deps (P5/NFR-1) — no runtime dependency may be added for release tooling.

## Goals / Non-Goals

**Goals:**

- Every §9 gating metric green with recorded evidence: the §1 demo recorded as the README GIF, the compose demo, CI, npm 1.0.0 + `npx` smoke, ≥3 verified examples, the FR-P2 zero-intrusion test.
- The GIF and the demo are **reproducible from committed scripts** — the recording is evidence, not a one-off.
- The examples are **verified by tests**, so recipes cannot silently rot.
- The README becomes the release surface §9 describes; the launch kit is ready for the human to publish.

**Non-Goals:**

- Any runtime behavior, architecture, flow, or component change (the living diagram is not regenerated).
- An automated npm publish workflow (publish stays a human-gated manual action).
- Automated third-party submissions (awesome-list PRs, r/MCP, Discord — human actions; we prepare the texts).
- New adapters or features of any kind (§10 scope caps hold).

## Decisions

### D1 — Demo failure mechanic: a real permission error on the real filesystem server

The §1 flow needs a genuinely failing write (→ DLQ) and a replay that visibly succeeds. The filesystem server cannot inject failures, so the demo workspace contains a read-only directory (`chmod 555`): `write_file` into it fails (EACCES → `isError`) → captured with the per-tool `capture_tool_errors: true` → `replay --dry-run` inspects → the demo restores permissions (the honest "fix") → `replay <id>` succeeds → **the file appears**. All real: real server, real error, real side effect. Rejected: the hermetic echo-server (not a public server — §1 says wrap a real one, and the compose demo already covers it), a fake timeout tool (would require product/server changes for a recording), replaying a read (no visible side effect — §1 makes the side effect the payoff). Fallback if `chmod` proves environment-dependent (e.g. running as root): write to a path whose parent directory does not exist (ENOENT) and `mkdir` it before replay — same narrative, same beats.

### D2 — GIF pipeline: committed scripts, system tools, zero runtime deps

`scripts/demo.mjs` drives a real session (raw JSON-RPC client over the built CLI, temp workspace) and prints an ANSI-free transcript of real outputs; `scripts/demo-gif.mjs` renders frames from that transcript and assembles `docs/assets/demo.gif` (ffmpeg palette pipeline; ImageMagick `convert` as the fallback renderer). Generation is **dev-only** and documented in `docs/release/`; the committed GIF is the artifact; CI never generates it. Rejected: asciinema + agg (an extra install chain for one asset), a pure-Node encoder (a new dev dep plus a font-rendering stack for marginal benefit), manual screen recording (not reproducible).

### D3 — Examples: three public recipes + a smoke suite that runs in CI

`examples/filesystem/`, `examples/memory/`, `examples/everything/` — each with `mcprelay.config.yaml` + README. `tests/examples.test.ts` wraps each server (`npx -y <pkg>@<pinned>` via the middleware), initializes, and asserts `tools/list` ≥ 1 tool. These run in CI (ubuntu runners have network); the existing suites stay hermetic. Rejected: docs-only recipes (unverified prose rots), an env-gated opt-in (the release gate must fail if a recipe breaks).

### D4 — README image path: absolute raw URL

`files: ["dist"]` stays; the README embeds the GIF via an absolute `raw.githubusercontent.com` URL so it renders on both GitHub and npm without shipping the asset in every install. Rejected: adding `docs/assets` to `files` (tarball bloat for all users).

### D5 — Publish stays human-gated and manual

The change prepares the version bump (1.0.0) and `CHANGELOG.md`; `npm pack` + a local tarball smoke prove the artifact; `npm publish` is a human action under rule 0, followed by the `npx @yamillanz/mcprelay --version` smoke recorded as §9 evidence. Rejected: a release workflow with provenance (nice-to-have; not required by §9 and adds secret/2FA management for a solo maintainer).

### D6 — Release capability delta covers the gating contracts only

The `release-readiness` spec states the three contracts that are mechanically checkable (examples smoke test, demo/GIF reproducibility, README surface + package smoke). The remaining §9 items (compose demo, CI, FR-P2) are already specced elsewhere and are verified — not re-specced — in the tasks matrix.

## Risks / Trade-offs

- GIF size/legibility → cap ≈ 800 px wide, palette-optimized, short transcript; verify < ≈ 2 MB and readable at GitHub's render width.
- Permission fixture portability (root ignores `chmod`) → documented non-root requirement; ENOENT/`mkdir` fallback (D1).
- Public-server downloads in CI → pinned versions; a broken recipe failing CI is a **true** release signal (D3); hermetic suites unaffected.
- Star counts rot → §9 requires re-verification at publish time; the task records the date and values.
- npm README image rendering → absolute URL (D4); the task verifies the rendered npm page after publish.
- Transcript drift between demo and GIF → the GIF script consumes the demo script's output (one source of truth); the task runs both in sequence.

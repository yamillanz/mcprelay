# ADR-0001 — Repository layout and toolchain

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-09-25 |
| **Milestone** | M0 `bootstrap` |
| **PRD refs** | §11, §12 (M0), NFR-6, P1, P5 |

## Context

M0 starts from a docs-only repository (PRD + AGENTS.md). Before any capability is specified or built, the project needs a layout and a toolchain that: keep the local-first, minimal-dependency posture (P1/P5); support strict TypeScript with a fast red → green → refactor loop (rule 11); and publish a CLI runnable via `npx mcprelay` at M4. The target source layout (cli/proxy/pipeline/queue/store/policy/config) is already fixed by AGENTS.md; this ADR records the packaging and build decisions and why the alternatives were rejected.

## Decisions

### D1 — Single package, no monorepo

`mcprelay` is one CLI with internal modules behind two interfaces (`QueueProvider`, `Store`). Ports are TypeScript interfaces, not separately versioned packages. pnpm/npm workspaces, Nx, and Turborepo were rejected: they add build orchestration, versioning, and publishing overhead for a single publishable artifact, contradicting P5. Revisit only if a second publishable package ever appears (no such plan in v1; §10 caps extensions at adapters inside this package).

### D2 — ESM, `module: NodeNext`, source shipped as compiled `dist/`

The official MCP TypeScript SDK v2 line is ESM-first, and ESM is the Node default path going forward. CJS was rejected: it would force interop shims for the SDK and future dependencies. `tsconfig.build.json` compiles `src/` to `dist/` with declarations and source maps; only `dist/` is published (`package.json#files`), and the `bin` entry points at `dist/cli/index.js` (shebang preserved by `tsc`).

### D3 — `tsc` is the build; no bundler

A bundler (tsup/esbuild/rollup/rolldown) was rejected: it is a large dev dependency and an extra failure mode for a Node CLI whose dependency graph is small by design; it would also obscure stack traces and complicate the "no runtime deps" posture with bundled vendored code. `tsc` output is predictable, debuggable, and dependency-free. Revisit only if startup time or publish size measurably regress.

### D4 — vitest for tests

Vitest runs TypeScript and ESM without a separate transform configuration, has a watch mode suited to TDD, and supports `it.each` for the scenario tables this project leans on (FR-P2 passthrough matrix, D4 failure classes). Jest was rejected (significant ESM friction and configuration weight); `node:test` was rejected (weaker watch/assertion ergonomics and matcher ecosystem for the scenario-per-test cadence above). Vitest is pinned to the major that supports Node 20 so the CI matrix can cover the PRD's Node ≥ 20 floor.

### D5 — eslint (flat config) + prettier

`typescript-eslint` remains the most complete typed-linting stack; prettier owns formatting so lint rules stay semantic. Biome was considered — a single fast tool — but rejected at M0 because the `typescript-eslint` rule ecosystem and eslint 10 flat-config stability outweigh the tool-count saving; revisit if eslint configuration cost grows.

### D6 — Layout and just-in-time directories

```
src/cli/          CLI entry, argument parsing, exit codes
src/proxy/        MCP protocol bridge (M1)
src/pipeline/     policy → timeout → retry → capture (M1–M3)
src/queue/        QueueProvider port + sqlite/rabbitmq adapters (M3, M7)
src/store/        Store port + sqlite adapter (M3, M8)
src/policy/       policy engine (M5)
src/config/       YAML config loading/validation (M2–M3)
tests/            hermetic tests (mirrors src/ paths)
examples/         real-server recipes + failure-injection server (M1+)
bench/            NFR-3 overhead benchmark (M1+)
```

Directories beyond `src/cli/` are created when their milestone lands — no scaffolding ahead of the change (AGENTS.md workflow rule 1). Tests live in a top-level `tests/` tree (excluded from the build via `tsconfig.build.json`): it keeps `src/` publishable as-is, makes the test surface easy to survey, and avoids shipping test files.

### D7 — Project-local OpenSpec `spec-driven` schema override

OpenSpec resolves project schemas before built-ins (`openspec/schemas/<name>/`). The project overrides `spec-driven` solely to make change templates test-first: task groups start with a failing-test task that names the delta scenarios it covers. Editing the globally installed schema was rejected (not shareable, not reviewable, breaks on every machine). Accepted trade-off: the project copy can drift from upstream OpenSpec templates; it is small, rarely changes, and `openspec schema validate spec-driven` guards its validity.

### D8 — Node floor `>=20.19.0`

The PRD says Node ≥ 20; the selected toolchain (eslint 10, openspec 1.3) requires ≥ 20.19, so `engines` states the precise floor and CI tests Node 20 and 22. Declaring a wider range would be untrue to the tooling.

### D9 — M0 is a plain chore, not a delta-bearing change

`openspec validate` rejects delta-less changes (verified against OpenSpec 1.3.0). M0 introduces no product capability, so per PRD §12 it ran as a plain chore: proposal + tasks were kept as the record and archived with `openspec archive --skip-specs` — the CLI's documented path for infrastructure/tooling changes. Synthetic delta specs were rejected as dishonest spec drift; skipping the change record entirely was rejected as a process gap.

## Consequences

- CI gates every push/PR on typecheck, lint, format check, tests, build, CLI smoke (`node dist/cli/index.js --version`), and `openspec validate --all`.
- `package-lock.json` is committed; CI uses `npm ci`. The lockfile is lockfileVersion 3 and verified installable with the npm bundled by Node 20/22.
- npm publish is gated by `prepublishOnly` (build + tests) to keep the M0 name reservation and the M4 real release honest.
- Any future second publishable artifact or measured build problem reopens D1/D3.

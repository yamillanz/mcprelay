## Why

The repository holds only the PRD and operating rules — no code, no toolchain, no OpenSpec workspace. Every later milestone depends on a working, CI-gated, test-first scaffold; without it, spec-driven development has no substrate and the npm name `mcprelay` stays unreserved while the MCP namespace fills up.

## What Changes

- Initialize the OpenSpec workspace (`openspec/`) with `project.md` pointing at the PRD as product truth, and land a project-local `spec-driven` schema whose task templates start with test-writing (rule 11).
- Scaffold a strict TypeScript / Node ≥ 20 project: build (tsc), test (vitest), lint + format (eslint + prettier), all runnable from npm scripts.
- CLI skeleton: `mcprelay --help`, `mcprelay version` / `--version`, and documented meaningful exit codes; no `run` behavior yet.
- Repository files: MIT `LICENSE`, `.gitignore`, minimal honest `README.md`, `docs/adr/0001-repo-layout.md` (target layout + rejected alternatives).
- CI (GitHub Actions): install, typecheck, lint, test, build, and `openspec validate --all` on every push/PR.
- Reserve the npm name with a `0.0.x` placeholder publish of the scaffold (real publish at M4).

No capability changes: M0 is infrastructure-only, so this change carries a proposal + tasks and no delta specs.

## Capabilities

### New Capabilities

(none — infrastructure-only change; no product capability is introduced)

### Modified Capabilities

(none)

## Impact

- New: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `src/cli/`, `tests/`, `.github/workflows/ci.yml`, `docs/adr/0001-repo-layout.md`, `openspec/schemas/spec-driven/`.
- Updated: `AGENTS.md` (status line), npm registry (`mcprelay` placeholder version).
- No runtime dependencies; Node built-ins only for the CLI skeleton.

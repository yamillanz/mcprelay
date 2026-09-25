# Tasks — M0 `bootstrap`

Infra-only change: no delta specs. Test-first cadence (AGENTS.md rule 11) applies to the CLI skeleton; the rest is configuration whose verification is the clean-clone gate.

## 1. OpenSpec workspace

- [x] 1.1 Write `openspec/project.md`: PRD is product truth, milestone map, conventions, TDD cadence
- [x] 1.2 Land project-local `openspec/schemas/spec-driven/` overriding the task template so phases start with test-writing
- [x] 1.3 Kickoff decision: `openspec validate` rejects delta-less changes (OpenSpec 1.3.0) → M0 runs as a plain chore, archived with `--skip-specs` (PRD §12); `openspec validate --all` clean afterwards

## 2. Toolchain (test-first where code exists)

- [x] 2.1 Write failing smoke tests for the CLI contract: `version` prints the package version, `--help` prints usage, unknown command exits non-zero with usage, `--version` alias
- [x] 2.2 Implement the CLI skeleton in `src/cli/` until the smoke tests are green (no `run` behavior)
- [x] 2.3 Scaffold `package.json` (Node ≥ 20, ESM), strict `tsconfig.json`, vitest config
- [x] 2.4 Lint + format: eslint (flat config, typescript-eslint) and prettier; `npm run lint` and `npm run format:check` green
- [x] 2.5 Wire npm scripts: `build`, `test`, `typecheck`, `lint`, `format:check`, `spec:validate`

## 3. Repository files

- [x] 3.1 MIT `LICENSE` + `package.json` license/author/repository fields
- [x] 3.2 `.gitignore` (node_modules, dist, coverage, `./.mcprelay/`)
- [x] 3.3 Minimal honest `README.md` (status: M0 scaffold, points at the PRD; no demo claims yet)
- [x] 3.4 `docs/adr/0001-repo-layout.md`: target layout from AGENTS.md, with rejected alternatives (monorepo, bundler, CJS, jest)

## 4. CI

- [x] 4.1 `.github/workflows/ci.yml`: Node 20 + 22 matrix → `npm ci`, typecheck, lint, format check, test, build, CLI smoke, `openspec validate --all`

## 5. Verification & release

- [x] 5.1 Clean-clone gate: `npm install && npm test` green; `npm run typecheck && npm run lint && npm run build` green; `node dist/cli/index.js --version` prints version; `openspec validate --all` clean
- [x] 5.2 Record results in the change (see below; §12 exit criteria)
- [ ] 5.3 npm placeholder publish (`0.0.1`) to reserve the name — **PENDING: needs npm auth on the machine; run `npm publish` (prepublishOnly builds + tests)**
- [x] 5.4 Update `AGENTS.md` status line (M0 done → next M1 `proxy-stdio`), archive the change

## Verification results — 2026-09-25 (Node v22.17.0, npm 10.9.2)

- `npm ci` → 203 packages, lockfileVersion 3, compatible with bundled npm 10 (CI floor)
- `npm test` → 9/9 green (vitest 4.1.11); tests written first, module absent → red, then green
- `npm run typecheck` → clean (TypeScript 6.0.3, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`)
- `npm run lint` → clean (eslint 10.11, typescript-eslint 8.70)
- `npm run format:check` → clean (prettier 3.9.9)
- `npm run build` → clean; `node dist/cli/index.js --version` → `0.0.1`; `--help` → usage; unknown command → stderr + exit 2
- `npm pack --dry-run` → 3.9 kB tarball, `dist/` + README + LICENSE + package.json, shebang preserved
- `openspec schema validate spec-driven` → valid, source: project
- npm install note: npm 10.9.2 arborist bug (`edgesOut`) on the vite 8 peer graph; lockfile generated with npm 12.1.0, then verified with `npm ci` on npm 10.9.2
- npm publish → skipped by user decision (no auth on this machine); follow-up before/at M1

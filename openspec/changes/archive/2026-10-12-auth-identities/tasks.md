# Tasks — `auth-identities`

Test-first (rule 11): every implementation group starts with its failing tests. Everything is hermetic (SQLite store, echo/filesystem servers, the HTTP fixture); broker suites are untouched.

Scenario → test traceability: identity-resolution scenarios → `tests/identity.test.ts` + `tests/call-log.test.ts` (session) + `tests/policy-enforcement.test.ts`; validation-at-the-edge scenarios → `tests/identity.test.ts` + `tests/call-log.test.ts` + `tests/http-upstream.test.ts`; no-passthrough scenarios → `tests/identity.test.ts` + `tests/call-log.test.ts` (stdio `echo-meta`) + `tests/http-upstream.test.ts` (`x/stats.lastParams`); configuration scenarios → `tests/config.test.ts`; CLI flag → `tests/cli.test.ts`; "resolved once per call" → code inspection + session tests.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-08 via `/opsx-apply auth-identities`

## 1. Baseline

- [x] 1.1 Run the full gate and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (hermetic; expect 356 passed + 5 skipped)
  - Baseline 2026-10-08: typecheck/lint/format/build/build:examples clean; **356 passed + 5 skipped**; `spec:validate` 13/13

## 2. Identity resolver and config (red first)

- [x] 2.1 Write failing `tests/identity.test.ts`: Bearer parsing (case-insensitive scheme), key match → identity, unknown key with a non-empty store → rejected, empty store → profile fallback, no credential → profile, and `stripCredentialFields` removes `authorization` (case-insensitive) while preserving every other `_meta` key ("Profile identity is the caller"; "A presented key maps to its identity"; "Zero-config keeps the local default"; "An unrecognized key is rejected"; "No key store means no rejection"; "A stdio upstream never sees the credential")
  - 10 failing cases first (module missing); red confirmed
- [x] 2.2 Implement `src/identity/identity.ts` (`resolveIdentity`, `stripCredentialFields`) until green
  - Pure resolver with `crypto.timingSafeEqual` key compare + copy-on-strip; 10/10
- [x] 2.3 Config-first: write failing `tests/config.test.ts` cases (defaults `local`/empty store, file values, duplicate key error, malformed entries, unknown keys, key values never in error text) then implement the `identity` section in `src/config/config.ts` until green ("Identity section" scenarios)
  - 5 failing cases first; `IdentityConfig` + strict parsing (duplicate keys reported without echoing the value); config 41/41

## 3. Bridge wiring: identity feeds the pipeline (red first)

- [x] 3.1 Write failing session cases in `tests/call-log.test.ts` and `tests/policy-enforcement.test.ts`: profile identity in the log line, call event, and `FailureRecord.caller`; a policy rule with `caller` matches the resolved identity; a keyed `_meta.authorization` resolves to its identity; an unknown key → `-32003`, `denied` audit, `denied` log with caller `unauthenticated`, zero upstream calls, no DLQ; the credential never appears in logs, events, audit, or records; `echo-meta` shows the credential stripped while other `_meta` keys survive ("Identity feeds policy, logs, events, and records"; "The rejection does not leak the credential"; "Rejected traffic is attributable"; "Credentials are never persisted or logged")
  - 5 failing session cases first (the caller rule `boom` for `reviewer-bot` proves policy matching); red confirmed
- [x] 3.2 Implement the bridge wiring: resolve before policy, thread `caller` through `CallLogFields`/`buildCallLogEntry`/`captureFailure`, strip in `prepareCallMetadata`, and the `-32003` rejection path (audit `detail.action = 'auth'`), until green
  - **Spec correction discovered here:** the SDK reserves `-32002` (`ResourceNotFound`) and rewrites a handler-thrown `-32002` to `-32602` at the era encode seam ("the SDK never EMITS -32002") — the auth code moved to `-32003` in the code, the identity spec, the design, the proposal, and the tests (intent unchanged)
- [x] 3.3 `report` attribution: extend a session test (or `tests/report-cli.test.ts` seeding) to assert rows group per resolved identity ("A presented key maps to its identity" — attribution half)
  - Session test runs `report --json` and asserts `agent-a/echo:1` + `reviewer-bot/echo:1` rows; full suite **376 passed + 5 skipped**

## 4. FR-A3 over HTTP (red first)

- [x] 4.1 Extend `examples/http-echo-server` `x/stats` with `lastParams`; write a failing `tests/http-upstream.test.ts` case asserting the upstream body contains no credential while `upstream.http.headers` still apply, and that other `_meta` keys survive ("The upstream body carries no credential")
  - Fixture now reports `lastParams`; new case added next to the header-level test
- [x] 4.2 Make it green (the strip already happens in `prepareCallMetadata`; fix whatever the fixture reveals) and keep the existing header-level credential test green
  - Green on first run (3.2 already strips on this path); `tests/http-upstream.test.ts` 14/14, header-level test still green

## 5. CLI flag and docs

- [x] 5.1 `run --identity <name>`: failing `tests/cli.test.ts` case (value parsing, missing value, override reaches the session) then implement in `src/cli/run.ts` + HELP until green ("The CLI flag overrides the file")
  - Parser cases + session override test (`--identity ci-bot` beats `identity.profile`); `src/cli/run.ts` + `src/proxy/run.ts` override + HELP line; cli+call-log 48/48
- [x] 5.2 Write `docs/adr/0010-identity-resolution.md` (resolution order, rejection semantics, passthrough boundary, rejected alternatives)
  - ADR-0010 (D1 sources, D2 rejection + the `-32003` SDK-reservation correction, D3 strip boundary, D4 feeding, consequences)
- [x] 5.3 README: `identity` section (profile, keys, `--identity`, the `-32003` behavior, zero-config note); AGENTS status line (M9 landed → next M10 `release-1-0`)
  - README status M9 + identities bullet + config example; AGENTS status → M9 landed, next M10
- [x] 5.4 PRD (rule 1): document history v0.12 (FR-A1/A3 implemented; FR-A2 still post-M9)
  - History v0.12 added
- [x] 5.5 Living architecture diagram: mark identity on the client edge; validate + re-deliver the HTML (Archify, showcase) and visual-check
  - Title M9; bridge tag `correlation_id · identity` (identity is a bridge phase like correlation; no new node — the 12-node showcase budget and the corridor constraints documented in M7/M8 ruled a separate node out); validate 0 errors/0 warnings, delivered, visual-check (light, settled render)

## 6. Verification and approval gates

- [x] 6.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
  - 2026-10-08 hermetic: typecheck/lint/format/build/build:examples clean; **380 passed + 5 skipped**; `spec:validate` 13/13
- [x] 6.2 Real-server evidence: a filesystem/echo session with `identity.profile` (a `caller` policy rule applying), a keyed call mapped to another identity, and an unknown key rejected (`-32003`, denied, no upstream call); then `mcprelay report` grouped per identity — record the output here
  - 2026-10-08 evidence run (real filesystem server): profile `reviewer-bot` call allowed; `write_file` denied by the `caller: reviewer-bot` rule (`-32001`, file never created); keyed call (`Bearer sk-agent-a`) allowed as `agent-a`; unknown key rejected (`-32003`); credential absent from stderr; logs by caller `agent-a:read_file:allowed`, `reviewer-bot:read_file:allowed`, `reviewer-bot:write_file:denied`, `unauthenticated:read_file:denied` → `report` totals `{calls:4, allowed:2, denied:2}` with 4 per-identity rows → **metrics match logs: true**
- [x] 6.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
  - Approved 2026-10-08: `a9703e4` feat (+ `62cf782` spec) pushed to `origin/main`
- [x] 6.4 Human approval to archive (rule 0); archive the change after approval
  - Approved and archived 2026-10-12 as `2026-10-12-auth-identities`

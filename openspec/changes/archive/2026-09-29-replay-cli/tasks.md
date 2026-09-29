# Tasks — `replay-cli`

Test-first (rule 11): each delta scenario becomes a failing test before its implementation. Scenario names map to `specs/replay-cli/spec.md`, `specs/dead-letter-queue/spec.md`, and `specs/configuration/spec.md`.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session** (approved 2026-09-29)

## 1. Queue adapter: claim/release + idempotency index

- [x] 1.1 Write failing adapter tests: claim wins/loses, lease expiry reclaim, release, index upsert/read by key and by hash, in-place migration of an M3 database (no claim columns → reopened → columns present) (red)
- [x] 1.2 Implement `claim`/`release` + `executions` table + `recordExecution`/`lastExecution(ByHash)` in the sqlite adapter until green

## 2. Guards and key extraction (pure units)

- [x] 2.1 Write failing unit tests: duration parser (`24h`, `30m`, `7d`, `90s`, invalid), idempotency-key extraction (`_meta`, args field, none), redacted-marker scan, dedup verdict (in/out of window, `--force`) (red)
- [x] 2.2 Implement the helpers in `src/pipeline/`/`src/replay/` until green

## 3. Config: dedup window

- [x] 3.1 Write failing config tests: default `24h`, configured value, invalid duration with path+field (red → green)

## 4. Middleware: index keyed successes

- [x] 4.1 Write failing integration tests: keyed success through the proxy writes an execution entry; unkeyed success writes none (red → green)
- [x] 4.2 Implement the keyed-success recording in the bridge until green

## 5. Replay run: execution and capture

- [x] 5.1 Write failing tests: `run <id>` executes exactly once upstream, resolves the record (`replayed`), captures the redacted result into `last_outcome` + audit entry; failed attempt captures the error and does not retry; pre-execution failure releases the claim and stays pending (red)
- [x] 5.2 Implement `src/replay/replay-run.ts` + the `run` subcommand until green

## 6. Dry-run

- [x] 6.1 Write failing tests: zero upstream `tools/call`; tool present/absent; `effects: read` warning; dedup verdict reported; missing tool exits non-zero (red → green)

## 7. Guards wired into run

- [x] 7.1 Write failing tests: refusal without `--set`; success with `--set`; remaining markers refuse; dedup refusal without `--force`; `--force` proceeds and records; hash fallback; two concurrent runs → one execution (red → green)

## 8. First public release

- [x] 8.1 Bump to `0.1.0`; README rewrite: status, `npx @yamillanz/mcprelay` quickstart + client-config snippet, "What replay means", `tools/list` visibility answer, config, exit codes, honest limitations
- [x] 8.2 ADR-0005: claim/lease over post-hoc resolve, redacted-args guard, idempotency index, stored-command trust boundary, attempted-replay rule
- [x] 8.3 Update the living architecture diagram (replay path) and re-deliver the HTML (showcase)
- [x] 8.4 Repo visibility confirmed public (`gh repo view --json visibility`); AGENTS status line updated (M4 done → next M5)
- [x] 8.5 npm publish `0.1.0`: `stage publish` + human 2FA approval; verify `npm view` + `npx @yamillanz/mcprelay@0.1.0 --version`; this publish refreshes the npm-page README

## 9. Verification and approval gates

- [x] 9.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [x] 9.2 Real-server gate (demo step 4): filesystem `write_file` to a missing directory fails and is captured; after fixing the directory, `replay run <id>` writes the file (visible side effect) and the audit entry holds the replay's result; record evidence here
- [x] 9.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [x] 9.4 Human approval to archive (rule 0); archive the change after approval

## Verification results — 2026-09-29 (Node v22.17.0)

- `npm test` → 167/167 green across 16 suites (new: queue claim/release/index/migration 13, command-line 4, guards 6, replay run/dry-run/guards 13)
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run spec:validate` → clean (8/8 specs)
- **Real-server demo (beat 4)**: `write_file` into a missing directory → `isError` captured as `tool_error` (opt-in); after creating the directory, `replay run <id>` executed the call, the file exists with the replayed content, the record is `replayed`, and the outcome is captured in `last_outcome` + audit
- Concurrency: the concurrent-replay test exposed a real adapter bug (`journal_mode=WAL` before `busy_timeout` → `SQLITE_BUSY`); both adapters now set `busy_timeout` first, and database-open failures are reported cleanly (ADR-0004 D4, ADR-0005 D7)
- Redaction gap closed: `redactDeep` masks secrets inside string payloads that echo arguments back (`"api_key":"…"`) for replay/audit outcomes (ADR-0005 D6)
- Repo visibility confirmed `PUBLIC`; version bumped to `0.1.0`; README rewritten with the client-config quickstart, "What replay means", and the `tools/list` answer
- Architecture diagram updated and re-delivered (validate 9/9, visual-check pass)
- Refactor before commit (rule 11/readability): `replay-run.ts` decomposed into named steps — `loadReplayConfig`, `openProviders`, `fetchRecord`, `resolveArguments`, `computeDedupVerdict`, `guardRun`, `claimOrReport`, `attemptReplay` (queue-free), `persistOutcome`, `reportOutcome`, `runDryRun`; behavior and messages unchanged (replay suites 21/21)

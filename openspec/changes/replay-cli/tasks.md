# Tasks — `replay-cli`

Test-first (rule 11): each delta scenario becomes a failing test before its implementation. Scenario names map to `specs/replay-cli/spec.md`, `specs/dead-letter-queue/spec.md`, and `specs/configuration/spec.md`.

## 0. Approval gate (rule 0 — blocks everything below)

- [ ] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**

## 1. Queue adapter: claim/release + idempotency index

- [ ] 1.1 Write failing adapter tests: claim wins/loses, lease expiry reclaim, release, index upsert/read by key and by hash, in-place migration of an M3 database (no claim columns → reopened → columns present) (red)
- [ ] 1.2 Implement `claim`/`release` + `executions` table + `recordExecution`/`lastExecution(ByHash)` in the sqlite adapter until green

## 2. Guards and key extraction (pure units)

- [ ] 2.1 Write failing unit tests: duration parser (`24h`, `30m`, `7d`, `90s`, invalid), idempotency-key extraction (`_meta`, args field, none), redacted-marker scan, dedup verdict (in/out of window, `--force`) (red)
- [ ] 2.2 Implement the helpers in `src/pipeline/`/`src/replay/` until green

## 3. Config: dedup window

- [ ] 3.1 Write failing config tests: default `24h`, configured value, invalid duration with path+field (red → green)

## 4. Middleware: index keyed successes

- [ ] 4.1 Write failing integration tests: keyed success through the proxy writes an execution entry; unkeyed success writes none (red → green)
- [ ] 4.2 Implement the keyed-success recording in the bridge until green

## 5. Replay run: execution and capture

- [ ] 5.1 Write failing tests: `run <id>` executes exactly once upstream, resolves the record (`replayed`), captures the redacted result into `last_outcome` + audit entry; failed attempt captures the error and does not retry; pre-execution failure releases the claim and stays pending (red)
- [ ] 5.2 Implement `src/replay/replay-run.ts` + the `run` subcommand until green

## 6. Dry-run

- [ ] 6.1 Write failing tests: zero upstream `tools/call`; tool present/absent; `effects: read` warning; dedup verdict reported; missing tool exits non-zero (red → green)

## 7. Guards wired into run

- [ ] 7.1 Write failing tests: refusal without `--set`; success with `--set`; remaining markers refuse; dedup refusal without `--force`; `--force` proceeds and records; hash fallback; two concurrent runs → one execution (red → green)

## 8. First public release

- [ ] 8.1 Bump to `0.1.0`; README rewrite: status, `npx @yamillanz/mcprelay` quickstart + client-config snippet, "What replay means", `tools/list` visibility answer, config, exit codes, honest limitations
- [ ] 8.2 ADR-0005: claim/lease over post-hoc resolve, redacted-args guard, idempotency index, stored-command trust boundary, attempted-replay rule
- [ ] 8.3 Update the living architecture diagram (replay path) and re-deliver the HTML (showcase)
- [ ] 8.4 Repo visibility confirmed public (`gh repo view --json visibility`); AGENTS status line updated (M4 done → next M5)
- [ ] 8.5 npm publish `0.1.0`: `stage publish` + human 2FA approval; verify `npm view` + `npx @yamillanz/mcprelay@0.1.0 --version`; this publish refreshes the npm-page README

## 9. Verification and approval gates

- [ ] 9.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [ ] 9.2 Real-server gate (demo step 4): filesystem `write_file` to a missing directory fails and is captured; after fixing the directory, `replay run <id>` writes the file (visible side effect) and the audit entry holds the replay's result; record evidence here
- [ ] 9.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [ ] 9.4 Human approval to archive (rule 0); archive the change after approval

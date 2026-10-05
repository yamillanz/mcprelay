# Tasks — `refactor-run-transport`

Behavior-preserving refactor: characterization tests are written **first** (they lock current behavior), then each extraction step keeps the full suite green. No existing assertion changes.

Scenario → test traceability: "Parser reads as named steps" / "Helpers stay co-located" → code inspection plus the untouched suite; "Characterization tests lock every case" → run-parser cases in `tests/cli.test.ts`; "Framing exists once" / "Lifecycle reads as named steps" / "Characterization tests lock both transports" → `tests/transports.test.ts`; "Public surface unchanged" → `src/proxy/bridge.ts` compiles unedited; "Existing suite passes unchanged" → full suite; "No hot-path overhead added" → code inspection (no `bench/` yet; the script remains the future arbiter).

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**
  - Approved 2026-10-05 ("approved, next make the commit" + `/opsx-apply refactor-run-transport`)

## 1. Baseline evidence

- [x] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 271/271)
  - Baseline 2026-10-05: typecheck/lint/format/build/build:examples clean; **271/271** tests (21 suites); `spec:validate` 11/11
- [x] 1.2 Record the current CLI behavior (exit code + first stderr line) for every `parseRunInvocation` case below as the pre-refactor reference
  - Baseline 2026-10-05 (`node dist/cli/index.js`, all exit 2 + first stderr line):
    - `run` / `run --` → `Usage: mcprelay run [options] -- <server command…>  |  mcprelay run [options] --http <url>`
    - `run --config` / `--timeout-ms` / `--max-attempts` / `--http` (missing value) → `Missing value for '<flag>'.`
    - `run --timeout-ms abc|0|-1|1.5` / `--max-attempts abc|0|-1|1.5` → `Invalid value for '<flag>': <value>`
    - `run --http not-a-url` → `Invalid URL for '--http': not-a-url`
    - `run --http <url> -- <cmd>` → `Use either '--http <url>' or '-- <server command…>', not both.`
    - `run --bogus` → `Unknown option '--bogus'.`
    - `run --config /nonexistent.yaml -- node server.js --http x` → `mcprelay: /nonexistent.yaml: config file not found` (parse OK; stdio form)
    - `mcprelay --config /nonexistent.yaml -- node server.js` shorthand → `mcprelay: /nonexistent.yaml: config file not found`
    - all options before `--` → same config error (parse OK)
    - `run --http <url> --config /nonexistent.yaml` → same config error (HTTP form accepted)

## 2. Characterization tests (lock behavior before extraction)

- [x] 2.1 Write run-parser characterization tests in `tests/cli.test.ts` covering every case recorded in 1.2 (missing values, invalid integers, invalid URL, unknown option, no target, `--` without command, `--http` + `--` conflict, options after `--` as command args, each option accepted before `--`, shorthand routing) — green on the unchanged code ("Characterization tests lock every case")
  - 17 cases added (`mcprelay run parser characterization`); conflict/URL/no-target already covered by the existing `run transport forms` block; session-level "options after `--`" added to `tests/proxy.test.ts`
- [x] 2.2 Write `tests/transports.test.ts` locking both transports before extraction: `ClientTransport` with injected streams (frames split across chunks, blank lines ignored, invalid JSON → `onerror` and continue, batch line surfaced verbatim, notification dispatched before message, `onclose` exactly once, close detaches handlers) and `UpstreamTransport` against a hermetic child script (stdout framing, stderr forwarding, non-zero exit → `onerror` + `onclose`, `close()` suppresses the exit error) ("Characterization tests lock both transports")
  - 14 cases (`ClientTransport framing` 6, `UpstreamTransport framing` 8) against `node -e` children; locked the existing double-newline on `send` (SDK `serializeMessage` already ends with `\n`)
- [x] 2.3 Confirm no existing assertion changed and the suite is green (271 + new)
  - No existing assertion touched; **303/303** (271 + 32)

## 3. Extract `parseRunInvocation` cases (same file)

- [x] 3.1 Add `Step`, the `RunOptions` accumulator, the shared option-value reader and integer validator, and the `consumeRunToken` dispatcher with `consumeConfigPath`, `consumeHttpUrl`, `consumeIntegerOption`, `consumePolicyDryRun`; suite green
  - Added in one pass; `tests/cli.test.ts` 52/52 (with proxy), full suite 303/303 after rebuild
- [x] 3.2 Rewrite `parseRunInvocation` as loop + dispatcher + `finishWithHttp` / `finishWithStdio` + one `buildInvocation`; suite green ("Parser reads as named steps", "Helpers stay co-located": only `src/cli/run.ts`, no new file/module/class)
  - Body is now: token loop → `consumeRunToken` → named terminal step; only `src/cli/run.ts` changed

## 4. Extract transport framing (same file)

- [x] 4.1 Add the private `FrameDecoder` and delegate both transports' buffering/parse/batch/notification/error/ordering to it; delete the duplicated pipeline; suite green ("Framing exists once")
  - `FrameDecoder` (buffer, processing chain, parse, batch, notification, error, yield) shared by both classes; duplicated `onData`/`processLine` removed
- [x] 4.2 Split lifecycle into named steps — `spawnChild`, `forwardUpstreamStderr`, `watchChildExit`, `watchChildError`, `attachStdin`, `detachStdin`, `connectTransport`, `mirrorNotificationsAfterConnect`; suite green ("Lifecycle reads as named steps", "Public surface unchanged": `bridge.ts` unedited)
  - Named steps in place; `git status` shows `src/proxy/bridge.ts` untouched; typecheck/lint clean; **303/303**

## 5. Verification and approval gates

- [x] 5.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
  - 2026-10-05: typecheck/lint/format/build/build:examples clean; **303/303**; `spec:validate` 11/11
- [x] 5.2 Repeat the recorded baseline CLI invocations from 1.2 and confirm identical output/exit codes ("Run parser behavior preserved")
  - 21/21 identical (`diff` clean against the 1.2 baseline)
- [x] 5.3 Docs/diagram: none — file-local refactor alters no architecture, flow, or component; README, AGENTS status line, PRD, and the living diagram stay untouched. No `bench/` exists yet, so "No hot-path overhead added" is evidenced by inspection (no new I/O or serialization, one decoder method dispatch per frame) and the unchanged integration tests
  - `git status` confirms only `src/cli/run.ts`, `src/proxy/transports.ts`, and tests changed; real-server check: filesystem server session through the refactored proxy (`secure-filesystem-server 0.2.0`, `read_file` returned the smoke content) plus the examples-server suites
- [x] 5.4 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
  - Approved 2026-10-05 ("approved, commit and push")
- [ ] 5.5 Human approval to archive (rule 0); archive the change after approval

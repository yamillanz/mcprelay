# Tasks — `refactor-run-transport`

Behavior-preserving refactor: characterization tests are written **first** (they lock current behavior), then each extraction step keeps the full suite green. No existing assertion changes.

Scenario → test traceability: "Parser reads as named steps" / "Helpers stay co-located" → code inspection plus the untouched suite; "Characterization tests lock every case" → run-parser cases in `tests/cli.test.ts`; "Framing exists once" / "Lifecycle reads as named steps" / "Characterization tests lock both transports" → `tests/transports.test.ts`; "Public surface unchanged" → `src/proxy/bridge.ts` compiles unedited; "Existing suite passes unchanged" → full suite; "No hot-path overhead added" → code inspection (no `bench/` yet; the script remains the future arbiter).

## 0. Approval gate (rule 0 — blocks everything below)

- [ ] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**

## 1. Baseline evidence

- [ ] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate` (expect 271/271)
- [ ] 1.2 Record the current CLI behavior (exit code + first stderr line) for every `parseRunInvocation` case below as the pre-refactor reference
  - `run` with no target → `RUN_USAGE`
  - `run --` (no command) → `RUN_USAGE`
  - `run --config` / `--timeout-ms` / `--max-attempts` / `--http` (missing value) → `Missing value for '<flag>'.`
  - `run --timeout-ms abc|0|-1|1.5` / `--max-attempts abc|0|-1|1.5` → `Invalid value for '<flag>': <value>`
  - `run --http not-a-url` → `Invalid URL for '--http': not-a-url`
  - `run --http <url> -- <cmd>` → `Use either '--http <url>' or '-- <server command…>', not both.`
  - `run --bogus` → `Unknown option '--bogus'.`
  - `run --config c.yaml -- node server.js --http x` → stdio form, `--http x` as server args
  - `mcprelay --config c.yaml -- node server.js` shorthand → stdio form

## 2. Characterization tests (lock behavior before extraction)

- [ ] 2.1 Write run-parser characterization tests in `tests/cli.test.ts` covering every case recorded in 1.2 (missing values, invalid integers, invalid URL, unknown option, no target, `--` without command, `--http` + `--` conflict, options after `--` as command args, each option accepted before `--`, shorthand routing) — green on the unchanged code ("Characterization tests lock every case")
- [ ] 2.2 Write `tests/transports.test.ts` locking both transports before extraction: `ClientTransport` with injected streams (frames split across chunks, blank lines ignored, invalid JSON → `onerror` and continue, batch line surfaced verbatim, notification dispatched before message, `onclose` exactly once, close detaches handlers) and `UpstreamTransport` against a hermetic child script (stdout framing, stderr forwarding, non-zero exit → `onerror` + `onclose`, `close()` suppresses the exit error) ("Characterization tests lock both transports")
- [ ] 2.3 Confirm no existing assertion changed and the suite is green (271 + new)

## 3. Extract `parseRunInvocation` cases (same file)

- [ ] 3.1 Add `Step`, the `RunOptions` accumulator, the shared option-value reader and integer validator, and the `consumeRunToken` dispatcher with `consumeConfigPath`, `consumeHttpUrl`, `consumeIntegerOption`, `consumePolicyDryRun`; suite green
- [ ] 3.2 Rewrite `parseRunInvocation` as loop + dispatcher + `finishWithHttp` / `finishWithStdio` + one `buildInvocation`; suite green ("Parser reads as named steps", "Helpers stay co-located": only `src/cli/run.ts`, no new file/module/class)

## 4. Extract transport framing (same file)

- [ ] 4.1 Add the private `FrameDecoder` and delegate both transports' buffering/parse/batch/notification/error/ordering to it; delete the duplicated pipeline; suite green ("Framing exists once")
- [ ] 4.2 Split lifecycle into named steps — `spawnChild`, `forwardUpstreamStderr`, `watchChildExit`, `watchChildError`, `attachStdin`, `detachStdin`, `connectTransport`, `mirrorNotificationsAfterConnect`; suite green ("Lifecycle reads as named steps", "Public surface unchanged": `bridge.ts` unedited)

## 5. Verification and approval gates

- [ ] 5.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [ ] 5.2 Repeat the recorded baseline CLI invocations from 1.2 and confirm identical output/exit codes ("Run parser behavior preserved")
- [ ] 5.3 Docs/diagram: none — file-local refactor alters no architecture, flow, or component; README, AGENTS status line, PRD, and the living diagram stay untouched. No `bench/` exists yet, so "No hot-path overhead added" is evidenced by inspection (no new I/O or serialization, one decoder method dispatch per frame) and the unchanged integration tests
- [ ] 5.4 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [ ] 5.5 Human approval to archive (rule 0); archive the change after approval

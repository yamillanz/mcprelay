## Context

Two files that carry the project's most important behavior are hard to scan:

- `parseRunInvocation` (`src/cli/run.ts`, M0 + M6): one `while` loop where each option's detection, value reading, validation, and index arithmetic sit inline; the `--http` and stdio terminal forms each build the invocation with their own copy of the same optional-field spread (three copies in total counting the builder pattern), and the `--`/`--http` conflict check is mixed into the tail of the loop.
- `src/proxy/transports.ts` (M6, archived change `2026-10-03-http-transport`): `UpstreamTransport` and `ClientTransport` each carry a byte-identical line-framing pipeline — buffering, JSON parse, batch detection, notification dispatch, error dispatch, the microtask yield that keeps progress notifications ordered, and `finish()` — plus inline process wiring. The file is the single dependency of every session and the NFR-3 hot path.

Constraints: parsing runs once per process and may be restructured freely; transports run per frame, so extraction must not add per-call I/O, serialization, or allocation beyond what exists. Behavior — messages, exit codes, wire protocol, frame ordering, close/exit semantics — must be preserved byte-for-byte. Repo convention (recorded in `maintainability`): same-file helpers with descriptive names, no new modules, classes, or indirection without a measured reason.

## Goals / Non-Goals

**Goals:**

- `parseRunInvocation` reads as a token loop over a dispatcher whose cases are same-file, descriptively named helpers; one invocation builder; terminal target validation as named steps.
- The transport framing pipeline exists once in `src/proxy/transports.ts`; `UpstreamTransport` and `ClientTransport` keep only sink- and lifecycle-specific code; `start()` / `connect()` / `close()` read as ordered named steps.
- Behavior preservation proven by characterization tests written before extraction, the unchanged existing suite, and a re-run of the recorded CLI baseline.

**Non-Goals:**

- Changing the CLI surface, messages, exit codes, or option semantics.
- Changing any public interface (`Transport` surface, `UpstreamTarget`, `UpstreamLink`, exports) or touching `bridge.ts` / `run.ts`.
- New files, modules, exports, or dependencies in `src/`; architecture, flow, or component changes (the living diagram is not regenerated).
- Performance work beyond not regressing NFR-3; the `bench/` script remains the arbiter.

## Decisions

### D1 — Run parser: loop + dispatcher + named cases (mirrors `replay-cli-refactor`)

`parseRunInvocation` keeps its single loop and terminal validation, but the loop body delegates to `consumeRunToken`, whose switch maps each token to a helper that owns its case and validation:

- `consumeConfigPath` — `--config`
- `consumeHttpUrl` — `--http` (URL validation, exact `Invalid URL for '--http': <value>` message without trailing period)
- `consumeIntegerOption` — `--timeout-ms` / `--max-attempts` (shared missing-value and positive-integer validation)
- `consumePolicyDryRun` — `--policy-dry-run`

Helpers return `Step = { ok: true; next: number } | { ok: false; message: string }` and mutate a `RunOptions` accumulator, exactly as the inline code did. The terminal forms become named steps — `finishWithHttp(options)` (rejects `-- <command>` after `--http`) and `finishWithStdio(tokens, index, options)` (requires `--` plus a command, else `RUN_USAGE`) — both calling one `buildInvocation(options)` that emits the optional fields once. Rejected: a generic option-spec table or parser class (new indirection for an 80-line function; repo convention is same-file named functions).

### D2 — Transports: one framing pipeline, composed not inherited

Extract the duplicated pipeline into a private `FrameDecoder` in the same file: it owns `buffer`, the `processing` promise chain, line splitting, JSON parse, batch detection, deserialization, notification dispatch, error dispatch, and the microtask yield. Each transport composes one decoder and keeps only what differs: its output sink (`writeLine`), lifecycle (`start`/`close`/`finish`), and the public handler fields the SDK and bridge assign (`onclose`/`onerror`/`onmessage`/`onBatch`/`onNotification`). The decoder reads handlers from its owner through a once-per-session `FrameHandlers` reference, so per-frame work is unchanged: same split, same closure chain, no extra I/O or serialization.

Lifecycle entry points become named steps:

- `UpstreamTransport.start()` → `spawnChild()` → `forwardUpstreamStderr(child)` → `watchChildExit(child)` → `watchChildError(child)`
- `UpstreamTransport.close()` → `stopChild()` → `finish()`
- `ClientTransport.start()` → `attachStdin()`; `ClientTransport.close()` → `detachStdin()` → `finish()`
- `HttpUpstreamLink.connect(client)` → `connectTransport(client)` → `mirrorNotificationsAfterConnect()`

Rejected: a base class `FramedTransport` with an abstract `writeLine` (inheritance couples two lifecycles that only share framing; composition keeps each class's state explicit) and keeping the duplication while only splitting methods (leaves ~90 duplicated lines, which is the complexity being removed). The `UpstreamLink` / `UpstreamTarget` / `createUpstreamLink` surface is untouched, so `bridge.ts` compiles and behaves identically without edits.

### D3 — Characterization first, baseline re-run

Before any extraction:

- Record the CLI baseline (exit code + first stderr line) for every `parseRunInvocation` case, as `replay-cli-refactor` did.
- Add run-parser characterization cases to `tests/cli.test.ts`: missing values (`--config`, `--timeout-ms`, `--max-attempts`), invalid integers (`abc`, `0`, `-1`, `1.5`), unknown option, no target, `--` without a command, `--http` + `--` conflict, options after `--` treated as command arguments, each option accepted before `--`, and the shorthand routing (`mcprelay --config x -- node`).
- Add `tests/transports.test.ts` locking both classes before the extraction: `ClientTransport` with injected streams (frames split across chunks, blank lines ignored, invalid JSON → `onerror` and continue, batch line surfaced verbatim, notification dispatched before message, `onclose` exactly once, close detaches handlers) and `UpstreamTransport` against a hermetic child script (stdout framing, stderr forwarding, non-zero exit → `onerror` + `onclose`, `close()` suppresses the exit error).

After each extraction step the full suite must stay green; at the end the baseline CLI invocations are repeated and compared.

### D4 — No architecture change

File-local structure only: the living diagram, README, PRD, and AGENTS status line are untouched (recorded in tasks), mirroring the `replay-cli-refactor` precedent.

## Risks / Trade-offs

- **Behavior drift in messages or index arithmetic** → baseline recorded first; characterization tests pin every case; full suite after each extraction.
- **Framing semantics drift (notification ordering, close-once)** → `tests/transports.test.ts` pins ordering, batch, error, and close semantics; `proxy.test.ts` progress and batch tests stay unchanged as the integration net.
- **Hot-path regression from composition** → decoder adds one method dispatch per frame and no I/O, serialization, or per-frame closure beyond the existing chain; NFR-3 `bench/` remains the arbiter.
- **Helper sprawl in `run.ts`** → one helper per token kind, no generic framework; helpers stay private in the same file.
- **`FrameDecoder` becomes a hidden god-object** → it owns framing only; sinks, lifecycle, and handler wiring stay in the transports.

## Migration Plan

Not applicable: internal refactor, no data or interface change. Rollback is a revert of the refactor commit.

## Open Questions

(none)

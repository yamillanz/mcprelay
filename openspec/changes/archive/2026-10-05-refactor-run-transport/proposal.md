## Why

Two load-bearing files resist scanning. `parseRunInvocation` in `src/cli/run.ts` handles every option inline in one loop, repeats the same optional-field spread three times when building the invocation, and mixes terminal target validation with the scan. `src/proxy/transports.ts` — the file every M6 session depends on — duplicates its entire line-framing pipeline between `UpstreamTransport` and `ClientTransport` (buffering, JSON parse, batch detection, notification dispatch, error dispatch, microtask ordering, finish) and wires process lifecycle inline. The project owner asked for the same treatment `parseReplayTokens` received: entry points that read as named steps, with per-case helpers carrying descriptive names.

## What Changes

- Refactor `parseRunInvocation` into a token loop over a named dispatcher whose cases (`--config`, `--timeout-ms`, `--max-attempts`, `--policy-dry-run`, `--http`) are same-file helpers with descriptive names; shared option-value reading, one invocation builder, and named terminal steps for the `--http` and `-- <server command…>` forms.
- Refactor `src/proxy/transports.ts`: extract the duplicated line-framing pipeline once (same file, private), so `UpstreamTransport` and `ClientTransport` keep only sink- and lifecycle-specific code; `start()` / `connect()` / `close()` read as ordered named steps.
- Preserve behavior exactly: CLI messages, exit codes, option semantics, wire protocol, frame ordering, error/close semantics, and process hygiene are untouched. Characterization tests lock both surfaces before extraction; the existing suite passes without assertion edits.
- Extend the `maintainability` capability with the run-CLI parsing and upstream/client transport structure contracts.
- No new files, modules, exports, or dependencies in `src/`; no architecture, flow, or component change (the living diagram is not regenerated).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `maintainability`: adds requirements that `parseRunInvocation` reads as a dispatcher over token kinds whose cases are same-file, descriptively named helpers, and that the transport framing pipeline exists once with `UpstreamTransport` / `ClientTransport` reduced to sink and lifecycle specifics — both with behavior preserved by characterization tests and the existing suite.

## Impact

- **Code**: `src/cli/run.ts` and `src/proxy/transports.ts` (structure only); no public interface changes, so `src/proxy/bridge.ts` and `src/proxy/run.ts` stay untouched.
- **Tests**: `tests/cli.test.ts` gains run-parser characterization cases; a focused transport characterization test locks framing, ordering, batch, error, and close semantics (no existing assertions change).
- **Unchanged**: CLI surface, error messages, exit codes, dependencies, protocol behavior, architecture.

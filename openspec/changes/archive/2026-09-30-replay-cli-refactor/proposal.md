## Why

`parseReplayTokens` and `parseRunTokens` in `src/replay/replay-cli.ts` are two long switch loops where each option's parsing, validation, and index bookkeeping sit inline. A maintainer cannot scan them, and the project owner explicitly asked for per-case same-file helpers with descriptive names — the readability convention `maintainability` already records for the proxy bridge.

## What Changes

- Refactor both parsers so every `switch` case delegates to a top-level, descriptively named helper in the same file (the loop stays a dispatcher); shared option-value reading (missing-value error) becomes one helper.
- Preserve behavior exactly: option surface, error messages, exit codes, filter assignments, positional-id rules (`inspect` vs `run`), and `--set` / `--force` / `--dry-run` / `--json` semantics are untouched. Characterization tests lock every parser case before the extraction; the existing suite passes without assertion changes.
- Extend the `maintainability` capability with the replay-CLI parsing contract.
- No new files, modules, classes, or dependencies; no architecture, flow, or component change (the living diagram is not regenerated).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `maintainability`: adds a requirement that the replay CLI argument parsers read as a dispatcher over token kinds whose cases are same-file, descriptively named helpers, with behavior preserved by the existing suite.

## Impact

- **Code**: `src/replay/replay-cli.ts` (structure only); `tests/replay-cli.test.ts` gains characterization cases (no existing assertions change).
- **Unchanged**: CLI surface, error messages, exit codes, dependencies, protocol behavior, architecture.

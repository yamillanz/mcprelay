## Context

`src/replay/replay-cli.ts` (M4, archived change `2026-09-29-replay-cli`) parses its CLI in two switch loops: `parseReplayTokens` (list/inspect) and `parseRunTokens` (run). Each case mixes flag detection, value reading, validation, option assignment, and index arithmetic inline, so the option surface cannot be read at a glance. The project owner asked for per-case, same-file helpers with descriptive names — the same convention `2026-09-28-readability-refactor` established for the bridge and `maintainability` records.

Constraint: parsing is CLI-entry code (once per process), so extraction cannot affect any hot path; behavior — messages, exit codes, filter assignments, positional-id rules — must be preserved byte-for-byte.

## Goals / Non-Goals

**Goals:**

- Each parser reads as a loop + dispatcher; every token kind maps to a descriptively named same-file helper holding that case's logic.
- The shared "value follows flag" guard (missing-value error) exists once.
- Behavior preservation proven by characterization tests written before the extraction, plus the unchanged existing suite.

**Non-Goals:**

- Changing the CLI surface, messages, exit codes, or option semantics.
- New files, modules, classes, exports, or dependencies.
- Touching `replay-run.ts`, the queue, or the middleware.
- Any performance work (this code runs once per invocation, never per call).

## Decisions

### D1 — Loop + dispatcher + per-case helpers

`parseReplayTokens` and `parseRunTokens` keep their single `while` loop and final validation, but the loop body becomes one call to a named dispatcher, and the dispatcher's `switch` maps each token to its helper:

```ts
while (index < tokens.length) {
  const token = tokens[index] as string;
  const step = consumeReplayToken(subcommand, tokens, index, token, options);
  if (!step.ok) return { ok: false, message: step.message };
  index = step.next;
}
```

Helpers return `Step = { ok: true; next: number } | { ok: false; message: string }` and mutate the options object, exactly as the inline code did. Rejected: a class-based parser or a generic option-spec table (new indirection for a 100-line file; the repo convention is same-file named functions).

### D2 — One value reader

`readOptionValue(tokens, index, flag)` returns `{ ok: true; value, next }` or the exact `Missing value for '<flag>'.` error, replacing the repeated guard in `--config`, `--tool`/`--correlation-id`/`--since`/`--until`, `--status`, and `--set`. `--limit` deliberately does not use it: its missing-value behavior is the distinct `Invalid value for '--limit': undefined` message, preserved as-is.

### D3 — Named cases

`parseReplayTokens`: `consumeConfigPath`, `consumeJsonFlag`, `consumeFilterOption` (tool / correlation-id / since / until), `consumeStatus` (validates `REPLAY_STATUSES`), `consumeLimit`, `consumeInspectId` (positional id, otherwise the unknown-option error).

`parseRunTokens`: `consumeConfigPath`, `consumeSetOverride` (`key=value` split and validation), `consumeBooleanFlag` (`--dry-run` / `--force` / `--json`), `consumeRunId` (positional id, otherwise the unknown-option error).

### D4 — Characterization first, suite unchanged

The parsers are private; observable behavior is CLI exit codes and messages. Before extracting, add characterization tests to `tests/replay-cli.test.ts` for the uncovered cases: missing/invalid `--status`, missing/invalid `--limit` (including the `undefined` message), missing values for `--config`/`--tool`/`--set`, invalid `--set` shapes, unknown options for list/inspect/run, positional-id rules (`inspect` accepts one, `run` requires one, second positionals are unknown options), and `--dry-run`/`--force`/`--json` acceptance. Existing assertions are not edited.

### D5 — No architecture change

This is file-local structure; the living diagram is not regenerated (recorded in tasks), mirroring the `readability-refactor` precedent.

## Risks / Trade-offs

- **Behavior drift in error messages or index arithmetic** → characterization tests lock every case first; the full suite (227 tests) runs after each extraction step.
- **Helper sprawl** → one helper per case, no generic framework; helpers stay private in the same file.
- **`--limit` divergence trap** → explicitly documented in D2 and covered by a characterization test for the missing-value message.

## Migration Plan

Not applicable: internal refactor, no data or interface change. Rollback is a revert of the refactor commit.

## Open Questions

(none)

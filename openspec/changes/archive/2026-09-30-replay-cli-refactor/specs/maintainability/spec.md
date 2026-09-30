## ADDED Requirements

### Requirement: Readable replay CLI parsing

The `replay` CLI argument parsers (`parseReplayTokens` and `parseRunTokens`) SHALL read as a loop over a dispatcher whose switch maps each token kind to a same-file, descriptively named helper that owns that case's logic and validation. Option-value reading SHALL be shared, and no new module, class, export, or dependency SHALL be introduced.

#### Scenario: Parsers read as named steps
- **WHEN** a maintainer opens `parseReplayTokens` or `parseRunTokens`
- **THEN** the body is a token loop plus the final id check, and every option and flag case appears as a single named helper call

#### Scenario: Helpers stay co-located
- **WHEN** a case helper is extracted
- **THEN** it lives in `src/replay/replay-cli.ts` as a private top-level function and no new file, module, or class is introduced

### Requirement: Parser behavior preserved

The refactor SHALL NOT change observable CLI behavior: option surface, error messages, exit codes, filter assignments, positional-id rules, and `--set` / `--dry-run` / `--force` / `--json` semantics remain identical. Characterization tests SHALL lock every parser case before extraction.

#### Scenario: Characterization tests lock every case
- **WHEN** the refactor lands
- **THEN** tests cover missing and invalid values (`--config`, `--tool`, `--status`, `--limit`, `--set`), unknown options, and positional-id rules for both subcommands, asserting the same messages and exit codes as before

#### Scenario: Existing suite passes unchanged
- **WHEN** the refactor lands
- **THEN** `replay list`, `replay inspect`, and `replay run` tests pass without edits to their assertions

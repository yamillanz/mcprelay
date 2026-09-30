# maintainability Specification

## Purpose
Code-structure contract for the proxy: startup entry points read as named steps, helpers stay same-file and descriptively named, and behavior is preserved by the existing suite.
## Requirements
### Requirement: Readable bridge startup

The stdio proxy bridge SHALL expose its session startup as an ordered sequence of descriptively named steps in `startBridge`, with helper logic in same-file functions (no new modules, classes, or import boundaries). The `tools/call` interception SHALL delegate its phases to descriptively named helpers.

#### Scenario: Startup reads as named steps
- **WHEN** a maintainer opens `startBridge`
- **THEN** each major phase — transports, batch relay, upstream client, upstream connect, session capture, server factory, client serving, close — appears as a single named function call in execution order

#### Scenario: Helpers stay co-located
- **WHEN** a helper is extracted from the bridge
- **THEN** it lives in `src/proxy/bridge.ts` as a top-level function and no new file, module, or class is introduced

#### Scenario: Interception phases are named
- **WHEN** a `tools/call` is handled
- **THEN** correlation/metadata preparation, upstream relay, and log-entry construction are separate named helpers, and the handler body reads as their sequence

### Requirement: Behavior preservation

The refactor SHALL NOT change observable behavior: protocol relay, correlation, logging fields, exit codes, and process hygiene remain as specified by the `stdio-proxy` and `observability` capabilities.

#### Scenario: Existing suite passes unchanged
- **WHEN** the refactor lands
- **THEN** all existing tests (CLI, echo server, proxy matrix, call logs) pass without edits to their assertions

#### Scenario: Protocol surface unchanged
- **WHEN** the proxy runs against the hermetic server and the real filesystem server
- **THEN** the passthrough matrix, interception behavior, and log-line fields are the same as before the refactor

#### Scenario: No hot-path overhead added
- **WHEN** an intercepted call is relayed
- **THEN** the refactor introduces no extra I/O or serialization steps; extraction is file-local structure, not cross-module indirection, and the NFR-3 benchmark remains the arbiter of performance

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


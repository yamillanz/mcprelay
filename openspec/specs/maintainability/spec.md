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

### Requirement: Readable run CLI parsing

`parseRunInvocation` in `src/cli/run.ts` SHALL read as a token loop over a dispatcher whose switch maps each token kind to a same-file, descriptively named helper that owns that case's logic and validation. Option-value reading and positive-integer validation SHALL be shared, invocation construction SHALL exist once, and the terminal target checks (`--http` vs `-- <server command…>`) SHALL be named steps. No new module, class, export, or dependency SHALL be introduced.

#### Scenario: Parser reads as named steps
- **WHEN** a maintainer opens `parseRunInvocation`
- **THEN** the body is a token loop plus the terminal target step, and every option and flag case (`--config`, `--timeout-ms`, `--max-attempts`, `--policy-dry-run`, `--http`) appears as a single named helper call

#### Scenario: Helpers stay co-located
- **WHEN** a case helper is extracted
- **THEN** it lives in `src/cli/run.ts` as a private top-level function and no new file, module, or class is introduced

### Requirement: Readable transport framing

`src/proxy/transports.ts` SHALL contain exactly one line-framing implementation — buffering, line splitting, JSON parse, batch detection, notification dispatch, error dispatch, and microtask ordering — shared by `UpstreamTransport` and `ClientTransport` within the same file. Each transport SHALL keep only its sink, lifecycle, and handler wiring, and its `start` / `close` (and `HttpUpstreamLink.connect`) SHALL read as ordered, descriptively named steps. The public surfaces (`Transport` implementation, `ClientTransport`, `UpstreamTarget`, `UpstreamLink`, `createUpstreamLink`) SHALL remain unchanged.

#### Scenario: Framing exists once
- **WHEN** a maintainer opens `src/proxy/transports.ts`
- **THEN** buffering, parse, batch, notification, and error dispatch appear once and both transports delegate to it

#### Scenario: Lifecycle reads as named steps
- **WHEN** a maintainer opens `UpstreamTransport.start`, `ClientTransport.start`, or `HttpUpstreamLink.connect`
- **THEN** each phase (spawn, stderr forwarding, exit/error watching, stdin attach/detach, notification mirroring) is a single named call in execution order

#### Scenario: Public surface unchanged
- **WHEN** the bridge and proxy runner compile against the refactored file
- **THEN** `UpstreamLink`, `UpstreamTarget`, `createUpstreamLink`, and `ClientTransport` keep their signatures and `src/proxy/bridge.ts` needs no edits

### Requirement: Run parser behavior preserved

The refactor SHALL NOT change observable run-CLI behavior: option surface, error messages, exit codes, positional handling after `--`, and the `--http` / `--` mutual exclusion remain identical. Characterization tests SHALL lock every parser case before extraction.

#### Scenario: Characterization tests lock every case
- **WHEN** the refactor lands
- **THEN** tests cover missing and invalid values (`--config`, `--timeout-ms`, `--max-attempts`), unknown options, the no-target usage error, `--` without a command, the `--http` + `--` conflict, and options after `--` treated as command arguments, asserting the same messages and exit codes as before

#### Scenario: Existing suite passes unchanged
- **WHEN** the refactor lands
- **THEN** the run and transport CLI tests pass without edits to their assertions

### Requirement: Transport behavior preserved

The refactor SHALL NOT change observable transport behavior: wire framing, notification-before-message dispatch order, batch relay, error dispatch, close-once semantics, process-hygiene signals, and HTTP notification mirroring remain as specified by the `stdio-proxy` and `http-transport` capabilities. Characterization tests SHALL lock both transports before extraction, and the refactor SHALL add no per-frame I/O, serialization, or cross-module indirection.

#### Scenario: Characterization tests lock both transports
- **WHEN** the refactor lands
- **THEN** tests cover frames split across chunks, blank lines, invalid JSON (error and continue), batch lines surfaced verbatim, notification ordering, `onclose` exactly once, and non-zero upstream exit handling

#### Scenario: Existing suite passes unchanged
- **WHEN** the refactor lands
- **THEN** the proxy passthrough matrix, progress-notification, batch-relay, crash, and HTTP upstream tests pass without edits to their assertions

#### Scenario: No hot-path overhead added
- **WHEN** an intercepted call is relayed
- **THEN** the framing extraction adds no extra I/O or serialization steps, and the NFR-3 benchmark remains the arbiter of performance

### Requirement: Port-only provider selection

Core paths (the proxy bridge, the replay CLI, the policy CLI, and the report CLI) SHALL obtain their `QueueProvider` / `IdempotencyIndex` and `Store` instances only through the `createPersistence(config)` factory, which SHALL be the single place that maps `queue.provider` to a concrete adapter. No core module outside the factory and the adapter files SHALL import a concrete adapter, so adding or switching an adapter changes only the factory and configuration.

#### Scenario: The replay CLI selects through the factory
- **WHEN** a maintainer opens the replay run path
- **THEN** it constructs no concrete adapter and receives its providers from the factory

#### Scenario: The report CLI selects through the factory
- **WHEN** a maintainer opens the report path
- **THEN** it reads metrics through the store obtained from the factory and imports no concrete adapter

#### Scenario: Adapter imports stay contained
- **WHEN** the source tree is inspected for concrete queue/store adapter imports
- **THEN** only the factory and the adapter files reference them; the bridge, replay CLI, policy CLI, and report CLI reference port types only

#### Scenario: Switching providers changes no core logic
- **WHEN** `queue.provider` changes between `sqlite` and `rabbitmq`
- **THEN** the same core code runs and only the factory chooses a different adapter


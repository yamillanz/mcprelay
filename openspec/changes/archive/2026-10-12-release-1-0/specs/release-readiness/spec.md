## ADDED Requirements

### Requirement: Verified public-server examples

`examples/` SHALL contain at least three recipes wrapping public MCP servers, each with a `mcprelay.config.yaml` and a README describing how to run it. A suite test SHALL wrap every recipe's server through the middleware, initialize the session, and list its tools.

#### Scenario: Three public recipes present

- **WHEN** a maintainer lists `examples/`
- **THEN** at least three recipes reference public MCP servers (filesystem, memory, everything), each with a config and run instructions

#### Scenario: Every recipe is smoke-tested

- **WHEN** the test suite runs
- **THEN** each recipe's server is wrapped, the session initializes, and `tools/list` returns at least one tool

### Requirement: Reproducible §1 demo asset

The §1 demo (call → deny → fail → DLQ → replay → report, ending on the visible replayed side effect) SHALL run against the real filesystem server from one documented command, and the README GIF SHALL be regenerated from that transcript by a committed script.

#### Scenario: Demo runs end-to-end

- **WHEN** the demo command runs on a clean checkout after a build
- **THEN** every beat executes against the real server and the replay leaves the written file on disk (the visible side effect)

#### Scenario: GIF is regenerable

- **WHEN** the GIF script runs against the demo transcript
- **THEN** `docs/assets/demo.gif` is produced without manual steps beyond the documented prerequisites

### Requirement: Release surface

The README SHALL lead with the hero GIF and the client-config quickstart, answer `tools/list` visibility (FR-Y5) and replay semantics, list design decisions with rejected alternatives referencing ADRs, and carry a competitive table with per-row repository links. The package SHALL be publishable as 1.0.0 and runnable via `npx @yamillanz/mcprelay`.

#### Scenario: README carries the release surface

- **WHEN** a reader opens the README
- **THEN** the hero GIF, client-config quickstart, replay semantics, `tools/list` note, design decisions with ADR references, and the linked competitive table are all present

#### Scenario: Published package smoke

- **WHEN** `npx @yamillanz/mcprelay --version` runs after the 1.0.0 publish
- **THEN** it prints the 1.0.0 version

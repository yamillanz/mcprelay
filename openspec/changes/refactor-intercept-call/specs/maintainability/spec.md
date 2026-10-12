## ADDED Requirements

### Requirement: Readable tools/call interception

`interceptToolCall` in `src/proxy/bridge.ts` SHALL read as an ordered sequence of named gates/steps — call-context preparation, credential gate, policy gate, retry-wrapped execution, outcome finalization — with each gate's logging, audit, capture, and idempotency side effects owned by a same-file, descriptively named helper. Control flow SHALL remain visible in the handler body: the `-32003` and `-32001` throws sit adjacent to their gate conditions, and the policy dry-run continue is explicit. No new module, class, export, or dependency SHALL be introduced. Every extracted helper SHALL stay within the measured function gates: body ≤ 40 lines, nesting ≤ 2, cyclomatic complexity ≤ 6, params ≤ 3.

#### Scenario: Handler reads as named gates
- **WHEN** a maintainer opens `interceptToolCall`
- **THEN** the body is the five steps in execution order — prepare, credential gate, policy gate, execute, outcome — and every throw site is adjacent to its gate condition

#### Scenario: Helpers stay co-located
- **WHEN** a gate or step is extracted
- **THEN** it lives in `src/proxy/bridge.ts` as a private top-level function and no new file, module, or class is introduced

#### Scenario: Helpers stay within measured limits
- **WHEN** the refactor lands
- **THEN** every extracted helper and the handler measure within the gates, with the actual numbers recorded in the tasks

### Requirement: Interception behavior preserved

The refactor SHALL NOT change observable interception behavior: identity resolution and the `-32003` rejection path, policy denial/dry-run semantics, retry classification, D4 capture, cancellation, idempotent-execution recording, and log/event/audit/record shapes remain as specified by the `identity`, `policy`, `observability`, and `reliability` capabilities.

#### Scenario: Existing suite passes unchanged
- **WHEN** the refactor lands
- **THEN** the identity, policy, retry, idempotency, capture, and cancellation session tests pass without edits to their assertions

#### Scenario: Protocol parity on the real server
- **WHEN** a smoke runs against the real filesystem server (profile call, caller-rule denial, keyed call, unknown key)
- **THEN** outcomes, log decisions by caller, and report rows match the recorded M9 evidence

#### Scenario: No hot-path overhead added
- **WHEN** an intercepted call is relayed
- **THEN** per-call I/O, serialization, and log/capture/audit write counts are unchanged; extraction is file-local structure, and the NFR-3 benchmark remains the arbiter of performance

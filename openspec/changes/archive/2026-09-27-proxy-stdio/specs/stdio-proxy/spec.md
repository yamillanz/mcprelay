## ADDED Requirements

### Requirement: One-line stdio wrap

The middleware SHALL wrap any stdio MCP server via `mcprelay run -- <server command…>` (and the `mcprelay -- <server command…>` shorthand) and present itself to the client as an ordinary MCP server. The upstream server SHALL NOT require modification, recompilation, or awareness of the middleware.

#### Scenario: Wrap a real server end to end
- **WHEN** a client connects to `mcprelay run -- <server command…>` and runs an MCP session (initialize, tools/list, tools/call)
- **THEN** the session succeeds and results are semantically equal to the same session run directly against the upstream

#### Scenario: Shorthand invocation
- **WHEN** the CLI is invoked as `mcprelay -- <server command…>`
- **THEN** it behaves identically to `mcprelay run -- <server command…>`

#### Scenario: Missing server command
- **WHEN** `run` is invoked without a server command
- **THEN** the CLI prints a hint to stderr and exits with the usage exit code (2), starting no process

### Requirement: Protocol fidelity and passthrough matrix

Except for `tools/call`, the middleware SHALL pass JSON-RPC messages through semantically unchanged (all fields preserved): every client→server request/notification other than `tools/call`, server→client requests, `notifications/progress`, JSON-RPC batch frames, and `initialize` capability negotiation on both sides. The only deliberate deviations are `tools/call` handling, error wrapping, and injected `_meta` correlation keys on intercepted calls.

#### Scenario: Client→server requests pass through
- **WHEN** the client sends each of `tools/list`, `resources/list`, `resources/read`, `resources/templates/list`, `resources/subscribe`, `resources/unsubscribe`, `prompts/list`, `prompts/get`, `completion/complete`, `logging/setLevel`, and `ping`
- **THEN** the upstream receives the same method and params, and the client receives the upstream's result unchanged

#### Scenario: Client→server notifications pass through
- **WHEN** the client sends `notifications/initialized`, `notifications/cancelled`, `notifications/progress`, and `notifications/roots/list_changed`
- **THEN** each reaches the upstream unchanged

#### Scenario: Server→client requests pass through
- **WHEN** the upstream sends `sampling/createMessage`, `elicitation/create`, and `roots/list` to the client
- **THEN** the client receives the request and the upstream receives the client's response unchanged

#### Scenario: Progress notifications pass through
- **WHEN** the upstream emits `notifications/progress` for an in-flight request
- **THEN** the client receives it unchanged

#### Scenario: Unknown and custom methods pass through
- **WHEN** the client or the upstream sends a method the middleware does not know
- **THEN** it is relayed unchanged and its result or error is relayed back

#### Scenario: Batch frames pass through
- **WHEN** the client sends a JSON-RPC batch frame
- **THEN** the frame reaches the upstream unchanged and the upstream's batch response reaches the client unchanged; a `tools/call` inside a batch is not intercepted (documented boundary)

#### Scenario: Initialize capability negotiation
- **WHEN** a client sends `initialize`
- **THEN** it receives a result whose capabilities and serverInfo match the upstream's negotiated session and whose protocolVersion is one the client requested and the middleware supports

#### Scenario: Upstream sees no middleware-specific fields
- **WHEN** any passthrough message is relayed
- **THEN** the upstream receives it without middleware-specific fields, except the injected `_meta` correlation keys on intercepted `tools/call` requests

### Requirement: `tools/call` interception and session recording

The middleware SHALL intercept `tools/call` as the control point for correlation, reliability, and logging, and SHALL record `initialize` and `tools/list` results as session context.

#### Scenario: Interception forwards exactly one call
- **WHEN** a client sends `tools/call`
- **THEN** the middleware forwards exactly one upstream call with the same tool name and arguments (plus injected correlation `_meta`) and relays the result to the client

#### Scenario: Result fidelity
- **WHEN** the upstream returns a `tools/call` result (success or `isError: true`)
- **THEN** the client receives it semantically unchanged

#### Scenario: Session context recorded
- **WHEN** `initialize` and `tools/list` complete
- **THEN** the session context holds the upstream server name/version, the negotiated revision, and the tool inventory, and subsequent call logs carry the server name

#### Scenario: Upstream tool error
- **WHEN** the upstream returns an error for `tools/call`
- **THEN** the client receives a standard MCP error and the call is logged as failed

### Requirement: Process hygiene

Upstream stdout and stderr SHALL be handled so the client session behaves normally: server logs forwarded to stderr, never mixed into the protocol stream. Upstream exit or crash SHALL surface as a clean transport error and SHALL NOT corrupt records already written.

#### Scenario: Upstream stderr separation
- **WHEN** the upstream writes to stderr
- **THEN** those bytes appear on the middleware's stderr and never on the client-facing stdout protocol stream

#### Scenario: Middleware log purity
- **WHEN** the middleware emits its own structured logs
- **THEN** they appear only on stderr, never on the client-facing stdout protocol stream

#### Scenario: Upstream crash mid-call
- **WHEN** the upstream exits while a `tools/call` is in flight
- **THEN** the client receives a standard JSON-RPC error for that call and the middleware exits with the documented upstream-failure exit code

#### Scenario: Already-written records survive a crash
- **WHEN** the upstream crashes after a call was logged
- **THEN** that call's log line remains intact on stderr

### Requirement: Correlation

Every intercepted call SHALL carry a generated `correlation_id` propagated into the call log line. When the client supplies OTel `traceparent`/`tracestate`/`baggage` in `_meta`, those values SHALL be preserved and logged alongside.

#### Scenario: Generated correlation id
- **WHEN** a `tools/call` is intercepted
- **THEN** it carries a generated correlation_id that appears in the call's log line and is distinct across calls

#### Scenario: OTel context preserved
- **WHEN** the client's `tools/call` `_meta` contains `traceparent`, `tracestate`, or `baggage`
- **THEN** those values are forwarded upstream unchanged and logged alongside the correlation_id

#### Scenario: Namespaced injection
- **WHEN** the middleware forwards an intercepted call
- **THEN** the upstream request `_meta` carries the correlation id under the middleware's namespaced key and the client's other `_meta` fields are preserved

### Requirement: Protocol revision termination

The middleware SHALL terminate MCP on both sides using the official SDK v2 line, targeting revision 2026-07-28, and each side SHALL negotiate its revision independently. Older revisions SHALL work to the extent the SDK supports them on each side; the boundary SHALL be documented in an ADR.

#### Scenario: Independent revision negotiation
- **WHEN** the client and the upstream negotiate different supported revisions
- **THEN** the session succeeds and each side sees a revision it requested, within the SDK's support

#### Scenario: Modern revision preferred
- **WHEN** both sides support revision 2026-07-28
- **THEN** the session uses it

#### Scenario: Unsupported revision
- **WHEN** a client requests a revision the SDK does not support
- **THEN** the middleware returns a standard error naming the supported revisions and the session does not crash

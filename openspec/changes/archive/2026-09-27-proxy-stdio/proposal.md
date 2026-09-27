## Why

M0 delivered a CLI shell; nothing is proxied yet. Every later milestone — retry, DLQ, replay, policy — hangs off a transparent stdio proxy that can intercept `tools/call` without the upstream server or the client noticing. M1 makes `mcprelay` the invisible middleman and turns demo beat 1 real: wrap any stdio server, run a full session through it semantically unchanged, and show one structured log line per intercepted call.

## What Changes

- **Wrap any stdio MCP server 1:1**: `mcprelay run -- <server command…>`, plus the `mcprelay -- <server command…>` shorthand from the §1 demo. The client speaks MCP to `mcprelay`; `mcprelay` speaks MCP to the unmodified upstream.
- **Protocol fidelity (FR-P2)**: every client→server request/notification other than `tools/call` passes through semantically unchanged — `tools/list`, `resources/*`, `prompts/*`, `completion/*`, `logging/setLevel`, `notifications/initialized`; server→client requests (`sampling/createMessage`, `elicitation/create`, `roots/list`); `notifications/progress`; JSON-RPC batch frames; and `initialize` capability negotiation on both sides. `tools/call` is the only method with intercepted semantics.
- **`tools/call` interception (FR-P3)**: generated `correlation_id`, preserved OTel `_meta` (`traceparent`/`tracestate`/`baggage`), latency and payload-size measurement; upstream errors relayed to the client as standard MCP errors.
- **Structured logs (FR-O1)**: one JSON line per intercepted call on **stderr** with timestamp, correlation id (+ OTel context), caller, server, tool, decision, latency_ms, payload sizes, attempt count, and error. Argument values are not logged at M1 (redaction config lands with M2/M3), so no secret can leak through the log line.
- **Session context (FR-P3)**: `initialize` and `tools/list` results captured in memory (server name/version, negotiated revision, tool inventory) and reflected in subsequent call logs.
- **Process hygiene (FR-P4)**: upstream stderr forwarded to stderr, never mixed into the protocol stream; upstream exit/crash surfaces as a clean JSON-RPC error to pending calls and a documented non-zero exit code.
- **Revision termination (FR-P6)**: SDK v2 terminates MCP on both sides; each side negotiates its revision independently; the supported-revision boundary is documented in ADR-0002.
- **Documented boundary**: batch frames are relayed unchanged, and a `tools/call` *inside* a batch is not intercepted — JSON-RPC batching is not part of the 2026-07-28 revision; recorded in design.md and ADR-0002.

Scope note: seven FRs, two spec capabilities, one demo beat. FR-P1–P6 are one mechanism (the bridge); FR-O1 is its observability — a proxy that cannot be observed cannot pass the milestone's own real-server check, so they ship together.

No breaking changes: the CLI gains `run`; existing `version`/`help` behavior is unchanged.

## Capabilities

### New Capabilities

- `stdio-proxy`: transparent 1:1 stdio proxy — invocation (FR-P1), protocol fidelity and the passthrough matrix (FR-P2), `tools/call` interception and session recording (FR-P3), process hygiene (FR-P4), correlation (FR-P5), and protocol-revision termination (FR-P6).
- `observability`: structured per-call JSON logging (FR-O1) — the call log line and its fields.

### Modified Capabilities

(none — no specs exist yet; first change with deltas)

## Impact

- **New code**: `src/proxy/` (bridge, framing, session context), `src/cli/` `run` command, `src/observability/` call-log writer, hermetic test server under `examples/`, `tests/` suites for the fidelity matrix and call logging, `docs/adr/0002-protocol-termination.md`.
- **Dependencies**: `@modelcontextprotocol/server@^2.1.0` and `@modelcontextprotocol/client@^2.1.0` (both MIT; pull `@modelcontextprotocol/core`, `zod`, `jose`, `cross-spawn`, `eventsource*`, `pkce-challenge` — all permissive). Justification: PRD FR-P6 mandates the official SDK v2 line; no alternative is in scope (P5).
- **No config surface at M1**: zero-config; the only new input is the wrapped command and its arguments.
- **Docs**: README status advances; ADR-0002 lands; AGENTS status line updates to M1 done at archive.

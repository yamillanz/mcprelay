## Context

M0 landed the CLI shell, toolchain, and CI; `run` does not exist yet. M1 must make `mcprelay` a transparent 1:1 stdio middleman and the first demo beat observable: wrap any stdio server, pass a session through semantically unchanged, and log one structured line per intercepted `tools/call`.

The PRD pins the protocol stack: spec revision 2026-07-28, official SDK v2 line (FR-P6). The v2 line is a package family — `@modelcontextprotocol/server` (low-level `Server`, `Protocol`, types, `SUPPORTED_PROTOCOL_VERSIONS`, era constants), `@modelcontextprotocol/client` (`Client`), each with a `/stdio` subpath (`StdioServerTransport`, `StdioClientTransport`), plus `@modelcontextprotocol/core`. All MIT. Verified at `2.1.0`: `Protocol` exposes `fallbackRequestHandler`/`fallbackNotificationHandler` (raw relay of unknown/custom methods), `StdioClientTransport` spawns the upstream and exposes its `stderr` stream, and the SDK models protocol **eras** (`MODERN_PROTOCOL_VERSION = "2026-07-28"` stateless era; legacy 2025 era with `initialize`).

Two constraints shape the design:

1. **Termination is normative** (FR-P6): the middleware is an MCP server toward the client and an MCP client toward upstream, so each side negotiates its revision independently.
2. **Fidelity is normative** (FR-P2), including JSON-RPC **batch frames** — which the SDK cannot represent: its transports exchange a single `JSONRPCMessage` union, and JSON-RPC batching has been absent from MCP since 2025-06-18 (and is not in 2026-07-28). A batch frame must still pass through unchanged.

## Goals / Non-Goals

**Goals**

- `mcprelay run -- <server command…>` and `mcprelay -- <server command…>` wrap any stdio server with zero config.
- The FR-P2 passthrough matrix is green against the hermetic server, and a full session works against the real filesystem server.
- Every intercepted call emits exactly one FR-O1 JSON line on stderr; the protocol stream stays pure.
- Upstream stderr never touches the protocol stream; upstream crash yields a clean error and a documented exit code.
- SDK v2 termination per FR-P6, with the revision boundary recorded in ADR-0002.

**Non-Goals**

- Retry/timeout, DLQ capture, replay, policy, config files, Store/metrics (M2–M5, M8). `attempt` is always 1; `decision` emits only `allowed`/`failed`.
- Intercepting `tools/call` inside batch frames (see D7).
- Argument-value logging; redaction configuration arrives with M2/M3, so M1 logs sizes only.
- HTTP transport (M6), auth identities (M9).

## Decisions

### D1 — SDK v2 low-level classes, pinned `^2.1.0`

Use `Server` + `StdioServerTransport` (`@modelcontextprotocol/server`) toward the client and `Client` + `StdioClientTransport` (`@modelcontextprotocol/client`) toward upstream. The low-level classes expose the raw protocol surface needed for a relay; the high-level `McpServer` is for implementing tools, not proxying. Runtime deps are the two packages (MIT) plus their transitive `core`, `zod`, `jose`, `cross-spawn`, `eventsource*`, `pkce-challenge` — all permissive, justified by the FR-P6 SDK mandate (rule 7).

*Alternatives rejected:* a pure byte-pipe proxy (perfect fidelity, but no termination, no negotiation, no interception point — violates FR-P6/FR-P3); high-level `McpServer` (no fallback surface for unknown methods).

### D2 — Termination topology and startup order

Middleware = MCP server toward the client, MCP client toward upstream. Startup: parse the wrapped command → spawn and connect upstream (SDK negotiates era/revision, capabilities are learned) → construct the client-facing `Server` with the upstream's capabilities mirrored and start its transport. Only then does the client session proceed. `initialize` is answered from the upstream's negotiated session, so capabilities/serverInfo match while each side keeps its own revision.

*Alternatives rejected:* forwarding `initialize` verbatim (no independent negotiation); starting the client-facing side first and buffering until upstream is known (more state, no benefit).

### D3 — Relay for everything except `tools/call`

`fallbackRequestHandler`/`fallbackNotificationHandler` forward unknown and custom requests/notifications upstream and relay results/errors back. Server→client requests (`sampling/createMessage`, `elicitation/create`, `roots/list`) are handled explicitly and forwarded to the client via the server side; responses relayed back. `tools/call` is the only method with an explicit handler (D4).

*Alternatives rejected:* registering a handler per known method (the matrix changes with every spec revision; fallback is revision-robust).

### D4 — `tools/call` pipeline (M1 slice)

Handler: generate `correlation_id` → capture start time and request size → forward one upstream call with the same tool name/arguments, injecting `_meta.mcprelay.correlation_id` and preserving all client `_meta` (including OTel keys) → relay the result/error unchanged → emit one log line (D5). `attempt` is 1; failures are logged `failed` but not retried or captured (M2/M3).

*Alternatives rejected:* rewriting arguments or results (violates fidelity); buffering/queueing (M3).

### D5 — Correlation and logging

`correlation_id` = UUID v4 (`node:crypto.randomUUID`); injected under `_meta.mcprelay.correlation_id` (namespaced to avoid colliding with spec `_meta` keys). OTel `traceparent`/`tracestate`/`baggage` are forwarded untouched and copied into the log line. Logging is JSON-lines to **stderr** through a small injectable sink so tests capture lines without spawning. Fields exactly per FR-O1; argument values are not logged. Caller is `{ type: "stdio", identity: "local" }` until M9.

*Alternatives rejected:* ULID (sortability only matters when the DLQ orders records, M3); top-level `_meta.correlation_id` (collision risk); file logging (config lands M2/M3).

### D6 — Process hygiene and exit codes

`StdioClientTransport` is created with `stderr: "pipe"`; upstream stderr bytes are forwarded verbatim to the middleware's stderr (no prefix, no reordering) and never to stdout. Upstream `onclose`/`onerror` fails all in-flight intercepted calls with a standard JSON-RPC internal error and exits the middleware with code **3** (upstream/runtime failure). Exit codes: `0` clean end of session, `2` usage error (M0), `3` upstream/runtime failure.

*Alternatives rejected:* inheriting stderr (loses the ability to guarantee stream separation in tests); prefixing upstream lines (mutates bytes; the structured logs are already distinguishable as JSON).

### D7 — Batch frames: demux around the SDK, no interception inside

Because SDK transports cannot carry JSON-RPC arrays, the middleware's stdio framing layer classifies each incoming frame before the SDK sees it: single objects go to the protocol path; arrays are relayed verbatim in both directions around the protocol classes. A `tools/call` inside a batch is therefore not intercepted — a documented boundary (batching is not part of the 2026-07-28 revision; no in-scope client emits it). ADR-0002 records this, the termination topology, and the supported-revision boundary (FR-P6).

*Alternatives rejected:* rejecting batch frames (violates the FR-P2 matrix); full interception inside batches (real scope with no in-scope client; revisit post-v1 if a real client needs it).

### D8 — Session context in memory

`initialize` and `tools/list` results are captured into an in-memory session record (server name/version, negotiated revision, tool inventory) used to enrich call logs (FR-P3). No Store yet (M3); nothing is persisted at M1.

### D9 — Test harness: hermetic server + raw-frame client + real-server gate

- `examples/` hermetic echo server (SDK v2) implements the full matrix: echo methods, custom method, batch frames, server→client requests, progress, stderr output, and a crash switch. It is extended with failure injection in M2.
- Tests use SDK clients for SDK-expressible traffic and a raw newline-JSON child-process helper for frames the SDK cannot express (batches, unknown methods, unsupported revisions).
- The final gate (rule 10) is a real-server session against `@modelcontextprotocol/server-filesystem` plus a readable log line, recorded in `tasks.md`.

## Risks / Trade-offs

- **SDK era mechanics** (modern stateless 2026-07-28 vs legacy 2025 `initialize`) may make termination non-trivial → spike during apply (rule 11 allows spikes; a spike without a following test is debt); if the SDK forces a different boundary, update this design and ADR-0002 before proceeding.
- **SDK-injected fields** (protocol claims, `_meta` additions) could violate "semantically unchanged" → fidelity tests assert only the permitted deviations (D3/D4); any SDK-injected field is documented in ADR-0002.
- **Batch demux adds a second code path** → hermetic tests cover both single and array frames; the demux is small and isolated.
- **Ordering through a stateful relay** (responses vs progress vs server→client requests) → relay preserves arrival order per direction; tests interleave requests and progress.
- **Filesystem server does not exercise server→client requests** → the hermetic server covers them; the real-server gate covers session + tools.
- **Log volume at debug scale** → one line per intercepted call only; other events are not logged at M1.

## Migration Plan

N/A — new command, no data or config migration. README and the AGENTS status line update at archive.

## Open Questions

- Exact SDK v2 stdio era API for the client-facing side (`Server.connect` vs `serveStdio`, claim handling): settle with the apply-phase spike; ADR-0002 records the outcome.
- Whether the SDK `Client` exposes a generic request path sufficient for all relay cases or needs per-method registration for a few server→client requests: settle during the FR-P2 matrix tests.
- Whether the middleware should send `notifications/initialized` upstream after its own upstream handshake (SDK behavior) or relay the client's notification: verify against the hermetic server during apply.

# ADR-0002 — Stdio proxy: termination topology and revision boundary

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-09-25 |
| **Milestone** | M1 `proxy-stdio` |
| **PRD refs** | FR-P1–P6, FR-O1, §6.3, §5.1 |

## Context

M1 wraps any stdio MCP server transparently. Two requirements pull in different directions:

- **FR-P6** says the middleware *terminates* MCP on both sides (an MCP server toward the client, an MCP client toward upstream) and targets revision 2026-07-28 through the official SDK v2 line.
- **FR-P2** says every message except `tools/call` passes through *semantically unchanged*, including JSON-RPC batch frames and server→client requests.

The v2 SDK is role-oriented, not a relay: its protocol classes own handshakes, validate and encode messages, and model protocol *eras*. This ADR records the boundary the implementation chose and the deviations that are now part of the contract.

## Decisions

### D1 — SDK-terminated relay (`@modelcontextprotocol/server|client` 2.1.0)

Upstream: a low-level `Client` connected to a custom `UpstreamTransport` (spawns the wrapped command, newline-delimited JSON-RPC, forwards stderr verbatim). Client side: `serveStdio(factory, { transport })` with a custom `ClientTransport` over process stdin/stdout. Unknown and custom methods relay through `fallbackRequestHandler` → `upstream.request(method, params, permissiveSchema)`; upstream results/errors relay back. A pure byte-pipe was rejected (no termination, no interception point, no revision handling); the high-level `McpServer` was rejected (no fallback surface for unknown methods).

### D2 — Startup order and capabilities

The middleware connects upstream first (SDK negotiates era/revision, capabilities are learned), then starts serving the client with the upstream's `serverInfo`/capabilities/instructions mirrored. A single client session is 1:1 with one upstream process.

Toward upstream the middleware advertises a permissive **client** capability set (`sampling`, `elicitation`, `roots.listChanged`) so server→client requests can be relayed. If the real client did not declare a capability, the relayed request fails and the upstream receives a standard error. Per-client capability mirroring is deferred (M9 identity work).

### D3 — Protocol revision boundary

- Client side: `serveStdio` marks the instance modern at construction and pins it to the era of the opening exchange — a claim-less `initialize` is served on the legacy era; a valid 2026-07-28 `_meta` claim / `server/discover` opening is served modern.
- Upstream side: `Client` uses `versionNegotiation: { mode: 'auto' }` — `server/discover` probe, conservative fallback to the legacy `initialize` handshake.
- Each side therefore negotiates independently. Cross-era *translation* is not attempted: relayed methods are those both eras define; a legacy-only server→client push cannot exist on a modern connection (the SDK rejects it), and 2026-07-28's `input_required` multi-round-trip results relay as results (no M1 handling beyond passthrough).
- Unsupported client revisions receive a standard error naming the supported revisions; the session stays alive (verified in `tests/proxy.test.ts`).

### D4 — JSON-RPC batch frames are relayed outside the SDK

The SDK message model is a single `JSONRPCMessage`; arrays cannot pass through it. Both custom transports classify each line: single objects go to the protocol classes, arrays are relayed verbatim in both directions (`onBatch` → `sendRaw`). Consequence, documented in the delta spec: a `tools/call` *inside* a batch is not intercepted (JSON-RPC batching is absent from the 2026-07-28 revision; no in-scope client emits it).

### D5 — SDK-injected fields (accepted deviations)

On the 2026-07-28 era the SDK auto-attaches a `_meta` envelope (protocol version, client info, client capabilities) to outbound upstream requests and stamps `_meta.io.modelcontextprotocol/serverInfo` into outbound results. These are spec-standard fields produced by a conforming client/server, not middleware-specific data; fidelity tests assert semantic equality excluding them. On the legacy era no such injection occurs, so passthrough is byte-stable there.

### D6 — Lifecycle notifications and progress

Client→upstream notifications are relayed from the transport layer before protocol dispatch (the SDK's protocol layer also consumes lifecycle ones locally). Upstream→client notifications are relayed verbatim except `notifications/progress`, which is re-emitted through the request pipeline with the client's original `progressToken` (the SDK rewrites tokens internally when `onprogress` is used). Progress tokens are therefore preserved end-to-end.

### D7 — Transport frames are processed with a yield between them

The SDK dispatches notification handlers as microtasks. A chunk containing progress notifications followed by the response would otherwise delete the progress handler before dispatch (observed during implementation). Both transports serialize frame processing and `await` a microtask between frames.

### D8 — Process hygiene

Upstream stderr is forwarded verbatim to the middleware's stderr (never stdout). Upstream exit rejects in-flight requests with the SDK's `ConnectionClosed` error, which relays to the client as a standard JSON-RPC error; the middleware then flushes pending writes and exits **3**. Exit codes: `0` clean session, `2` usage, `3` upstream/runtime failure. Windows is best-effort (no shell wrapping of the wrapped command).

## Real-server evidence (rule 10)

Wrapped unmodified `@modelcontextprotocol/server-filesystem` (`secure-filesystem-server` 0.2.0): negotiated 2025-11-25 through the auto-probe fallback, listed 14 tools, read `README.md` through the middleware, and emitted:

```json
{"timestamp":"2026-09-25T19:29:27.566Z","correlation_id":"03022cd0-056c-4282-9a40-87e9896351ca","caller":{"type":"stdio","identity":"local"},"server":"secure-filesystem-server","tool":"read_file","decision":"allowed","latency_ms":3,"request_bytes":166,"response_bytes":2544,"attempt":1}
```

## Consequences

- The FR-P2 passthrough matrix is green against the hermetic echo server; the real-server session above is the zero-intrusion proof.
- `serveStdio` owns the wire's `onclose`; the bridge chains it so client EOF resolves the session.
- The batch demux and progress-token rewrite are the two intentional frame-level deviations; both are covered by tests.
- If the SDK later exposes a first-class relay/bridge API, D1/D4/D5 should be revisited.

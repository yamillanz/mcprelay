## Why

M5 closes the guardrail story, but the middleware still wraps only local stdio processes. §6.1 and the secondary persona (§4) put a **1:1 streamable HTTP upstream** next: the same pipeline (policy → retry → DLQ → replay) toward a remote MCP server, with no stdio-only shortcuts. M6 delivers that transport; it also resolves D2 (Postgres timing) by keeping the v1 adapter cap honest.

## What Changes

- **Upstream transport selection**: `mcprelay run --http <url>` wraps a remote Streamable HTTP MCP server; the client side stays stdio (`run -- <server command…>` remains the stdio form). The config gains `upstream.http.headers` — the middleware's own upstream credentials, never the client's tokens (FR-A3); OAuth/JWT/identities stay in M9.
- **Same pipeline, no shortcuts**: `tools/call` interception, policy (allow/deny/dry-run), D4-classified retry, redacted DLQ capture, and replay behave identically over HTTP. Upstream identity/capabilities/instructions still mirror to the client, and `tools/list` stays unfiltered.
- **Records carry the transport**: `FailureRecord.server` gains `transport: stdio|http` (default `stdio` for existing records; in-place migration) so `replay list/inspect/run` reconnect over the recorded transport — the stored stdio command or the HTTP endpoint. HTTP records store the URL only; credentials are never persisted (NFR-4) and replay uses the current config's headers.
- **Documented boundary**: JSON-RPC batch frames remain a stdio-only legacy passthrough (the SDK's HTTP transport carries single messages); over HTTP they receive a clear JSON-RPC error. A hermetic HTTP echo server joins `examples/` so the whole suite (policy, DLQ, replay) runs against HTTP in CI.
- **PRD** (rule 1): Appendix A adds `server.transport`; D2 is resolved (Postgres → v1.1); document history v0.9.

## Capabilities

### New Capabilities

- `http-transport`: upstream streamable HTTP wrapping — selection (`--http` / config headers), fidelity of the passthrough surface, lifecycle/error classification mapping, and the batch-frame boundary.

### Modified Capabilities

- `dead-letter-queue`: `FailureRecord.server` carries the upstream transport, migrated in place.
- `replay-cli`: replay reconnects over the recorded transport (stdio command or HTTP endpoint + current config headers).
- `configuration`: the `upstream.http.headers` section and the `run --http <url>` flag, strictly validated.

## Impact

- **Code**: upstream link abstraction in `src/proxy/` (`transports.ts` / `bridge.ts` / new HTTP link), `src/cli/run.ts`, `src/config/config.ts`, `src/queue/failure-record.ts` + `sqlite-queue.ts` (in-place migration), `src/replay/replay-run.ts`, `examples/http-echo-server/`.
- **Docs**: ADR-0007 (HTTP upstream semantics), README (HTTP quickstart + boundaries), living architecture diagram, PRD Appendix A / D2 / history.
- **Dependencies**: none new — the SDK v2 line already ships `StreamableHTTPClientTransport` (client) and the server-side HTTP transport for the hermetic fixture.
- **Out of scope**: OAuth/JWT/API-key identities (M9), client-side HTTP termination, legacy SSE transport, batch replay (M7), Postgres (v1.1).

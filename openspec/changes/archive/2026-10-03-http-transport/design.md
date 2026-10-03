## Context

M1–M5 wrap a **local stdio process**: `startBridge` spawns the upstream via the custom `UpstreamTransport` (newline JSON-RPC, batch relay, notification relay), records store `server.command` (shell-quoted), and replay parses that command and spawns it again. The PRD's M6 goal (§12) extends the same pipeline to a **remote Streamable HTTP** upstream: 1:1, same policy/retry/DLQ/replay semantics, no stdio-only shortcuts (§6.1, §4 secondary persona). FR-A3 draws the credential boundary — client tokens are never forwarded; upstream credentials are the middleware's own (full OAuth/JWT/identity work is M9).

The SDK v2 line already ships `StreamableHTTPClientTransport` (session ids, protocol-version headers, `requestInit` headers, reconnection, auth provider) on the client side and the web-standard streamable HTTP server transport for a hermetic fixture. No new dependency is needed.

## Goals / Non-Goals

**Goals:**

- Select the upstream transport per run: `run -- <cmd>` (stdio, unchanged) or `run --http <url>` (remote).
- The whole pipeline works over HTTP: interception, policy, D4 retry, redacted DLQ capture, replay, logs, session mirroring.
- Records carry the transport so replay reconnects over the same kind; pre-M6 databases migrate in place.
- A hermetic HTTP server in `examples/` so the suite covers HTTP in CI.
- Docs tell the truth about the boundaries: no client-token passthrough, batch frames, auth timing.

**Non-Goals:**

- OAuth/JWT/API-key identities (M9) — M6 supports static config headers only.
- Client-side HTTP termination (the client side stays stdio), legacy SSE transport.
- JSON-RPC batch frames over HTTP (legacy stdio passthrough only; explicit error over HTTP).
- Batch replay (M7), Postgres store (D2 → v1.1).

## Decisions

### D1 — CLI and config surface

- `mcprelay run --http <url>` wraps a remote server; mutually exclusive with `-- <server command…>`. `--config`, `--timeout-ms`, `--max-attempts`, and `--policy-dry-run` keep working.
- Config gains `upstream.http.headers` (strict keys, string values), sent on every upstream request through the SDK transport's `requestInit`. These are the middleware's own credentials (FR-A3) — never the client's tokens.
- Rejected: URL in config only (the client-config one-liner must name the URL) and headers as CLI flags (shell history / process list exposure; config files are the local-first pattern and can be gitignored).

### D2 — Upstream link abstraction

The bridge stops depending on the stdio class directly. A small same-file abstraction carries what the bridge needs:

```ts
interface UpstreamLink {
  connected: boolean;                              // fail-fast for the attempt loop
  transport: Transport;                            // handed to client.connect()
  relayNotifications(relay: (n: JSONRPCNotification) => void): void;
  sendBatch(line: string): void;                   // stdio: verbatim; http: explicit error
  close(): Promise<void>;
}
```

- `StdioUpstreamLink` wraps the existing `UpstreamTransport` (child-alive `connected`, existing notification hook, `sendRaw` batches).
- `HttpUpstreamLink` wraps `StreamableHTTPClientTransport`: `connected` is true after `start()` until `close()` (HTTP has no persistent connection to lose; per-request failures surface through the attempt loop and the classifier); `relayNotifications` wraps `transport.onmessage` so upstream notifications (except `notifications/progress`, which the pipeline re-emits with the client's token) reach the client verbatim.

`BridgeOptions` gains an `UpstreamTarget` union: `{ kind: 'stdio'; command; args } | { kind: 'http'; url }`.

### D3 — Records carry the transport (in-place migration)

`FailureRecord.server` becomes `{ name: string; command: string; transport: 'stdio' | 'http' }` — for HTTP, `command` holds the endpoint URL (display target and replay target). SQLite adds `server_transport TEXT NOT NULL DEFAULT 'stdio'` through the existing `ensureColumn` migration; old rows read as `stdio`. Appendix A of the PRD is updated (rule 1).

### D4 — Replay reconnects over the recorded transport

`connectStoredServer(record, config)` branches:

- `stdio` → parse the stored command and spawn (unchanged).
- `http` → `new StreamableHTTPClientTransport(new URL(record.server.command), { requestInit: { headers: config.upstream.http.headers } })` with the same `Client` options.

Credentials are never persisted: the record stores the URL only, and replay reads headers from the **current config** (NFR-4). `replay inspect` shows the transport and target. An unreachable endpoint keeps the current semantics (release → pending).

### D5 — Error classification over HTTP (D4 taxonomy, unchanged semantics)

- **Pre-execution** (retryable unconditionally): transport start/connect failures and send failures — SDK `SdkError` codes `NotConnected` / `SendFailed` / `ConnectionClosed` plus fetch-level network errors.
- **Post-execution**: HTTP responses (4xx/5xx, `SdkHttpError` with a status) and upstream JSON-RPC errors → `post_send`; timeouts → `timeout` (auto-retry only for `idempotent: true`).
- Implementation: an HTTP-aware branch in `failurePhase`; the mapping is pinned by tests (connection refused retries; HTTP 500 does not auto-retry a non-idempotent tool; timeout retries only with `idempotent: true`).
- The SDK transport's internal 404-session reconnection is transport-internal and invisible to the pipeline — documented in ADR-0007.

### D6 — Batch frames over HTTP

The client-facing transport still demuxes batch arrays. With an HTTP upstream the middleware answers the batch with one JSON-RPC error (`-32600`, `id: null`, "batch frames are not supported over an HTTP upstream") instead of forwarding. The 2026-07-28 revision has no batching; the stdio verbatim relay exists for legacy clients only.

### D7 — Hermetic HTTP fixture

`examples/http-echo-server/`: `node:http` bridged to the SDK server package's web-standard streamable HTTP handler (`McpServer` + the HTTP server transport), exposing `echo`, `boom` (`isError`), `rpc-error`, `sleep` — the subset the pipeline tests need. It binds an ephemeral port by default and prints the bound URL on stdout so tests can spawn it and parse the URL. Rejected: hand-rolling the streamable HTTP wire (session ids, SSE framing, content negotiation) — the SDK server transport is exactly what real servers run.

### D8 — Client side unchanged

`serveStdio`, session mirroring, correlation, logs, policy, and observability are untouched. The FR-P2 passthrough matrix applies to HTTP upstreams except batch frames; `tools/list` stays unfiltered.

### D9 — Docs and architecture

- ADR-0007: transport selection, record field + migration, replay reconnection, classification mapping, batch boundary, credentials boundary (FR-A3), rejected alternatives.
- README: HTTP quickstart (`run --http`), headers, boundaries (no token passthrough; batch frames; auth in M9).
- Diagram: merge the two upstream externals into one `MCP Server` node ("stdio spawn · remote HTTP") and rename the transport node to "Upstream transport" ("stdio · streamable HTTP") — stays within the 12-node cap.
- PRD: Appendix A (`server.transport`), D2 resolved (Postgres → v1.1), document history v0.9.

### D10 — Test strategy

- Hermetic integration (`tests/http-upstream.test.ts`): passthrough (initialize/tools/list/tools/call), policy deny over HTTP (`-32001`, audit, no DLQ), failure capture with `transport: http` (rpc-error, timeout), replay over HTTP (run + dry-run), batch error frame, session mirroring.
- Config: `upstream.http.headers` parsing and strict errors; zero-config unaffected.
- Queue: in-place migration (pre-M6 row reads `stdio`), enqueue/read round-trip with `transport: http`.
- Replay: HTTP reconnect uses the record URL + current config headers; assert the header value is absent from the database.
- Real-server gate: filesystem (stdio) + the hermetic HTTP server under the same policy/DLQ config; attempt one public remote endpoint and record evidence.

## Risks / Trade-offs

- **HTTP session semantics differ from stdio** (session id, reconnects) → classification stays conservative (post-execution by default), timeouts remain idempotent-gated; tests pin the mapping; the SDK's internal reconnection is documented.
- **Credential leakage** → headers are never logged and never persisted; a test asserts the DB contains no header value.
- **Batch regression for stdio** → the existing batch tests stay untouched; the HTTP branch is additive.
- **Fixture drift vs. real servers** → the fixture uses the SDK's own server transport; the real-server check adds a public endpoint when reachable.

## Migration Plan

Records migrate in place on first open (`server_transport` defaults to `stdio`); the new config section is optional; existing CLI invocations are unchanged. Rollback is a revert of the change.

## Open Questions

(none)

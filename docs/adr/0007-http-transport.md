# ADR-0007 — HTTP upstream transport semantics

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-09-30 |
| **Milestone** | M6 `http-transport` |
| **PRD refs** | FR-P1–P2, FR-R2–R4, FR-C1, FR-A3, §4, §6.1, §12 |

## Context

Through M5 the middleware wrapped only local stdio processes: `startBridge` spawned the upstream, records stored a shell-quoted `server.command`, and replay parsed and respawned it. The PRD's M6 goal extends the same pipeline to a **remote Streamable HTTP** upstream — 1:1, same policy/retry/DLQ/replay semantics — with the client side still stdio. The SDK v2 line already ships `StreamableHTTPClientTransport` (session ids, protocol-version headers, `requestInit` headers, reconnection, auth provider) and the server-side web-standard transport for a hermetic fixture, so no dependency changes are needed. FR-A3 fixes the credential boundary: client tokens are never forwarded; upstream credentials are the middleware's own.

## Decisions

### D1 — Transport selection: `run --http <url>` + config headers

`mcprelay run --http <url>` wraps a remote server; `run -- <server command…>` stays the stdio form, and the two are mutually exclusive (usage error). The config gains `upstream.http.headers` (strict keys, string values), sent on every upstream request via `requestInit`. These are the middleware's own upstream credentials — never the client's tokens (FR-A3); OAuth/JWT/identities are M9. Rejected: URL in config only (the client-config one-liner must name the URL) and headers as CLI flags (shell history / process list exposure).

### D2 — One link abstraction, two transports

The bridge depends on `UpstreamLink` (`kind`, `connected`, `connect`, `relayNotifications`, `setCloseRelay`, `sendBatch`, `setBatchRelay`, `close`) instead of the stdio class. `StdioUpstreamLink` wraps the existing `UpstreamTransport`; `HttpUpstreamLink` wraps `StreamableHTTPClientTransport` and wraps `onmessage` after `connect` so upstream notifications (except `notifications/progress`, re-emitted by the pipeline with the client's token) still relay verbatim. `BridgeOptions` takes an `UpstreamTarget` union. Rejected: a class hierarchy or per-transport branches inside the bridge (two same-file classes behind one interface keep the bridge linear).

### D3 — Records carry the transport (in-place migration)

`FailureRecord.server` is `{ name, command, transport }`; for HTTP, `command` holds the endpoint URL (display + reconnect target). SQLite adds `server_transport TEXT NOT NULL DEFAULT 'stdio'` through the existing `ensureColumn` guard, so pre-M6 databases migrate on open and old rows read `stdio`. The PRD Appendix A is updated (rule 1).

### D4 — Replay reconnects over the recorded transport

`connectStoredServer(record, config)` branches: stdio parses the stored command (unchanged); HTTP builds `StreamableHTTPClientTransport(new URL(record.server.command), { requestInit: { headers: config.upstream.http.headers } })`. The record stores the URL only — credentials are never persisted (NFR-4) and replay uses the current config's headers. Dry-run keeps its zero-`tools/call` guarantee over both transports.

### D5 — Classification stays the D4 taxonomy

`failurePhase` gains an HTTP-aware branch: a fetch-level `TypeError` (network/connect failure) is pre-send (retryable unconditionally); `SdkError` codes map as before; `SdkHttpError` (any HTTP status response, i.e. the request reached the server) is post-send, and `classifyAttempt` treats it as `transport_post_execution` — retryable only for `idempotent: true` — except 401/403, which are non-retryable. Timeouts stay idempotent-gated. The SDK transport's internal 404-session reconnection is transport-internal and invisible to the pipeline. Rejected: treating all HTTP errors as retryable (duplicate side effects) and adding a second classifier for HTTP.

### D6 — Batch frames are stdio-only

The client-facing transport still demuxes batch arrays; with an HTTP upstream the middleware answers the batch with one JSON-RPC error (`-32600`, `id: null`) instead of forwarding. The 2026-07-28 revision has no batching; the stdio verbatim relay exists for legacy clients only. Documented in the README.

### D7 — Hermetic fixture on the SDK server transport

`examples/http-echo-server/` bridges `node:http` to the SDK's web-standard streamable HTTP handler (tools `echo`, `boom`, `rpc-error`, `sleep`, `http-error`; `x/stats` for counters/headers). Rejected: hand-rolling the wire (session ids, SSE framing, content negotiation) — the fixture must exercise the same machinery real servers run.

### D8 — Credential boundary (FR-A3)

Upstream requests carry only `upstream.http.headers` plus transport-managed headers; client-supplied values are never mapped to upstream headers, and configured header values are never logged or persisted (a test reads the raw DB and WAL files). No client-token passthrough exists by construction, and M9 adds the validation/identity layer at the edge.

## Consequences

- The pipeline is transport-agnostic: policy, retry, DLQ, replay, logs, and session mirroring behave identically over stdio and HTTP, and the existing stdio suite is untouched.
- Pre-M6 records and configs keep working (transport defaults to `stdio`; the new section is optional).
- The boundaries are explicit: no client-token passthrough, no batch frames over HTTP, auth/identities in M9.
- The fixture runs the full HTTP suite hermetically in CI; a public endpoint remains an optional real-world check.

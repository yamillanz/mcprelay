# ADR-0010 — Caller identity resolution and the no-passthrough boundary

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-10-08 |
| **Milestone** | M9 `auth-identities` |
| **PRD refs** | FR-A1, FR-A3, §5.1, §6.1, §12 |

## Context

Through M8 the caller was hardcoded: the bridge logged `{type: 'stdio', identity: 'local'}`, evaluated policy with `caller: 'local'`, and persisted the same placeholder into call events, `report` attribution, and `FailureRecord.caller`. FR-A1 asks for static API keys mapped to caller identities (header-based for HTTP transports; profile-named for stdio) and FR-A3 forbids token passthrough. §5.1 fixes the boundary: the MCP spec defines transport authorization for HTTP only and says stdio SHOULD use environment/OS trust; v1 has no client-facing HTTP transport (1:1 stdio wrap), and FR-A2 (JWT/mTLS/OAuth resource server) is explicitly post-M9. M6 already kept configured upstream headers credential-free, but a client credential in `_meta` would still travel in the forwarded body.

## Decisions

### D1 — Two identity sources: profile and key store

`identity.profile` names the caller for the stdio wrap (default `local`); `identity.keys` maps static API keys to identities; `run --identity <name>` overrides the profile (CLI beats file). Resolution per call: read the standard credential shape from `_meta.authorization` (`Bearer <key>`, case-insensitive scheme); with a non-empty key store, a match resolves to its mapped identity and a non-match is rejected (D2); otherwise the profile applies. Rejected: requiring a credential when keys are configured (breaks zero-config clients and the M6 credential test); env-var identities (a 1:1 wrap has one client — the profile is the honest stdio answer); a custom `_meta.mcprelay.apiKey` scheme (adopt the standard Authorization shape instead; the same resolver reads it from headers when a client-facing HTTP edge lands post-v1).

### D2 — Rejection semantics and the error code

An unrecognized credential with a configured key store is a **denial**: standard MCP error, `denied` audit with `detail: { action: 'auth' }`, `denied` log line with the reserved caller `unauthenticated`, never forwarded, never in the DLQ. The code is **`-32003`**, not the initially drafted `-32002`: the SDK reserves `-32002` as `ResourceNotFound` and rewrites a handler-thrown `-32002` to `-32602` at the era encode seam ("the SDK never EMITS `-32002`" — verified against `@modelcontextprotocol/server` during implementation, and the spec/design were corrected). `-32001` stays the policy denial; `-32003` is the auth rejection.

### D3 — Strip before relay; never persist

`prepareCallMetadata` removes credential fields (case-insensitive `authorization`) from the `_meta` it builds for the relay, so credentials cannot reach a stdio upstream's stdin or an HTTP upstream's body; every other `_meta` key (correlation, OTel trace context, progress tokens) survives unchanged. Upstream HTTP headers remain `upstream.http.headers` only. Credentials are never written to logs, call events, audit entries, or FailureRecords. The HTTP fixture's `x/stats` gained `lastParams` so the body-level guarantee is provable, not just the header-level one (the M6 test).

### D4 — Identity feeds policy, logs, events, and records

The bridge resolves once per intercepted call, before policy, and threads the identity into `evaluateCall({ caller })`, the log entry, `captureFailure`, and (through the log entry) call events — so policy `caller` rules, `report` attribution, and `FailureRecord.caller` all carry real identities. The caller `type` stays `stdio` for v1; a future HTTP edge adds `http` without schema changes. Module shape: `src/identity/identity.ts` holds the pure resolver and the strip helper (unit-testable, no I/O, one call per intercepted call — no hot-path cost).

## Consequences

- **Positive:** policy caller rules and `report` attribution are real; rejected credentials are visible and attributable (`unauthenticated`); FR-A3 is enforced and tested at the body level; zero-config behavior is byte-identical (default `local`).
- **Negative / accepted:** profile identity is per-process, not per-request (correct for 1:1 stdio); rejection is active only when a key store is configured (documented); FR-A2 (JWT/JWKS/mTLS, OAuth resource server) remains post-M9; the resolver's HTTP edge is designed but not built.

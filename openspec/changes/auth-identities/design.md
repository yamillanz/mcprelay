## Context

The caller placeholder (`{type: 'stdio', identity: 'local'}`) is hardcoded at four sites in the bridge (log entry, policy evaluation, capture, call events) and flows into `report` attribution, so FR-A1's caller dimension is inert. §5.1 draws the boundary: MCP defines transport authorization for HTTP only and says stdio SHOULD use the environment/OS trust; execution-layer identity is ours. FR-A3 forbids token passthrough and M6 already keeps configured upstream headers credential-free — but a credential in `_meta` would still travel in the forwarded body, so the passthrough edge needs closing. v1 is a 1:1 stdio wrap: one client per middleware process, no client-facing HTTP transport (the resolver is shaped so a future HTTP edge reads the same `Authorization` credential from headers). FR-A2 (JWT/mTLS/OAuth resource server) is explicitly post-M9.

## Goals / Non-Goals

**Goals:**

- A real caller identity per intercepted call: config `identity.profile` (default `local`) and `identity.keys` (static API keys → identities), with `run --identity <name>` overriding the profile.
- Credential validation at the edge when a key store is configured: match → mapped identity; mismatch → rejected before the upstream (`-32003`, `denied` audit, `denied` log, never forwarded, never in the DLQ).
- Identity feeds policy (`caller` matcher), the FR-O1 log line, call events (`report` attribution), and `FailureRecord.caller`.
- FR-A3 enforced end to end: credentials stripped from `_meta` before any upstream relay (stdio and HTTP), never logged, never persisted; upstream credentials stay `upstream.http.headers` only.

**Non-Goals:**

- FR-A2: JWT/JWKS, mTLS, OAuth 2.1 resource-server behavior (post-M9 stretch).
- A client-facing HTTP transport (post-v1); no custom identity scheme beyond the standard `Authorization`/Bearer shape.
- Per-tool or per-server identities, identity rotation, revocation lists, or multi-tenant caller stores.
- Changing `policy test --caller` (already accepts a caller) or the `report` schema (the caller column already exists).

## Decisions

### D1 — Config surface and resolution order

```yaml
identity:
  profile: reviewer-bot        # name for this stdio wrap; default: local
  keys:                        # static API keys mapped to identities (FR-A1)
    - { key: sk-agent-a, identity: agent-a }
```

Strict keys (`profile`, `keys`; entries `{key, identity}` with non-empty strings); duplicate `key` values are an error (ambiguous mapping), duplicate identities are fine; an empty `keys` list means "no key store". Key values SHALL NOT appear in error messages or `validate` output (NFR-4). `run --identity <name>` overrides `profile` (CLI beats file, FR-C1). Resolution per call:

1. Read the standard credential shape from `_meta.authorization` (`Bearer <key>`, case-insensitive scheme).
2. If a credential is present and the key store is non-empty: match against the store (constant-time compare) → mapped identity; no match → **reject** (D2).
3. Otherwise → `identity.profile` (default `local`).

Rejected: requiring a credential when keys are configured (breaks zero-config clients and the M6 credential test); per-call identities via env vars (1:1 wrap has one client — the profile is the honest stdio answer per §5.1); inventing a `_meta.mcprelay.apiKey` scheme (adopt the standard Authorization shape instead).

### D2 — Validation at the edge: rejection semantics

With a key store configured, an unrecognized credential is a **denial**, not a fallback: the call returns a standard MCP error `-32003` (`authentication failed: unrecognized api key`, never echoing the token) — note `-32002` is reserved by the SDK as `ResourceNotFound` and a handler-thrown `-32002` is rewritten to `-32602` at the era encode seam, writes a `denied` audit entry with `detail: { action: 'auth' }`, logs decision `denied`, is never forwarded, and never enters the DLQ (an auth rejection is not a failure — same discipline as policy denials, FR-Y4). The log/audit caller for a rejected call is the reserved identity `unauthenticated`, so rejected traffic is visible in `report` without polluting a real identity. With **no** key store configured, a presented credential is not accepted as identity (profile applies) and is stripped — existing clients that attach unrelated `authorization` in `_meta` keep working (the M6 test is the guard).

### D3 — FR-A3: strip before relay, never persist

`prepareCallMetadata` removes the credential field from the `_meta` it builds for the relay (case-insensitive `authorization` match; all other `_meta` keys, including OTel trace fields and `mcprelay.correlation_id`, survive — FR-P2 fidelity for everything else). The credential therefore cannot reach a stdio upstream's stdin or an HTTP upstream's body; upstream HTTP headers remain `upstream.http.headers` only (M6). Credentials are never written to logs, call events, audit entries, or FailureRecords. The HTTP fixture's `x/stats` gains `lastParams` so the body-level guarantee is provable, not just the header-level one.

### D4 — Identity feeds policy, logs, events, and records

The bridge resolves the identity before policy evaluation and passes it to `evaluateCall({ caller })` (policy rules with `caller` finally match real identities), to `buildCallLogEntry` (the `caller` field), to `captureFailure` (FailureRecord), and through `logCall` into call events (report attribution). `CallLogFields` gains a `caller` field; the hardcoded `{type:'stdio', identity:'local'}` disappears from the bridge. The caller `type` stays `stdio` for v1 (the client transport); a future HTTP edge adds `http` without schema changes (the columns already exist).

### D5 — Module shape and hot path

`src/identity/identity.ts` holds the pure logic — `resolveIdentity(settings, meta)` returning `{ok:true, identity} | {ok:false, reason}` and `stripCredentialFields(params)` — with no I/O, so it is unit-testable without a session and reusable by a future HTTP edge. The bridge calls it once per intercepted call (string work on one object), adds no per-frame work, and stays linear. Rejected: helpers inside `bridge.ts` (the file is 740+ lines; a capability boundary with its own unit tests is the measured reason) and a class-based resolver (no state to hold).

### D6 — Testing and evidence

Unit tests pin Bearer parsing, match/mismatch/empty-store/profile fallback, and stripping that preserves other `_meta` keys. Config tests cover defaults, overrides, malformed entries, duplicate keys, and that key values never appear in error text. Session tests (stdio, via `echo-meta`): profile identity in log/event/FailureRecord, policy `caller` matching, keyed identity mapping, unknown key → `-32003` + `denied` audit + zero upstream calls + no DLQ, and the credential absent from the echoed `_meta`. HTTP upstream test: `x/stats.lastParams` carries no credential while configured headers do. Real-server evidence: a filesystem/echo session with a profile identity, a keyed call, and a rejected key, then `report` grouped per identity.

### D7 — Docs and diagram

ADR-0010 records the resolution order, rejection semantics, the passthrough boundary, and the rejected alternatives (credential-required mode, env-var identities, custom `_meta` scheme). README gains the `identity` section; the living diagram marks identity on the client edge; the PRD gets a document-history entry (FR-A1/A3 implemented; FR-A2 still post-M9); AGENTS status moves to M9 → next M10.

## Risks / Trade-offs

- **Rejecting credentials when a key store is configured may surprise clients** → documented, only active when `identity.keys` is non-empty, error names the reason without the token; zero-config behavior unchanged.
- **Stripping `_meta.authorization` is deliberate interception** → allowed by FR-P2's exception list and FR-A3; tests assert all other `_meta` keys survive.
- **Profile identity is per-process, not per-request** → correct for the 1:1 stdio model (§6.1); the resolver shape keeps the future HTTP edge (per-request headers) additive.
- **Constant-time compare for local static keys** → cheap (`crypto.timingSafeEqual`) and avoids teaching a bad habit; not a security boundary claim.
- **NFR-3 budget** → one resolution and one shallow copy per intercepted call; measured later by `bench/`.

## Migration Plan

No breaking change: default profile `local` and an empty key store preserve today's behavior exactly. Rollback is a revert; identities live in config only.

## Open Questions

(none)

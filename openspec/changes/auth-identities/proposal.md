## Why

Every call should have a caller (FR-A1, §5.1). Today the caller is hardcoded: the bridge logs `{type: 'stdio', identity: 'local'}`, evaluates policy with `caller: 'local'`, and persists that same placeholder into call events, `report` attribution, and `FailureRecord.caller` — so caller rules can never match anyone but `local`, and the report has exactly one bucket. FR-A3 is also only half-enforced: M6 proves configured upstream headers never carry client credentials, but a credential a client attaches in `_meta` would still travel upstream in the forwarded body. M9 gives identities a real source and closes the passthrough edge.

## What Changes

- **Identity resolution** (FR-A1): a new `identity` config section — `profile` (the name for this stdio wrap, default `local`) and `keys` (static API keys mapped to identities) — plus `run --identity <name>` to override the profile. Per call: a credential presented in `_meta.authorization` (`Bearer <key>`) is validated against the key store when one is configured and resolves to its identity; no credential (or no key store) resolves to the profile; the default stays `local`, so zero-config behavior is unchanged.
- **Validated at the edge** (FR-A3): when a key store is configured and the presented credential does not match, the call is rejected before the upstream — a standard MCP error (`-32003`), a `denied` audit entry, and a `denied` log line, never forwarded and never captured in the DLQ. When no key store is configured, presented credentials are not accepted as identity (profile applies) but are still stripped.
- **No credential passthrough** (FR-A3): credential material is removed from `_meta` before any upstream relay (stdio and HTTP), never logged, never persisted; upstream connections keep using the middleware's own `upstream.http.headers` (M6), and the spec-forbidden passthrough is now tested against the upstream **body**, not just headers.
- **Identity feeds everything**: the resolved identity replaces the placeholder in the FR-O1 log line, call events (so `report` attributes per caller), `FailureRecord.caller`, and policy evaluation — rules with `caller` finally match the resolved caller.
- **Out of scope**: FR-A2 (JWT/mTLS/OAuth 2.1 resource server) stays a post-M9 stretch, and no client-facing HTTP transport is added; the resolver is shaped so a future HTTP edge reads the same `Authorization` credential from headers (documented in ADR-0010).
- ADR-0010 (resolution order, key validation, passthrough boundary, rejected alternatives); README (identity section); PRD history; living diagram (identity on the client edge); AGENTS status.

## Capabilities

### New Capabilities

- `identity`: caller identity resolution for v1 — profile-named identities for stdio, static API keys mapped to identities, validation at the edge, and the no-passthrough rule for client credentials.

### Modified Capabilities

- `configuration`: the `identity` section (`profile`, `keys`) with strict parsing, defaults, and secrets never echoed.
- `observability`: the caller field in the structured log line carries the resolved identity instead of the placeholder.

## Impact

- **Code**: new `src/identity/identity.ts` (resolution + credential stripping); `src/config/config.ts` (identity section); `src/proxy/bridge.ts` (resolve before policy, strip before relay, feed log/records); `src/cli/run.ts` (`--identity` flag + HELP); `examples/http-echo-server` (`x/stats` gains `lastParams` so body stripping is provable).
- **Tests**: identity unit tests, config parsing, stdio session (profile + keyed + rejected via `echo-meta`), HTTP upstream body-stripping via `x/stats`, policy caller matching, `report` attribution per identity.
- **Docs**: ADR-0010, README, PRD history, architecture diagram; no new dependencies; no breaking change (default `local` preserves existing behavior).

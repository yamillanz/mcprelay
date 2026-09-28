## Context

`src/proxy/bridge.ts` works and is fully tested (46 tests), but its entry point `startBridge` is a ~200-line body containing nested helpers (`createServer`, `relayRequest`) and two inline handlers (`tools/call`, fallback). The maintainer cannot read the startup algorithm without jumping through nested scopes. `src/proxy/transports.ts` was praised as the readability reference: small top-level functions, one job each.

Constraints:

- **No behavior change** — the suite (CLI, echo server, proxy matrix, call logs) is the safety net and must pass with unchanged assertions.
- **No performance tax** — helpers stay in the same file (no new module/import boundary, no class instantiation, no extra per-call allocations or I/O).
- **Invariants to preserve**: `serveStdio` calls the factory per opening and discards probe instances, so the factory must return a fresh `Server` each call; the pinned instance is the one whose push APIs relay server→client requests.

## Goals / Non-Goals

**Goals**

- `startBridge` reads as the startup algorithm: one named call per phase, in execution order.
- Every nested helper becomes a top-level, descriptively named function in the same file.
- `tools/call` phases (metadata/correlation, relay, log entry) are named helpers.
- The Spanish mirror `docs/code-tours/bridge.md` reflects the new structure.
- The readability/performance balance becomes a written convention in `AGENTS.md` + `openspec/project.md`.

**Non-Goals**

- No behavior, log-format, protocol, CLI, or exit-code changes.
- No new modules, classes, dependency injection framework, or abstractions beyond named functions.
- No performance optimization work; only "do not add overhead".
- No architecture/flow/component change (the architecture diagram stays as-is).

## Decisions

### D1 — Same-file named functions, closures kept

Extraction stays in `src/proxy/bridge.ts` as top-level `function` declarations (hoisted, cheap). Shared state that is genuinely per-session (`session`, `pinnedServer`, `closed`) stays in `startBridge`'s closure and is passed explicitly to the helpers that need it. Rejected: splitting into new modules (import indirection, more files) and a `Bridge` class (heavier, changes instantiation and `this` semantics).

### D2 — Function map

| Helper (new top-level function) | Replaces |
|---|---|
| `createCloseSignal()` → `{ closed, resolveClosed }` | inline promise in `startBridge` |
| `createUpstreamTransport(options)` | inline `new UpstreamTransport` |
| `createClientTransport(options)` | inline `new ClientTransport` + option plumbing |
| `relayBatchFrames(clientTransport, upstreamTransport)` | the two `onBatch` hooks |
| `createUpstreamClient(options)` | inline `new Client` with capabilities |
| `registerServerToClientRequestRelays(upstream, getPinnedServer)` | the three `setRequestHandler` calls |
| `relayClientNotifications(clientTransport, upstream, upstreamTransport, stderr)` | client→upstream notification hook |
| `relayUpstreamNotifications(upstreamTransport, clientTransport)` | upstream→client notification hook |
| `wireCloseSignals(clientTransport, upstreamTransport, resolveClosed)` | the two `onclose` hooks |
| `connectUpstream(upstream, upstreamTransport)` + `captureSessionContext(upstream, fallbackServer)` | connect + `createSessionContext` |
| `createClientServerFactory({ session, upstream, logger, pinned })` → `{ createServer, getPinnedServer }` | the `createServer` closure + `pinnedServer` |
| `createRelayRequest(server, upstream)` | nested `relayRequest` |
| `prepareCallMetadata(params)` → `{ params, correlationId, progressToken, trace }` | `tools/call` preamble |
| `buildCallLogEntry(...)` | both inline `logger.log({...})` calls |
| `interceptToolCall(server, upstream, session, logger, request)` | the `tools/call` handler body |
| `relayPassthroughRequest(...)` | the fallback handler body |

Naming rule: a helper name states **what it does**, not how (`createUpstreamTransport`, not `makeUT`). Names in English, per repo convention.

### D3 — Target shape of `startBridge`

```ts
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const { closed, resolveClosed } = createCloseSignal();
  const upstreamTransport = createUpstreamTransport(options);
  const clientTransport = createClientTransport(options);

  relayBatchFrames(clientTransport, upstreamTransport);

  const upstream = createUpstreamClient(options);
  const pinned = createPinnedServerRef();
  registerServerToClientRequestRelays(upstream, pinned);
  relayClientNotifications(clientTransport, upstream, upstreamTransport, options.stderr);
  relayUpstreamNotifications(upstreamTransport, clientTransport);
  wireCloseSignals(clientTransport, upstreamTransport, resolveClosed);

  await connectUpstream(upstream, upstreamTransport);
  const session = captureSessionContext(upstream, { name: 'mcprelay', version: options.version });

  const handle = serveStdio(createClientServerFactory({ session, upstream, logger: options.logger, pinned }), {
    transport: clientTransport,
    onerror: (error: Error) => options.stderr(`mcprelay: ${error.message}\n`),
  });

  chainClientClose(clientTransport, resolveClosed); // serveStdio owns onclose; chain ours after

  return {
    closed,
    close: () => closeBridge({ upstreamTransport, upstream, handle, clientTransport }),
  };
}
```

The body reads top-to-bottom as the startup story; each line names its phase. The ordering comments currently inline move into the helper bodies or become one-line comments at the call site only where the order is non-obvious (e.g., "upstream first, so the client-facing server can mirror capabilities").

### D4 — Pinned-server reference

`pinnedServer` becomes a tiny same-file holder (`createPinnedServerRef()` returning `{ current?: Server }`) passed to both `registerServerToClientRequestRelays` and the server factory. This removes the mutable `let` from `startBridge` and makes the shared-state dependency explicit, with zero runtime cost beyond one object per session.

### D5 — Hot path

`interceptToolCall` keeps the exact operations and allocations as today: one `randomUUID`, one metadata spread, one `_meta.mcprelay` object, one trace object, one log entry. The only structural change is that the log entry is built by `buildCallLogEntry` (a pure function) instead of an inline literal. No added serialization, I/O, or closure-per-call.

### D6 — Documentation and governance

- `docs/code-tours/bridge.md` is regenerated block-by-block to match the new layout (blocks become the named functions and the new `startBridge`).
- `AGENTS.md` gains a convention: *"Readability first in the main algorithm: entry points read as named steps; helpers are same-file and descriptively named by default; performance is measured (NFR-3), not assumed — no micro-optimization, no cross-module indirection without a measured reason."* Mirrored in `openspec/project.md` (Conventions/Method).

## Risks / Trade-offs

- **Subtle behavior change while moving code** → the 46-test suite runs after every extraction step; the real-server check is repeated at the end (rule 10).
- **The fresh-instance factory invariant could be lost in extraction** → keep the factory returning a new `Server` per call and assert it via the existing session tests; the mirror documents why.
- **Readability rule could be read as an excuse for extra abstraction** → the convention explicitly forbids new modules/classes without a measured reason; this change adds functions only.
- **Helper count grows the file's top level** → accepted: top-level functions are easy to scan; the entry point is what matters most.

## Migration Plan

N/A — internal refactor, no data or API migration.

## Open Questions

(none)

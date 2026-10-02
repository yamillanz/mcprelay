# Tasks — `http-transport`

Test-first (rule 11): every implementation group starts with its failing tests. Scenario → test traceability: "Streamable HTTP upstream wrapping" / "The pipeline is transport-agnostic" / "Batch-frame boundary over HTTP" / "Upstream credential boundary" → `tests/http-upstream.test.ts`; "HTTP records carry their transport" / "Legacy records migrate in place" → `tests/queue.test.ts`; "HTTP dry-run reconnects over HTTP" / "HTTP record re-executes over HTTP" → `tests/replay-run.test.ts`; configuration scenarios → `tests/config.test.ts` + `tests/cli.test.ts`.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session** (approved 2026-09-30)

## 1. Baseline and hermetic fixture

- [ ] 1.1 Run the full gate on the current code and record the baseline here: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` (expect 248/248)
- [ ] 1.2 Add `examples/http-echo-server/` — `node:http` bridged to the SDK server package's streamable HTTP transport; tools `echo`, `boom` (`isError`), `rpc-error`, `sleep`; ephemeral port printed on stdout — and wire it into `tsconfig.examples.json`; smoke-verify with an SDK client (tools/list + echo) and record the output

## 2. HTTP upstream (tests first)

- [ ] 2.1 Write failing integration tests in `tests/http-upstream.test.ts`: session mirroring, `tools/list` unfiltered, `tools/call` passthrough, policy denial over HTTP (`-32001`, audit, no upstream call), failure capture with `transport: http`, batch frame answered with a JSON-RPC error, configured headers reach the upstream, client `_meta` credentials are not forwarded (red)
- [ ] 2.2 Implement the `UpstreamLink` abstraction (stdio link wrapping the existing transport; HTTP link wrapping `StreamableHTTPClientTransport`), the `UpstreamTarget` union in `BridgeOptions`, and `run --http <url>` wiring until green
- [ ] 2.3 Write failing classification tests (connection-refused retries; HTTP 500 does not auto-retry a non-idempotent tool; timeout retries only with `idempotent: true`), then extend `failurePhase` with the HTTP-aware mapping until green

## 3. Record transport and in-place migration (tests first)

- [ ] 3.1 Write failing queue tests: enqueue/read round-trip with `server.transport: http`; a pre-M6 database row reads `stdio` after the migration (red)
- [ ] 3.2 Implement `server.transport` in the record shape and the `server_transport` column migration until green

## 4. Replay over HTTP (tests first)

- [ ] 4.1 Write failing replay tests: `run` re-executes an HTTP record against the recorded endpoint, `--dry-run` lists tools over HTTP with zero `tools/call`, and no configured header value appears in the databases (red)
- [ ] 4.2 Implement the replay transport branch (record URL + current config headers) until green

## 5. Configuration and CLI (tests first)

- [ ] 5.1 Write failing config/CLI tests: `upstream.http.headers` parsed; malformed headers fail with path and field; `run --http <url>` accepted; `--http` + `-- <command>` is a usage error; zero-config unchanged (red)
- [ ] 5.2 Implement the `upstream` config section and the `run --http` flag until green

## 6. Docs, ADR, diagram, PRD

- [ ] 6.1 Write ADR-0007: transport selection, record field + migration, replay reconnection, classification mapping, batch boundary, credential boundary (FR-A3), and the rejected alternatives (config-only URL, CLI headers, hand-rolled HTTP fixture)
- [ ] 6.2 README: HTTP quickstart (`run --http`), headers, and the boundaries (no token passthrough, batch frames, auth lands with M9); update the AGENTS status line (M6 done → next M7)
- [ ] 6.3 PRD (rule 1): Appendix A gains `server.transport`; resolve D2 (Postgres → v1.1); document history v0.9
- [ ] 6.4 Living architecture diagram: upstream transport node covers stdio + HTTP, server node covers local + remote; validate + re-deliver the HTML (Archify, showcase) and visual-check

## 7. Verification and approval gates

- [ ] 7.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [ ] 7.2 Real-server evidence: filesystem (stdio) + the hermetic HTTP server under the same policy/DLQ config (deny → fail → DLQ → replay over HTTP); attempt one public remote endpoint and record reachability + result here
- [ ] 7.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [ ] 7.4 Human approval to archive (rule 0); archive the change after approval

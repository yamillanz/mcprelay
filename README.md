# mcprelay

**The reliability layer for MCP tool calls.** Middleware that wraps any stdio MCP server and adds policy, observability, and a dead-letter queue with replay around `tools/call`.

> **Status: M3 — durable DLQ capture.** `mcprelay run -- <server command…>` wraps any stdio MCP server, applies a per-call timeout with classified retries, and captures failed calls into a **dead-letter queue** — durably, redacted, before the client sees the error — where `mcprelay replay list|inspect` can examine them. Policy and replay execution land in later milestones — see [`docs/PRD.md`](docs/PRD.md) §12. Published on npm as [`@yamillanz/mcprelay`](https://www.npmjs.com/package/@yamillanz/mcprelay) (the bare `mcprelay` name is blocked by npm's name-similarity policy; the scoped fallback from PRD §11 applied). The first real release lands at M4.

## What works today

- **Wrap any stdio server** 1:1: `mcprelay run -- <server command…>` (also `mcprelay -- <server command…>`).
- **Protocol fidelity**: everything except `tools/call` passes through semantically unchanged — `tools/list`, `resources/*`, `prompts/*`, `completion/*`, `logging/setLevel`, server→client requests (`sampling/createMessage`, `elicitation/create`, `roots/list`), progress, custom methods, and JSON-RPC batch frames.
- **Timeout + classified retries**: each call has a configurable timeout; transient failures retry with exponential backoff, gated by the D4 taxonomy — timeouts and upstream errors retry only for tools marked `idempotent: true`, `isError` results never retry, protocol errors never retry, and client cancellation aborts without retrying.
- **Interception**: `tools/call` gets a generated correlation id (OTel `_meta` keys preserved), latency and payload sizes, and one JSON log line on stderr per call with the real attempt count.
- **Dead-letter queue**: a call that exhausts its retries (or fails non-retryably) is written to SQLite **before** the error is returned, with redacted arguments, a sha256 hash of the raw arguments, failure class, attempts, and correlation id; records survive restarts.
- **Inspection**: `mcprelay replay list [filters] [--json]` and `mcprelay replay inspect <id>` read the same database the middleware writes.
- **Validation**: `mcprelay validate` checks the configuration and reports precise path + field errors.
- **Process hygiene**: upstream stderr goes to stderr; an upstream crash surfaces as a standard JSON-RPC error and exit code `3`.

Exit codes: `0` success, `1` command failed (record not found, database error), `2` usage or configuration error, `3` upstream failure.

## Configuration

`./mcprelay.config.yaml` (or `--config <path>`) configures reliability; with no file, safe defaults apply (timeout 30 s, retries on, tools non-idempotent):

```yaml
reliability:
  timeout_ms: 30000
  retry:
    max_attempts: 3 # total attempts, including the first
    backoff: exponential
    base_ms: 250
    jitter: true
  per_tool:
    slow_tool: { timeout_ms: 120000, retry: { max_attempts: 1 } }
    create_issue: { idempotent: true } # timed-out calls retry only for idempotent tools
```

```yaml
queue:
  provider: sqlite
  sqlite: { path: ./.mcprelay/queue.db }
store:
  provider: sqlite
  sqlite: { path: ./.mcprelay/history.db }
redaction:
  patterns: [api_key, token, password, authorization, secret, credential]
reliability:
  per_tool:
    create_issue: { idempotent: true, capture_tool_errors: true } # isError results land in the DLQ too
```

CLI flags override file values: `--timeout-ms <ms>`, `--max-attempts <n>`. A malformed known section aborts startup with the config path and field; unknown top-level sections only warn.

## Inspecting the dead-letter queue

```sh
mcprelay replay list                      # all captured failures
mcprelay replay list --status pending --json
mcprelay replay inspect <id>              # full record, redacted arguments
```

The `replay` CLI and the middleware share the SQLite files (WAL + busy_timeout); `mcprelay replay` never starts an upstream server.

> **Install note:** `better-sqlite3` downloads a native binary via an install script. If your npm is configured with `ignore-scripts=true`, run `npm rebuild better-sqlite3 --ignore-scripts=false` once after installing.

## Try it

Requires Node.js ≥ 20.19.

```sh
npx @yamillanz/mcprelay run -- npx @modelcontextprotocol/server-filesystem .
```

The command installed is still `mcprelay` (the npm package is scoped). Or run it from a clone:

```sh
npm install
npm run build

node dist/cli/index.js run -- npx @modelcontextprotocol/server-filesystem .
```

A call through the proxy logs one line on stderr:

```json
{
  "timestamp": "2026-09-25T19:29:27.566Z",
  "correlation_id": "03022cd0-…",
  "caller": { "type": "stdio", "identity": "local" },
  "server": "secure-filesystem-server",
  "tool": "read_file",
  "decision": "allowed",
  "latency_ms": 3,
  "request_bytes": 166,
  "response_bytes": 2544,
  "attempt": 1
}
```

## Development

```sh
npm test              # vitest (CLI, proxy fidelity matrix, call logs)
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Spec-driven workflow lives in [`openspec/`](openspec/project.md); the product truth is [`docs/PRD.md`](docs/PRD.md); decisions are recorded in [`docs/adr/`](docs/adr/).

## License

MIT

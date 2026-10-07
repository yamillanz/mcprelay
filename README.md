# mcprelay

**The reliability layer for MCP tool calls.** Middleware that wraps any stdio MCP server and adds policy, observability, and a dead-letter queue with replay around `tools/call`.

> **Status: M7 — RabbitMQ + batch replay.** Wrap any stdio server **or a remote Streamable HTTP server** with the same pipeline: per-call timeouts and classified retries, declarative allow/deny policy (with dry-run), a durable, redacted dead-letter queue, and **replay as redrive for side effects** — now including **batch replay (`run --all`)** — with an idempotency guard against duplicates. The DLQ runs on SQLite by default or on a real **RabbitMQ** broker (`docker compose up` demo). Per-tool metrics land in a later milestone ([`docs/PRD.md`](docs/PRD.md) §12).
>
> Published on npm as [`@yamillanz/mcprelay`](https://www.npmjs.com/package/@yamillanz/mcprelay) (the bare `mcprelay` name is blocked by npm's name-similarity policy; scoped fallback per PRD §11 — the installed command is still `mcprelay`).

## Quickstart (client config)

Point your MCP client at `mcprelay` instead of the server — one line, no server changes. Claude Desktop / Cursor (`claude_desktop_config.json` / `mcp.json`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@yamillanz/mcprelay",
        "run",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/project"
      ]
    }
  }
}
```

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@yamillanz/mcprelay",
        "run",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/project"
      ]
    }
  }
}
```

Or from a terminal:

```sh
npx @yamillanz/mcprelay run -- npx @modelcontextprotocol/server-filesystem .
```

Requires Node.js ≥ 20.19.

### Remote HTTP servers

The client side stays stdio; the upstream can be a remote Streamable HTTP MCP server:

```sh
mcprelay run --http https://mcp.example.com/mcp
```

or from a client config:

```json
{
  "mcpServers": {
    "remote": {
      "command": "npx",
      "args": ["-y", "@yamillanz/mcprelay", "run", "--http", "https://mcp.example.com/mcp"]
    }
  }
}
```

Upstream credentials are the middleware's own — **client tokens are never forwarded upstream** (FR-A3). Configure them in `mcprelay.config.yaml`; values are never logged or persisted:

```yaml
upstream:
  http:
    headers:
      authorization: Bearer <your-token>
```

Policy, retries, DLQ capture, and replay work identically over HTTP, and records remember the transport so `replay` reconnects to the same endpoint. Two boundaries to know: **JSON-RPC batch frames are stdio-only** (the 2026-07-28 revision removed batching; over HTTP the middleware answers with a clear error), and OAuth/JWT identities land with M9.

## What works today

- **Wrap any stdio server 1:1** — `mcprelay run -- <server command…>` (also `mcprelay -- <server command…>`). The upstream runs unmodified and unaware.
- **Wrap a remote HTTP server** — `mcprelay run --http <url>` speaks Streamable HTTP to the upstream while the client side stays stdio. Same policy, retries, DLQ, replay, and logs; upstream headers come from `upstream.http.headers`.
- **Protocol fidelity** — everything except `tools/call` passes through semantically unchanged: `tools/list`, `resources/*`, `prompts/*`, `completion/*`, `logging/setLevel`, server→client requests (`sampling/createMessage`, `elicitation/create`, `roots/list`), progress, custom methods, and JSON-RPC batch frames.
- **Policy without surprises** — declarative allow/deny by tool (globs), caller identity, and argument matchers (`equals`, `in`, `prefix`, `regex`, `max_length`, numeric bounds), with most-specific-wins precedence. Denied calls get a standard MCP error (`-32001`), an audit entry, and a log line — and are never forwarded upstream or written to the DLQ. `tools/list` is never filtered. `--policy-dry-run` reports decisions without enforcing; `mcprelay policy test` evaluates a call (or a stored failure) before you enforce anything.
- **Timeout + classified retries** — per-call timeout; transient failures retry with exponential backoff, gated by the failure-class taxonomy: timeouts and upstream errors retry only for tools marked `idempotent: true`; `isError` and protocol errors never retry; client cancellation aborts without retrying.
- **Dead-letter queue** — a call that ultimately fails is written to the configured queue provider **before** the client sees the error, with redacted arguments, a sha256 hash of the raw arguments, failure class, attempts, and correlation id. Records survive restarts. SQLite is the zero-infra default; **RabbitMQ** (`queue.provider: rabbitmq`) publishes persistent, confirm-acknowledged captures to a durable `mcp.dlx`/`mcp.dlq` topology.
- **Replay as redrive** — `mcprelay replay run <id>` re-executes the stored call, and the replay's own (redacted) result or error is captured into the audit trail. `--dry-run` inspects with zero upstream `tools/call`.
- **Batch replay** — `mcprelay replay run --all` redrives every pending record matching the `list` filters, sequentially and concurrently safe through atomic claims, with per-record outcomes, a summary, and CI-meaningful exit codes.
- **Duplicate guard** — successful keyed calls are indexed; replay refuses a duplicate within `reliability.replay.dedup_window` unless `--force` is given.
- **Structured logs** — one JSON line per intercepted call on stderr with correlation id, latency, payload sizes, attempts, and decision.

## What replay means

A replayed call's response cannot go back to the agent that made it — that session is over. Replay is **redrive for side effects**: the call runs upstream, the side effect lands, and the (redacted) result or error is stored in the audit trail, which is the only place a replay's outcome can be inspected. Read-only tools are rarely worth replaying; mark them `effects: read` and `--dry-run` will say so.

Because secrets are never stored in the clear, replay refuses to run a record whose arguments contain `[REDACTED]` values. Supply them explicitly:

```sh
mcprelay replay run <id> --set api_key=…      # then the call runs with the real value
```

## Dead-letter queue

```sh
mcprelay replay list                          # captured failures (all statuses)
mcprelay replay list --status pending --json  # filters + machine-readable
mcprelay replay inspect <id>                  # full record (redacted arguments)
mcprelay replay run <id> --dry-run            # tool present? duplicate risk? zero side effects
mcprelay replay run <id>                      # re-execute; result captured in the audit trail
mcprelay replay run <id> --force              # allow a duplicate within the dedup window
mcprelay replay run --all                     # batch: redrive every pending record
mcprelay replay run --all --tool fs/write_file --since 2026-10-01T00:00:00Z
mcprelay replay run --all --dry-run           # inspect each record, zero side effects
```

The `replay` CLI and the middleware share the SQLite files (WAL + busy_timeout) and never start a server unless a replay actually runs.

### RabbitMQ provider

```yaml
queue:
  provider: rabbitmq
  rabbitmq: { url: amqp://localhost, exchange: mcp.dlx, queue: mcp.dlq }
  sqlite: { path: ./.mcprelay/queue.db } # local replay index (list/get/claim)
```

Captures are published persistently and confirmed before the client sees the error; the broker holds the immutable capture. The replay CLI reads the **local index**, so filters, atomic resolve, claims, and dedup behave exactly as with SQLite — and if the broker is unreachable the capture still lands locally with a visible warning. Nothing is lost; a broker outage degrades, it never drops records.

One-command demo — RabbitMQ + middleware + example server, ending on a successful replay:

```sh
docker compose up --build     # fail → DLQ (visible in mcp.dlq) → replay → "demo: OK"
```

## Policy

Policy is declarative YAML, evaluated before the retry pipeline. The **most specific matching rule wins** — exact tool name beats a glob, plus one point each for a `caller` and for every argument matcher; ties go to the first rule in the file:

```yaml
policy:
  default: allow
  rules:
    - { tool: 'fs/delete_*', action: deny }
    - tool: read_file
      args: { path: { prefix: /projects } }
      action: allow
    - tool: deploy
      caller: ci-bot
      action: deny
```

Argument matchers: `equals`, `in`, `prefix`, `regex`, `max_length`, and numeric `min`/`max`, addressed by dot path (`config.timeout`, `items.0.name`); a missing argument never matches. Regex patterns are length-capped and reject nested quantifiers (ReDoS-bounded), and matched input is capped at 4096 characters.

Inspect before enforcing:

```sh
mcprelay policy test --tool read_file --args '{"path":"/etc/passwd"}'  # decision + matched rule
mcprelay policy test --id <failure-id> --json                          # a stored call, machine-readable
mcprelay run --policy-dry-run -- <server command…>                     # log would-be denials, enforce nothing
```

A denied call returns a JSON-RPC error (`-32001`) to the client, writes a `denied` audit entry, and logs `decision: denied` with zero attempts — and is never forwarded upstream or captured in the DLQ (a denial is not a failure). With no `policy` section every tool is allowed and a startup warning says so.

## Configuration

`./mcprelay.config.yaml` (or `--config <path>`); with no file, safe defaults apply:

```yaml
reliability:
  timeout_ms: 30000
  retry:
    max_attempts: 3 # total attempts, including the first
    backoff: exponential
    base_ms: 250
    jitter: true
  replay:
    dedup_window: 24h # duplicate side-effect window for replay
  per_tool:
    slow_tool: { timeout_ms: 120000, retry: { max_attempts: 1 } }
    create_issue: { idempotent: true, capture_tool_errors: true }
    flaky_search: { effects: read }

queue:
  provider: sqlite # sqlite | rabbitmq
  sqlite: { path: ./.mcprelay/queue.db } # with rabbitmq: the local replay index
  rabbitmq: { url: amqp://localhost, exchange: mcp.dlx, queue: mcp.dlq }
store:
  provider: sqlite
  sqlite: { path: ./.mcprelay/history.db }
redaction:
  patterns: [api_key, token, password, authorization, secret, credential]
```

CLI flags override file values: `--timeout-ms <ms>`, `--max-attempts <n>`, `--policy-dry-run`. `mcprelay validate` checks the whole config and reports precise path + field errors. Malformed known sections abort startup; unknown top-level sections only warn.

**Exit codes:** `0` success · `1` command failed (record not found, refused, database error) · `2` usage or configuration error · `3` upstream failure.

**Install note:** `better-sqlite3` downloads a native binary via an install script. If your npm uses `ignore-scripts=true`, run `npm rebuild better-sqlite3 --ignore-scripts=false` once.

## `tools/list` is never filtered

Denied tools still appear in `tools/list` (nothing is hidden), and denial happens at call time with a visible error. Hiding tools would be an invisible behavior change — and it would break capability discovery for tools the agent may legitimately use with other arguments. This is deliberate and stays that way unless a future opt-in says otherwise.

## Development

```sh
npm install
npm test              # vitest: CLI, proxy fidelity, retry taxonomy, DLQ, replay
npm run typecheck
npm run lint
npm run format:check
npm run build
```

The RabbitMQ contract and broker suites skip with a notice unless a broker is reachable; run them against a local broker (CI does the same with a service container):

```sh
docker run -d --name mcprelay-rabbit -p 5672:5672 rabbitmq:4-alpine
# if the container exits on an .erlang.cookie eacces error, add --user rabbitmq
MCPRELAY_RABBITMQ_URL=amqp://localhost npx vitest run
```

Spec-driven workflow lives in [`openspec/`](openspec/project.md); the product truth is [`docs/PRD.md`](docs/PRD.md); decisions are recorded in [`docs/adr/`](docs/adr/) (0001 layout, 0002 stdio termination, 0003 failure taxonomy, 0004 DLQ persistence, 0005 replay semantics, 0006 policy engine, 0007 HTTP transport, 0008 RabbitMQ adapter); the interactive architecture diagram is [`docs/architecture/mcprelay.html`](docs/architecture/mcprelay.html).

## License

MIT

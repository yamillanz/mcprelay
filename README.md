# mcprelay

**The reliability layer for MCP tool calls.** Middleware that wraps any stdio MCP server and adds policy, observability, and a dead-letter queue with replay around `tools/call`.

> **Status: v1.0 — the first stable release.** Wrap any stdio server **or a remote Streamable HTTP server** with the same pipeline: per-call timeouts and classified retries, declarative allow/deny policy (with dry-run), a durable, redacted dead-letter queue, **replay as redrive for side effects** (including **batch replay**), an idempotency guard against duplicates, a **RabbitMQ-backed DLQ** beside the zero-infra SQLite default, **per-tool latency/error/caller metrics** persisted on every call and rendered by `mcprelay report`, and **caller identities** (config profile, static API keys, `--identity`) that feed policy and the report — with client credentials validated at the edge and never forwarded upstream. See [`docs/PRD.md`](docs/PRD.md) for the architecture and scope; post-v1 items (`bench/`, FR-A2 JWT/mTLS, more adapters) are tracked as follow-ups.
>
> Published on npm as [`@yamillanz/mcprelay`](https://www.npmjs.com/package/@yamillanz/mcprelay) (the bare `mcprelay` name is blocked by npm's name-similarity policy; scoped fallback per PRD §11 — the installed command is still `mcprelay`).

![mcprelay — the 60-second demo: a call fails, lands in the dead-letter queue, and the replay writes the file](https://raw.githubusercontent.com/yamillanz/mcprelay/main/docs/assets/demo.gif)

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
- **Metrics and `report`** — every intercepted call is persisted as a call event (decision, latency, payload sizes, attempts, caller) — the same data as its log line. `mcprelay report` renders per-tool latency p50/p95, error rate, and caller attribution for a time range, with `--json` for CI, bounded by `store.retention_days` (default 30 days).
- **Caller identities** — `identity.profile` (default `local`) names the caller of a stdio wrap; `identity.keys` maps static API keys to identities; `run --identity <name>` overrides the profile. Identities feed policy `caller` rules, logs, call events, and `report`. A client credential in `_meta.authorization` is validated at the edge (unrecognized → `-32003`, denied, never forwarded) and stripped from every relay.

## What replay means

A replayed call's response cannot go back to the agent that made it — that session is over. Replay is **redrive for side effects**: the call runs upstream, the side effect lands, and the (redacted) result or error is stored in the audit trail, which is the only place a replay's outcome can be inspected. Read-only tools are rarely worth replaying; mark them `effects: read` and `--dry-run` will say so.

Because secrets are never stored in the clear, replay refuses to run a record whose arguments contain `[REDACTED]` values. Supply them explicitly:

```sh
mcprelay replay run <id> --set api_key=…      # then the call runs with the real value
```

## How it compares

The MCP gateway space is crowded; the operational failure path is not. Scan date **2026-10-12** (star counts verified that day; links per row):

| Project                                                                      | Stack        | What it does                                        | Gap we exploit                                                            |
| ---------------------------------------------------------------------------- | ------------ | --------------------------------------------------- | ------------------------------------------------------------------------- |
| [`microsoft/mcp-gateway`](https://github.com/microsoft/mcp-gateway) (874★)   | .NET/TS, K8s | Enterprise reverse proxy, control plane, portal     | K8s/enterprise orchestration; not local-first; no DLQ/replay              |
| [`P4ST4S/mcp-audit`](https://github.com/P4ST4S/mcp-audit) (8★)               | Go           | Audit proxy: signed logs, redaction, allow/deny     | Audit-first; explicitly avoids retrying `tools/call`; no DLQ/replay       |
| [`rsh1k/mcp-gate`](https://github.com/rsh1k/mcp-gate) (3★)                   | Python       | Policy firewall, hash-chained audit                 | Security-first; no failure-capture/replay workflow                        |
| [`mcpgatehq/gateward`](https://github.com/mcpgatehq/gateward) (0★)           | Python       | Built-in security rules, stdio only                 | Fixed rules; no reliability layer                                         |
| [`kgeg401/mcp-guard`](https://github.com/kgeg401/mcp-guard) (0★)             | Go           | Policy, redaction, signed audit, `replay --id`      | Replay is audit-integrity oriented; no retry pipeline, no pluggable queue |
| [`JinBeiCN/mcp-gateway`](https://github.com/JinBeiCN/mcp-gateway) (0★)       | Go           | Auth, RBAC, rate limits, prompt-injection detection | Security-first; no DLQ                                                    |
| [`yogesh895/gate-mcp`](https://github.com/yogesh895/gate-mcp) (0★)           | Node         | Control plane + admin UI, multi-tenant              | Heavy enterprise scope; no DLQ/replay                                     |
| [`bentabol/mcp-retry`](https://github.com/bentabol/mcp-retry) (0★)           | Python       | Retry, idempotency dedup, circuit breaker           | Resilience only (no policy/audit/DLQ); not TypeScript                     |
| [`CK-Rajput/mcp-resilient`](https://github.com/CK-Rajput/mcp-resilient) (0★) | Python       | Retry/circuit-breaker decorator, fallback chains    | Library-level, client-side; no DLQ store/replay                           |

Commercial gateways (mcpgateway.com, mcptrail.com) cover similar ground as SaaS; "replay" elsewhere in the ecosystem mostly means record/replay for **tests** (nock/msw-style fixtures). The niche that is still empty: _operational_ dead-letter capture + inspection + replay of failed tool calls as the core of a product — TypeScript, local-first, pluggable real-MQ backends.

## Design decisions

The full set lives in [`docs/adr/`](docs/adr/) — every ADR records its rejected alternatives. The four that shape the product most:

- **[ADR-0004 — DLQ persistence](docs/adr/0004-dlq-persistence.md):** `better-sqlite3` (synchronous, WAL) as the zero-infra default; capture completes _before_ the client sees the error; secrets redacted, raw arguments hashed. Rejected: `node:sqlite` (would drop Node 20), `sqlite3`, `sql.js` (no real durability story).
- **[ADR-0005 — replay semantics](docs/adr/0005-replay-semantics.md):** replay is redrive for side effects — the result lands in the audit trail, and `[REDACTED]` arguments block execution until supplied via `--set`. Rejected: storing raw secrets (violates NFR-4) and silently sending redacted values upstream (executes a different call than the one that failed).
- **[ADR-0008 — RabbitMQ topology](docs/adr/0008-rabbitmq-adapter.md):** a durable `mcp.dlx`/`mcp.dlq` exchange/queue holds the immutable capture with publisher confirms; the SQLite replay index serves queries. Rejected: peek-via-requeue (O(n) scans, ambiguous claim state, crash-window duplication) and publish-only event streams (no `list`/`get`).
- **[ADR-0010 — identity resolution](docs/adr/0010-identity-resolution.md):** profile identities for stdio, static API keys mapped to identities via the standard `_meta.authorization` Bearer shape; unrecognized credentials denied at the edge (`-32003`) and stripped from every relay. Rejected: requiring credentials (breaks zero-config), env-var identities, custom credential schemes.

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

## Report

Every intercepted call is persisted (decision, latency, payload sizes, attempts, caller) and `report` aggregates it per caller + tool:

```sh
mcprelay report                                   # last 24 hours
mcprelay report --since 2026-10-01T00:00:00Z --tool read_file
mcprelay report --json                            # CI-friendly document
```

```
window: 2026-10-06T12:00:00.000Z .. 2026-10-07T12:00:00.000Z
calls 12 · allowed 9 · denied 1 · failed 1 · cancelled 0 · replayed 1
CALLER  TOOL        CALLS  ERRORS  ERR%   P50   P95   AVG_REQ_B  AVG_RESP_B
local   read_file   7      1       14.3%  12ms  40ms  142        512
local   write_file  5      0       0.0%   9ms   22ms  98         64
```

`denied`/`failed`/`cancelled` come from the call events, `replayed` from the audit trail. Call events are pruned on store open according to `store.retention_days` (default 30 days; `0` keeps everything) — the DLQ and the audit trail are never pruned.

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
identity:
  profile: local # caller identity for this stdio wrap
  keys: # static API keys -> identities (optional)
    - { key: sk-agent-a, identity: agent-a }
store:
  provider: sqlite
  sqlite: { path: ./.mcprelay/history.db }
  retention_days: 30 # call events kept; 0 disables pruning (audit/DLQ untouched)
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

Spec-driven workflow lives in [`openspec/`](openspec/project.md); the product truth is [`docs/PRD.md`](docs/PRD.md); decisions are recorded in [`docs/adr/`](docs/adr/) (0001 layout, 0002 stdio termination, 0003 failure taxonomy, 0004 DLQ persistence, 0005 replay semantics, 0006 policy engine, 0007 HTTP transport, 0008 RabbitMQ adapter, 0009 metrics, 0010 identity); the interactive architecture diagram is [`docs/architecture/mcprelay.html`](docs/architecture/mcprelay.html).

## License

MIT

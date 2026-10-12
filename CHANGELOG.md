# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-12

The first stable release: the reliability layer for MCP tool calls.

### Added

- **Transparent proxy** — wrap any stdio MCP server 1:1 (`mcprelay run -- <server>`); everything except `tools/call` passes through semantically unchanged, and `tools/list` is never filtered.
- **Remote HTTP upstreams** — the same pipeline over Streamable HTTP (`run --http <url>`), with configured upstream headers and transport-aware replay.
- **Classified retries** — per-call timeouts and exponential backoff gated by a failure-class taxonomy: timeouts and upstream errors retry only for `idempotent: true` tools; `isError` never auto-retries; cancellation aborts cleanly.
- **Dead-letter queue with replay** — failures are captured durably (redacted arguments, raw-args hash, failure class, attempts, correlation id) _before_ the client sees the error. `replay list|inspect|run` redrives for side effects, with `--dry-run`, `--set` for redacted values, batch replay (`--all`) with atomic claims, and an idempotency dedup guard.
- **Pluggable queue** — zero-infra SQLite by default; RabbitMQ (`mcp.dlx`/`mcp.dlq`, publisher confirms) as the second `QueueProvider` adapter.
- **Policy engine** — declarative allow/deny per tool, caller, and argument matchers (`equals`, `in`, `prefix`, `regex`, `max_length`, numeric bounds), most-specific-wins, `--policy-dry-run`, `policy test`.
- **Observability** — one structured JSON log line per intercepted call; per-tool latency/error/caller metrics persisted per call and rendered by `mcprelay report` (table + `--json`), with retention.
- **Caller identities** — `identity.profile`, static API keys mapped to identities, `run --identity`; credentials validated at the edge (`-32003` on unrecognized keys) and stripped from every relay.
- **Documented examples** — public-server recipes for filesystem, memory, and everything; the §1 demo runs end-to-end via `npm run demo` and is recorded as the README GIF.

### Notes

- Node.js ≥ 20, TypeScript strict, official MCP TypeScript SDK (spec revision 2026-07-28). OSS-only dependency set; no SaaS or vendor services anywhere.
- npm package: `@yamillanz/mcprelay` (the bare `mcprelay` name is blocked by npm's name-similarity policy); the installed command is `mcprelay`.

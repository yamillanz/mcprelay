# mcprelay

**The reliability layer for MCP tool calls.** Middleware that wraps any stdio MCP server and adds policy, observability, and a dead-letter queue with replay around `tools/call`.

> **Status: M0 scaffold — not usable yet.** The CLI currently answers `version` and `help` only. The proxy, retry pipeline, DLQ, and replay land in later milestones — see [`docs/PRD.md`](docs/PRD.md) §12.

## What it will do

- **Wrap** one stdio MCP server transparently: `npx mcprelay -- npx @modelcontextprotocol/server-filesystem .`
- **Policy** — allow/deny per tool and per argument, with `--dry-run`.
- **Reliability** — timeouts, retry with backoff, and a **dead-letter queue with replay** for failed tool calls; SQLite by default, RabbitMQ opt-in via the `QueueProvider` port.
- **Observability** — structured logs and per-tool metrics via `mcprelay report`.

## Development

Requires Node.js ≥ 20.19.

```sh
npm install
npm test              # vitest
npm run typecheck
npm run lint
npm run format:check
npm run build
node dist/cli/index.js --version
```

Spec-driven workflow lives in [`openspec/`](openspec/project.md); the product truth is [`docs/PRD.md`](docs/PRD.md).

## License

MIT

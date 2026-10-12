# Why your agent's tool calls need a dead-letter queue

*A launch post draft for r/MCP, the MCP Discord, and the repo's release announcement.*

---

Every team putting an MCP server in front of an agent writes the same code twice: once for the happy path, and once — badly — for what happens when a tool call dies.

It's not a hypothetical. Tool calls fail the way every networked call fails: upstream timeouts, process crashes mid-request, transient errors behind a flaky API. When they do, the agent gets an error it can't act on, your logs get a line nobody reads, and the side effect that *didn't* happen is now a question mark. Did the write land? Should you retry? Retrying might duplicate it. Not retrying might lose it forever. Most setups answer that question by guessing.

Meanwhile, the operational world solved this decades ago. Message queues have a pattern for exactly this: the **dead-letter queue**. A message that can't be processed is captured with full context — payload, error, attempts — inspected, fixed, and **redriven** when you're ready. SQS built a product category on it.

`mcprelay` applies that model to `tools/call`.

## The failure path as a first-class citizen

`mcprelay` is a transparent middleware that wraps any MCP server — stdio or remote HTTP — and adds four layers around `tools/call`:

1. **Policy** — declarative allow/deny per tool and per argument, with a dry-run mode. Denials are visible, attributable, and never silently swallowed.
2. **Reliability** — timeouts and classified retries. The taxonomy matters: retries are gated on whether a tool is idempotent, `isError` results never auto-retry, cancellations abort cleanly.
3. **The dead-letter queue** — a call that ultimately fails is captured **before** the client sees the error: redacted arguments, a hash of the raw ones, the failure class, attempts, and a correlation id. Durable across restarts. SQLite by default; RabbitMQ (`mcp.dlx`/`mcp.dlq`, publisher confirms) when you want a real broker.
4. **Observability** — one structured log line per call and per-tool metrics (latency, error rate, caller) from `mcprelay report`.

![mcprelay — the 60-second demo: a call fails, lands in the dead-letter queue, and the replay writes the file](https://raw.githubusercontent.com/yamillanz/mcprelay/main/docs/assets/demo.gif)

## Replay, honestly

A replayed call's response cannot go back to the agent that made it — that session is over. So `mcprelay` doesn't pretend: replay is **redrive for side effects**. The call re-executes upstream, the side effect lands, and the (redacted) result or error is stored in the audit trail, which is the only place a replay's outcome can be inspected. Read-only tools are rarely worth replaying, and `--dry-run` will tell you so. Secrets never persist in the clear; a record with redacted arguments refuses to replay until you supply them with `--set`.

That's the whole point: when a write dies at 3am, you find it in `replay list`, understand exactly what happened, fix the cause, and run it — once, deliberately, with a receipt.

## What it is not

Not an enterprise gateway, not a K8s control plane, not a security suite. It's a local-first npm package — `npx @yamillanz/mcprelay run -- <your server>` — that makes the failure path of tool calls a product instead of an afterthought. Zero-config defaults, two pluggable ports (`QueueProvider`, `Store`), OSS-only stack, no SaaS anywhere.

## Try it

```sh
npx @yamillanz/mcprelay run -- npx -y @modelcontextprotocol/server-filesystem .
```

Kill a call, watch it land in the DLQ, replay it, and read the report. The [README](https://github.com/yamillanz/mcprelay#readme) has the 60-second walkthrough and three ready-to-run recipes (filesystem, memory, everything); the [PRD](https://github.com/yamillanz/mcprelay/blob/main/docs/PRD.md) has the full architecture and the honest scope caps.

If your agent's tool calls can fail — and they can — they deserve a dead-letter queue.

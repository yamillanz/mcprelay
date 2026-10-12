# memory — official MCP knowledge-graph memory server

Wraps [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) with mcprelay: every graph operation gets a structured log line, failures land in the dead-letter queue with replay, and `report` shows per-tool latency — the server itself runs unmodified.

## Run

```bash
# from this directory (memory.json is written next to where you start it)
npx @yamillanz/mcprelay run --config mcprelay.config.yaml -- \
  npx -y @modelcontextprotocol/server-memory
```

Point your MCP client at the same command (root README has the Claude Desktop / Cursor snippet).

## What this config adds

- `delete_entities` is denied at the tool level: an agent can create entities, relations, and observations, but destroying graph data requires a human. This is the simplest rule shape — no argument matchers, just the tool name.

## Try it

- `create_entities` then `search_nodes` — both calls appear as log lines; `report` shows them per tool.
- `delete_entities` → denied (`-32001`), visible in the log and in `report`'s denied count.
- Need a deletion? Run mcprelay without the rule (or with `--policy-dry-run` first to see what it would block).

State lives in `./.mcprelay/` (SQLite by default). Full walkthrough: root [README](../../README.md) and [docs/PRD.md](../../docs/PRD.md) §1.

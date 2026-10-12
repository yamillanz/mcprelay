# filesystem — official MCP filesystem server

Wraps [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) with mcprelay: one structured log line per call, a dead-letter queue with replay for failures, and per-tool `report` metrics — the server itself runs unmodified.

## Run

```bash
# from this directory
npx @yamillanz/mcprelay run --config mcprelay.config.yaml -- \
  npx -y @modelcontextprotocol/server-filesystem /path/to/your/project
```

Point your MCP client at the same command (root README has the Claude Desktop / Cursor snippet).

## What this config adds

- `write_file` and `edit_file` are denied for paths inside `.git/` (regex argument rule): agents can read repository history, but cannot corrupt its metadata. Try the same rule shape with `prefix` for absolute paths.

## Try it

- `read_file` a file, then `write_file` inside `.git/` — the second call is denied and the log line says why.
- Make a call fail (e.g. write into a read-only directory) → it lands in `npx @yamillanz/mcprelay replay list`; fix the cause, then `replay run <id>` re-executes it.
- `npx @yamillanz/mcprelay report --config mcprelay.config.yaml` for per-tool latency and error rates.

State lives in `./.mcprelay/` (SQLite by default). Full walkthrough: root [README](../../README.md) and [docs/PRD.md](../../docs/PRD.md) §1.

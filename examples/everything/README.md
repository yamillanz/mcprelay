# everything — official MCP everything (test) server

Wraps [`@modelcontextprotocol/server-everything`](https://github.com/modelcontextprotocol/servers/tree/main/src/everything) with mcprelay: the SDK's kitchen-sink test server behind the same pipeline — logs, retries, DLQ with replay, `report` — while the server itself runs unmodified.

## Run

```bash
# from this directory
npx @yamillanz/mcprelay run --config mcprelay.config.yaml -- \
  npx -y @modelcontextprotocol/server-everything
```

Point your MCP client at the same command (root README has the Claude Desktop / Cursor snippet).

## What this config adds

- A 5 s default timeout with 2 retries, and `longRunningOperation` marked `idempotent` (with its own per-tool settings): `longRunningOperation` with `duration: 10000` times out, retries, and finally lands in the dead-letter queue — replay it once you are ready.

## Try it

- `longRunningOperation` with `duration: 10000` → timeout → retries → `npx @yamillanz/mcprelay replay list` shows the record.
- `npx @yamillanz/mcprelay replay run <id> --dry-run` first, then without `--dry-run` to redrive it.
- `echo` and `add` are instant: good for watching the log line and `report` numbers stay clean.

State lives in `./.mcprelay/` (SQLite by default). Full walkthrough: root [README](../../README.md) and [docs/PRD.md](../../docs/PRD.md) §1.

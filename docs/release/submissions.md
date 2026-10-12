# Submission kit — v1.0 launch

Prepared texts for the human to submit. Nothing here is auto-posted: every
submission is a manual action from the maintainer's accounts (rule 0 applies to
public actions the same way it applies to commits).

## 1. awesome-mcp-servers PR

Candidate lists (check each list's current contributing rules and placement —
"Community Servers" or "Utilities" sections usually):

- [`punkpeye/awesome-mcp-servers`](https://github.com/punkpeye/awesome-mcp-servers)
- [`wong2/awesome-mcp-servers`](https://github.com/wong2/awesome-mcp-servers)

Entry line (list format, adapted to each list's columns):

```md
- [yamillanz/mcprelay](https://github.com/yamillanz/mcprelay) — The reliability layer for MCP tool calls: policy, observability, and a dead-letter queue with replay around `tools/call`. Local-first middleware (stdio + Streamable HTTP) with SQLite or RabbitMQ backends.
```

PR title: `Add mcprelay — DLQ + replay middleware for MCP tool calls`

PR body (short):

> Adds `mcprelay`, a local-first middleware that wraps any MCP server (stdio or
> remote HTTP) and adds policy, observability, and a dead-letter queue with
> replay around `tools/call`. It is TypeScript/Node ≥ 20, OSS-only, published
> as `@yamillanz/mcprelay`, and the repo carries the full spec-driven history
> (PRD, ADRs, OpenSpec changes). The README has a 60-second demo GIF and three
> public-server recipes.

## 2. r/MCP post

Title: `Why your agent's tool calls need a dead-letter queue (I built mcprelay)`

Body: use [`launch-post.md`](launch-post.md) as-is, trimmed to the first two
sections + the "Try it" block if the post feels long. Problem first, repo
second — §9 of the PRD is explicit about this.

## 3. MCP Discord message

> For anyone who's had a tool call die mid-flight: I built **mcprelay**, a
> local-first middleware that wraps any MCP server and puts a proper failure
> path around `tools/call` — classified retries, a durable dead-letter queue
> (SQLite or RabbitMQ), and replay as redrive for side effects, with the result
> captured in the audit trail. `npx @yamillanz/mcprelay run -- <your server>`,
> zero config to start. There's a 60-second demo GIF in the README:
> https://github.com/yamillanz/mcprelay — feedback very welcome.

## 4. Checklist (human)

- [ ] npm 1.0.0 published (`npm publish`) and `npx @yamillanz/mcprelay --version` prints 1.0.0
- [ ] awesome-mcp-servers PR opened (both lists)
- [ ] r/MCP post published
- [ ] MCP Discord message posted
- [ ] Star counts in the README comparison table re-verified on the day of posting

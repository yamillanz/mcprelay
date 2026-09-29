## Context

M3 captures failures durably and exposes them through `replay list|inspect`. M4 ships the differentiator: replay as redrive for side effects. The hard parts are honesty and safety, not the happy path:

- Stored arguments are **redacted** (NFR-4), so a replay cannot reproduce a call whose secrets were masked.
- Replaying can **duplicate side effects**, so an idempotency guard is required (FR-R5).
- Concurrent replays must not **double-execute** (FR-R6), which `resolve()` alone cannot prevent because it happens after execution.
- The replay's result has nowhere to go (the original caller is gone): it must land in the audit trail (PRD §1).

M4 is also the first usable public release: npm `0.1.0`, public repo, honest README.

## Goals / Non-Goals

**Goals**

- `replay run <id>` executes once, captures its redacted outcome, and resolves the record.
- `--dry-run` gives the operator everything needed to decide, with zero upstream `tools/call`.
- Redacted arguments are never replayed blindly; `--set` fills them.
- Duplicate executions within the dedup window require `--force`; concurrent runs cannot double-execute.
- Public release: version `0.1.0`, npm publish with human approval, honest README.

**Non-Goals**

- Batch replay (`run --all --filter`, M7), RabbitMQ (M7), metrics/report (M8), retention (M8).
- Policy re-evaluation in `--dry-run` (policy engine is M5; the dry-run reports tool presence, dedup, effects, and arguments instead, and the docs say so).
- Automatic replay (replay is always operator-initiated).
- Storing raw secrets to make replay exact (NFR-4 forbids it; `--set` is the sanctioned path).

## Decisions

### D1 — Claim with a lease, then execute

`resolve()` is atomic but runs *after* execution, so it cannot prevent double-execution. The port gains:

- `claim(id, leaseMs)`: `UPDATE failures SET claimed_at = :now, claim_expires_at = :expiry WHERE id = ? AND replay_status = 'pending' AND (claim_expires_at IS NULL OR claim_expires_at < :now)` — `changes === 1` wins.
- `release(id)`: clears the claim while the record is still pending.

Schema migration: `claimed_at` and `claim_expires_at` columns added with a `PRAGMA table_info` guard, so M3 databases upgrade in place. Lease default 5 minutes (constant, documented); the CLI never waits on it.

Execution flow: guard args → dedup check → `claim` → connect → call → redact outcome → `resolve(replayed, outcome)` + audit. If the failure happens **before the tool could execute** (spawn/connect/send), the CLI calls `release` so the record stays pending for a later attempt and exits non-zero. If the call executed (including a timeout or an upstream error), the outcome is captured and the record is resolved — an attempted replay is a replay.

### D2 — Idempotency index in the queue database

New table `executions(key TEXT PRIMARY KEY, tool_name TEXT, arguments_hash TEXT, executed_at TEXT, source TEXT)` (`source`: `live` | `replay`). `recordExecution` upserts (latest wins); `lastExecution(key)` and `lastExecutionByHash(hash)` read it.

Key extraction: `_meta.idempotencyKey` (string/number) first, then `arguments.idempotency_key` / `arguments.idempotencyKey`; normalized to string. No key → the record's `arguments_hash` is the fallback identity.

The middleware records a successful intercepted call **only when it carries a key** (unkeyed traffic adds no write; NFR-3 stays clean). Replays always record their execution (they were operator-initiated and keyed by hash when no key exists).

### D3 — Dedup guard semantics

Before claiming, `run` checks the index:

- key present and `executed_at` within `reliability.replay.dedup_window` (default 24 h) → refuse unless `--force`, naming the previous execution (tool, timestamp, source).
- no key → same check on `arguments_hash`.
- `--force` proceeds and the new execution is recorded.

`--dry-run` reports the same verdict without executing.

### D4 — Redacted-argument guard

`run` scans the stored arguments for `[REDACTED]` markers (any depth). If markers exist:

- `--set key=value` (repeatable, top-level keys) replaces named keys;
- if any marker remains, the run refuses and lists the missing keys;
- the guard runs before the claim, so a refusal costs nothing.

This keeps NFR-4 intact and makes the limitation explicit instead of silently sending `[REDACTED]` upstream.

### D5 — Replay execution and result capture

- The upstream command is the record's `server.command` (the exact wrapped invocation), spawned fresh per replay through the existing `UpstreamTransport` + SDK `Client`. Trust boundary: the queue database is operator-owned and local; replay executes what was recorded. Recorded in ADR-0005.
- One attempt, `resolveToolPolicy(config, tool).timeoutMs`, no retry pipeline (deliberate action, not automatic reliability).
- Outcome: `redactValue`/`redactMessage` applied to the result or error, stored as `replay.last_outcome` and appended to `replay.attempts` with `{at, source: 'replay'}`.
- Audit: `store.audit({kind: 'replayed', correlationId, failureId, toolName, detail: {status, outcome}})` — the only place a replay's outcome lives (PRD §1).
- CLI output: human summary or `--json`; exit 0 on success, 1 on refusal/execution failure, 2 on usage/config.

### D6 — Dry-run semantics

Connect upstream, `tools/list`, then report: tool present/absent, dedup verdict, `effects: read` warning, redacted arguments, and the exact command that would run. **Zero** `tools/call`. Missing tool → exit non-zero. Policy re-evaluation is documented as M5.

### D7 — Config: `reliability.replay.dedup_window`

Duration string (`24h`, `30m`, `7d`, `90s`), default `24h`, parsed by a small `parseDuration` helper (units ms/s/m/h/d; invalid → `ConfigError` naming the field). It merges into the M3 loader with the same strict-key rules.

### D8 — First public release

- Version `0.1.0` (first usable release; the PRD's placeholder line ends here).
- npm publish via the stage flow with human 2FA approval; verify `npm view` and `npx @yamillanz/mcprelay@0.1.0 --version`.
- Repo visibility checked with `gh repo view --json visibility`; if private, the human flips it (no silent setting changes).
- README rewrite (honest): status and what works, `npx @yamillanz/mcprelay` quickstart **plus the client-config snippet** (Claude Desktop / OpenCode / Cursor wrapping one server — the persona's real install path), a "What replay means" section, the `tools/list` visibility answer (FR-Y5), configuration, exit codes, and the current limitations (no policy/metrics yet).
- The npm-page README refresh ships with this publish (0.0.3's page is one version behind the repo).

### D9 — Docs, ADR, diagram

ADR-0005 records: claim/lease over post-hoc resolve, the redacted-args guard, the idempotency index, the stored-command trust boundary, and the "attempted replay is a replay" rule. The living diagram gains the replay path (CLI → queue claim/resolve → fresh upstream execution) within the 12-node cap. `docs/code-tours/` gets no new file unless the bridge changes materially (it gains one keyed-success index call).

### D10 — Test strategy (rule 11)

- **Unit:** duration parser; idempotency-key extraction (meta, args, none); redacted-marker scan; guard verdicts (window in/out, force).
- **Adapter:** claim wins/loses, lease expiry, release, index upsert/read, migration on an M3 database (create without the new columns, reopen, columns added).
- **Integration (hermetic):** dry-run makes zero `tools/call` (upstream stats unchanged); run executes once and resolves (status, last_outcome, audit entry); result redaction; refusal without `--set`; success with `--set`; dedup refuse/force; two concurrent runs → one execution; missing tool dry-run exits non-zero; keyed success through the proxy indexes an execution.
- **Real-server gate (rule 10):** filesystem server — `write_file` to a missing directory fails and is captured; after creating the directory, `replay run <id>` writes the file (visible side effect) and the audit entry holds the replay's result.

## Risks / Trade-offs

- **Replay executes a stored command** → local, operator-owned DB; documented trust boundary in ADR-0005; no remote/DB-supplied commands are fetched.
- **`--force` can duplicate effects** → explicit flag, named previous execution, and the dedup verdict is printed first; the operator owns the decision.
- **Lease means a crashed replay blocks for up to 5 minutes** → bounded and documented; `release` handles the graceful pre-execution failure path.
- **Redacted-args refusal may surprise** → the dry-run and the refusal message list exactly which keys need `--set`.
- **Key extraction is heuristic** (`idempotency_key` naming) → documented convention until the spec's ETags/caching work lands (PRD §5.1); hash fallback covers unkeyed calls.

## Open Questions

- Whether the index should also record **failed** executions (proposed: no — only successes gate duplicates; the DLQ already holds failures).
- Whether `replay run` should print a structured call-log line (proposed: no — the audit entry is the record; the CLI prints a summary).

## Why

M3 captures failures durably; M4 ships the payoff — **replay as redrive for side effects**. The operator inspects a dead letter, dry-runs it (zero side effects), then re-executes it: the call runs upstream, the side effect lands, and the replay's own redacted result or error is captured into the audit trail (the original caller's session is gone — PRD §1 *What replay means*). Duplicate effects are guarded by an idempotency check, and concurrent replays cannot double-execute thanks to an atomic claim. This is also the **first usable public release**: npm `0.1.0`, a repo that is public, and an honest README with the client-config quickstart.

## What Changes

- **`replay run <id>`** (FR-R4): claims the record atomically, re-executes the stored call against a fresh upstream connection, captures the replay's own **redacted** result or error into `replay.last_outcome` and an audit entry linking original ↔ replay, then resolves the record. Single attempt, per-tool timeout, no retries (replay is deliberate, not automatic).
- **`replay run <id> --dry-run`** (FR-R4): connects upstream read-only (`tools/list`), reports tool presence, dedup status, the `effects: read` hint, and the redacted arguments — and performs **zero** `tools/call` calls. Policy re-evaluation lands with the policy engine (M5) and is documented as such.
- **Redacted-argument guard**: records whose stored arguments contain redaction markers cannot be re-executed as-is; `--set key=value` (repeatable) fills the named keys, and any remaining marker refuses the run. Secrets never persist in the clear (NFR-4) and replay stays honest about it.
- **Idempotency guard** (FR-R5): successful executions that carry a key (`_meta.idempotencyKey` or an args `idempotency_key`/`idempotencyKey` field) are indexed; replay refuses a duplicate within `reliability.replay.dedup_window` (default 24 h) unless `--force` is given. Without a key, the arguments hash is the fallback.
- **Concurrent replay safety** (FR-R6): the port gains `claim(id, leaseMs)` — a guarded UPDATE with a lease; of concurrent runs, exactly one executes, the loser exits non-zero.
- **Config**: `reliability.replay.dedup_window` (duration string, default `24h`).
- **First public release** (§9): version `0.1.0`, npm publish (stage + human 2FA), repo visibility confirmed public, README rewritten with the client-config quickstart, what replay means, `tools/list` visibility (FR-Y5), and the current honest feature set.
- **Docs/architecture**: ADR-0005 (replay semantics: claim/lease, redacted-args guard, dedup index, stored-command trust boundary), README, living diagram.

No breaking changes: `replay list|inspect` keep working; capture behavior is unchanged; the new claim/index are additive.

## Capabilities

### New Capabilities

- `replay-cli`: dry-run inspection with zero side effects, replay execution with redacted result capture, the redacted-argument guard, the idempotency/dedup guard with `--force`, and concurrent-replay safety.

### Modified Capabilities

- `dead-letter-queue`: the `QueueProvider` port gains `claim(id, leaseMs)` and the idempotency index (`recordExecution` / `lastExecution`) so replay can gate and record executions atomically.
- `configuration`: `reliability.replay.dedup_window` with a duration-string parser and the `24h` default.

## Impact

- **New code**: `src/replay/replay-run.ts` (run/dry-run pipeline), replay CLI options; `src/queue/` gains `claim` + the executions index (sqlite adapter); `src/pipeline/` gains the idempotency-key extraction; `src/proxy/bridge.ts` records successful keyed executions.
- **Modified**: `src/replay/replay-cli.ts` (run subcommand + `--set`/`--force`), `src/config/config.ts` (dedup window), `README.md`, `AGENTS.md` status line, `docs/architecture/mcprelay.json|html`, `docs/adr/0005-*`.
- **Release**: `package.json` → `0.1.0`; npm stage publish + human approval; repo visibility verified public.
- **Out of scope**: batch replay (`run --all --filter`, M7), RabbitMQ (M7), metrics/report (M8), policy engine (M5 — dry-run notes it), retention (M8), HTTP (M6), the README GIF and the ≥3 example recipes (M10).

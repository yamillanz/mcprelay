## Why

M1 relays calls faithfully but has no failure story: a timeout, a transport failure, or an upstream error is returned to the client after exactly one attempt, with no timeout bound and no retry discipline. M2 adds the honest failure layer the product is named for: a configurable timeout, bounded exponential-backoff retries, and the D4 failure-class taxonomy so retries never guess about side effects. The YAML config file and CLI overrides begin here (FR-C).

## What Changes

- **Timeout per call** (FR-R1): global `reliability.timeout_ms` with per-tool override; an expired attempt fails as `timeout` and enters the retry pipeline.
- **Bounded retry with backoff** (FR-R2): exponential backoff with jitter, bounded by `max_attempts` (global + per-tool); each attempt is a separate upstream call.
- **D4 failure-class gating** (the taxonomy table is the design deliverable + ADR-0003):
  - pre-execution transport failures → retry unconditionally;
  - timeout → retry only when the tool is `idempotent: true`;
  - upstream error responses → retry only when idempotent and not a non-retryable protocol error;
  - `isError: true` results → never retry (logged and counted);
  - `input_required` results → not failures; relayed unchanged, never retried;
  - non-retryable errors (protocol/schema) → never retry;
  - client cancellation → abort the in-flight attempt, stop retries, log `cancelled`, never capture.
- **Config file + CLI flags begin** (FR-C1/C2): `./mcprelay.config.yaml` by default (`--config <path>` override) with safe zero-config defaults; `--timeout-ms` and `--max-attempts` override file values; malformed known sections fail startup with an actionable path + message; unknown top-level sections warn (forward-compatible with policy/queue/store sections landing later).
- **Retry-aware call log**: the single per-call log line reports the attempts actually used and the final decision (allowed after retries / failed exhausted / cancelled).
- **Hermetic failure injection**: the echo server gains a `flaky` tool (fails N times then succeeds) and deterministic backoff support for tests.
- **Docs/architecture**: ADR-0003 (D4 taxonomy), README config section, living architecture diagram updated (retry pipeline joins the flow).

No breaking changes: zero-config behavior keeps retries on with safe defaults; M1 passthrough semantics are untouched.

## Capabilities

### New Capabilities

- `retry-pipeline`: call timeout, bounded backoff, D4 classification and retry gating, and cancellation semantics (FR-R1–R2).
- `configuration`: the YAML config file, safe zero-config defaults, per-tool overrides, and CLI flag precedence for reliability (FR-C1–C2, begins here).

### Modified Capabilities

- `observability`: the call log line becomes retry-aware — real attempt count and the final decision (including `cancelled`).

## Impact

- **New code**: `src/config/` (YAML load, defaults, merge, CLI overrides), `src/pipeline/` (D4 classifier, retry loop, backoff).
- **Modified**: `src/proxy/bridge.ts` (attempt loop + classifier + cancellation signal), `src/cli/run.ts` (run flags + config wiring), `examples/echo-server/` (failure injection), `README.md`, `AGENTS.md` status line, `docs/architecture/mcprelay.json|html`, `docs/adr/0003-*`.
- **Dependencies**: `yaml@^2` (ISC) — the only addition; permissive license (P1), needed for FR-C1. No other new deps.
- **Out of scope**: DLQ capture (`dlq-sqlite`, M3), replay (`replay-cli`, M4), policy section (`policy-engine`, M5), `validate` command completion (M3), redaction config (M3), HTTP transport (M6).

## Context

M4 gives the proxy a full failure story, but no *decision* layer: every call that reaches the bridge is forwarded. M5 adds declarative policy (FR-Y1–Y6) — the guardrail use case (UC1) and demo beat 2: a call is blocked, `--dry-run` shows it first, and denials are counted without hiding tools from `tools/list`.

The `policy` key is currently an "unknown top-level section" warning; M5 makes it a first-class, strictly validated section. PRD D3 (open) asks whether argument rules should be simple matchers or a JSON-Schema subset; this change resolves it toward simple matchers (recorded in ADR-0006).

## Goals / Non-Goals

**Goals**

- Allow/deny by tool (exact or glob), caller identity, and argument constraints, with **most-specific-wins** precedence and a fully deterministic tie-break.
- ReDoS-bounded matching (pattern validation at load, input caps, no per-call recompilation).
- Denials returned to the client, audited, logged, never forwarded, never in the DLQ.
- `tools/list` untouched.
- `policy test` and `run --policy-dry-run` for inspection before enforcement.

**Non-Goals**

- Filtering `tools/list` (explicitly rejected by FR-Y5; the README answers it).
- JSON-Schema argument validation, rate limits, prompt-injection scanning (PRD §10).
- Caller authentication (M9; the stdio identity is `local` for now).
- Report numbers (M8) — denials are logged and audited now, counted in `report` later.

## Decisions

### D1 — Rule shape and precedence

```yaml
policy:
  default: allow            # allow | deny
  rules:
    - { tool: "fs/delete_*", action: deny }
    - { tool: "fs/read_file", args: { path: { prefix: "/projects" } }, action: allow }
    - { tool: "deploy", caller: "ci-bot", action: allow }
```

A rule matches when its `tool` pattern matches the tool name (exact or glob `*`/`?`), its optional `caller` equals the caller identity, and every `args` matcher matches. Specificity score: exact tool **+2**, glob **+1**, caller present **+1**, each argument matcher **+1**. The highest score wins; ties are broken by rule order (first in the file). No other tie-breaks exist, so precedence is total and documented. Rejected: first-match-wins (violates "most specific wins") and regex tool patterns (globs cover the use case with less risk).

### D2 — Matcher semantics

| Matcher | Semantics |
|---|---|
| `equals` | Deep JSON equality |
| `in` | Deep equality against any element of the list |
| `prefix` | String `startsWith` |
| `regex` | Bounded `RegExp.test` (see D3) |
| `max_length` | `string`/`array` length ≤ value |
| `min` / `max` | Numeric comparison |

Paths are dot-separated (`config.timeout`, `items.0.name`); a path that does not exist never matches; matchers on the same path are ANDed, as are multiple paths. A rule whose matchers do not all match simply does not match.

### D3 — ReDoS bounds (FR-Y6)

- Patterns are compiled **once at load**; pattern length ≤ 200.
- Nested-quantifier heuristic rejects dangerous shapes (`(a+)+`, `(a*)*`, `(a|a)+`, …) with the rule path in the error.
- Matched input is capped at 4096 characters; longer values never match (bounded work).
- Rejected `re2` / `safe-regex` dependencies (P5): the heuristic plus the input cap covers the v1 threat model; ADR-0006 records the trade-off (best-effort, not a proof).

### D4 — Enforcement point and denial shape

Evaluation happens in `interceptToolCall` **before** the retry pipeline: a denial cannot consume retries, claim a DLQ record, or touch the upstream.

- The handler throws a `ProtocolError` with a server-defined code `-32001` and message `mcprelay: policy denied tool '<tool>' (rule #N)`; the SDK converts it into a standard JSON-RPC error response.
- `store.audit({kind: 'denied', correlationId, toolName, detail: {rule, reason, action}})`.
- Log line: decision `denied`, `attempt: 0`, `request_bytes` = params size, `response_bytes` 0, error message = the denial.
- No DLQ record, no idempotency-index write.

### D5 — Dry-run is marked, never confused with enforcement

`run --policy-dry-run` evaluates every call and forwards it unchanged; the log line carries the would-be decision plus `enforced: false` (observability delta). The stderr warning names the rule. This is the §1 demo's "`dry-run` shows it first" step.

### D6 — `policy test`

`mcprelay policy test [--tool X] [--args JSON] [--caller ID] [--id <failure-id>] [--json] [--config <path>]`:

- `--id` loads tool + arguments from a stored failure record (queue DB) — "stored calls" per FR-Y3.
- Prints `decision`, the matched rule (`#N`, pattern, action), and the reason; `--json` emits one parseable object.
- Exit codes: `0` evaluated (allow **or** deny — the decision is data, not an error), `1` runtime error (record not found, DB), `2` usage/config.

### D7 — Caller identity

The stdio caller identity is `local` (as today); rules with `caller` match only that value, and `policy test --caller` simulates future identities (M9). A rule without `caller` matches any identity.

### D8 — Module layout

`src/policy/matchers.ts` (glob compiler, matcher evaluation, dot-path access, ReDoS heuristic) and `src/policy/policy.ts` (config parsing, precedence resolution, `evaluateCall`). Two cohesive files instead of one large one; helpers stay same-file per the readability rule. No new dependencies.

### D9 — Test strategy (rule 11)

- **Unit:** glob matching, each matcher, dot paths and missing paths, specificity table (exact vs glob vs caller vs arg count), tie-break by order, ReDoS rejections and input caps, config error paths.
- **Integration (hermetic):** denied call not forwarded (upstream per-tool count unchanged), client error, audit entry, no DLQ record, log decision `denied` attempt 0; `tools/list` unfiltered; dry-run forwards + `enforced: false`; `policy test` outputs (flags, `--id`, `--json`); zero-config warning.
- **Real-server gate (rule 10):** filesystem server with a `write_file` deny rule — `policy test`/dry-run shows the denial, the enforced call is blocked, and a `read_file` still works.

## Risks / Trade-offs

- **ReDoS heuristic is best-effort** → input cap bounds the damage; ADR-0006 records that a proof would need a linear-time engine (`re2`) and that this is a v1 trade-off.
- **Simple matchers cannot express schema-level constraints** → documented; JSON-Schema support can be added later without changing the rule shape (a matcher kind).
- **Log field addition (`enforced`)** → observability delta + tests; existing consumers ignore unknown fields.
- **`-32001` is server-defined** → documented in the README/ADR; the spec has no "forbidden" code.
- **Caller identity is `local` until M9** → rules keyed to real identities arrive with auth; `policy test --caller` makes that forward-compatible.

## Open Questions

- Whether `policy test` should exit non-zero when the decision is `deny` (proposed: no — the decision is data; CI can parse `--json`).
- Whether a startup warning should also fire when rules exist but `default: allow` (proposed: no — configured is configured).

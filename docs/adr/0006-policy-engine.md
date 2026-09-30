# ADR-0006 — Policy engine semantics

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-09-30 |
| **Milestone** | M5 `policy-engine` |
| **PRD refs** | FR-Y1–Y6, FR-C2, D3, §1 demo beat 2 |

## Context

M5 adds the decision layer: declarative allow/deny before the retry pipeline. The PRD left D3 open (simple matchers vs. a JSON-Schema subset) and requires deterministic precedence, ReDoS-bounded matching, denials that are visible (standard MCP error, audit, log) but never hidden from `tools/list`, and inspection before enforcement. This ADR records the semantics that make those guarantees real.

## Decisions

### D1 — Specificity score, file order as the tie-break

A rule matches when its `tool` glob matches, its optional `caller` equals the caller identity, and every `args` matcher matches. Among matching rules, the **highest specificity wins**: exact tool `+2`, glob (`*`/`?`) `+1`, `caller` present `+1`, each argument matcher `+1`. Ties go to the **first rule in the file** (strictly-greater comparison while scanning). Rejected: first-match-wins (contradicts "most specific match wins", FR-Y1) and regex tool patterns (globs cover the need with less risk).

### D2 — Matcher semantics (D3 resolved: simple matchers)

| Matcher | Semantics |
|---|---|
| `equals` | Deep JSON equality |
| `in` | Deep equality against any element (non-empty list) |
| `prefix` | String `startsWith` |
| `regex` | `RegExp.test`, unanchored — the pattern owns `^`/`$` |
| `max_length` | `string`/`array` length ≤ value |
| `min` / `max` | Finite-number comparison |

Paths are dot-separated (`config.timeout`, `items.0.name`); a missing path never matches; matchers on one path are ANDed, as are paths. A JSON-Schema subset was rejected for v1: the matcher set covers UC1 (path/URL allowlists) with a fraction of the surface, and the rule shape can host new matcher kinds later without breaking configs.

### D3 — ReDoS bounds: heuristic + caps, no new dependency

Patterns compile **once at load**, are capped at 200 characters, and are rejected when they contain a nested quantifier (`(a+)+`, `(a*)*`) or an ambiguous quantified alternation (`(a|a)+`, empty alternative, wildcard-leading alternative). Matched strings are capped at 4096 characters — longer values never match, bounding the work. Rejected: `re2` (native dependency, P5/P7 minimal-deps rule) and `safe-regex` (unmaintained); the heuristic is best-effort by design — a linear-time engine is the real fix if the threat model grows.

### D4 — Denial shape: `-32001`, audited, never forwarded, never DLQ

Evaluation runs in `interceptToolCall` **before** the retry pipeline, so a denial consumes no retries and cannot claim a DLQ record. An enforced denial throws `ProtocolError(-32001, "policy denied tool '<tool>': matched rule #N …")` — the SDK's error path maps any thrown error with a numeric `code` to a JSON-RPC error response, and `-32001` is server-defined (the spec reserves `-32000..-32099` for implementations). The denial also writes a Store audit entry (`kind: denied`, with rule number and reason) and one log line (`decision: denied`, `attempt: 0`). A store failure never blocks the denial.

### D5 — Dry-run is marked, never mistaken for enforcement

`run --policy-dry-run` evaluates every call, forwards it unchanged, and logs the would-be decision with `enforced: false` (plus a stderr warning). An enforced denial never carries `enforced`; consumers can therefore tell a report from an enforcement without inspecting other fields.

### D6 — `tools/list` is never filtered (FR-Y5)

The policy engine only intercepts `tools/call`. Denied tools stay visible in `tools/list`; denial happens at call time and is counted. Hiding tools would be an invisible behavior change and would break capability discovery; revisited post-v1 only behind an explicit opt-in.

### D7 — `policy test` exit codes

`policy test` evaluates a hypothetical call (`--tool`, `--args`, `--caller`) or a stored record (`--id`, from the DLQ) and prints the decision, the matched rule, and the reason; `--json` emits one parseable document. Exit `0` means "evaluated" — a `deny` decision is data, not an error (CI can parse `--json`); `1` is a runtime failure (record not found, database); `2` is usage or config. The stored record's arguments are the redacted ones (NFR-4) — a matcher against a redacted value is a documented limitation, not a leak.

### D8 — Caller identity is `local` until M9

The stdio caller is `local`; rules with `caller` match that value, and `policy test --caller` simulates future identities. No rule can be bypassed by omitting a caller: the identity is fixed by the transport, not the request.

### D9 — Zero-config stays allow-with-warning

With no `policy` section (or no rules) the session allows everything and prints a warning naming the default (FR-C2). A configured `default: deny` with no rules warns that everything is denied. The `policy` key stops being an "unknown top-level section" warning and is strictly validated: unknown keys, malformed rules, and bad matchers fail with the rule path and field.

## Consequences

- Precedence is total and documented: any two matching rules compare by score, then by file order — no undefined ties.
- The rule language is small enough to reason about and bounded in cost; JSON-Schema validation remains a possible future matcher, not a rewrite.
- Denials are loud (error + audit + log) and harmless to discovery (`tools/list` intact), and the dry-run flag makes rollout risk-free.
- The redacted-arguments caveat for `--id` is inherent to NFR-4 and recorded here.

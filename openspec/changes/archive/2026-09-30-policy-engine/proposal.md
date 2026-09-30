## Why

M4 shipped replay, but nothing decides **whether a tool call should run at all**. Any agent connected through the proxy can call any tool with any arguments — the guardrail use case (UC1) is still missing. M5 adds declarative policy (FR-Y1–Y6): allow/deny per tool, per caller identity, and per argument, with deterministic precedence, a dry-run mode that shows decisions before enforcing them, and denials that are returned to the client and written to the audit trail — while `tools/list` keeps showing the full inventory (FR-Y5).

## What Changes

- **Declarative policy config** (`policy` section): `default: allow|deny` plus ordered `rules` matching by tool name (exact or glob), optional `caller` identity, and optional `args` constraints. **Most specific match wins**, with a documented deterministic tie-break (rule order in the file).
- **Argument matchers** (FR-Y2): `equals`, `in`, `prefix`, `regex`, `max_length`, numeric `min`/`max`, addressed by dot-path into the arguments object; multiple matchers on one path are ANDed; a matcher on a missing argument never matches.
- **Policy hygiene** (FR-Y6): patterns validated at load (length limits and a nested-quantifier ReDoS heuristic → precise config error), matched input length capped, and precedence is fully deterministic.
- **Enforcement** (FR-Y4): a denied `tools/call` returns a standard MCP error to the client, writes a Store audit entry (`kind: denied`), is **never forwarded upstream**, **never enters the DLQ**, and is logged with decision `denied` (0 attempts). Denials are counted in `report` (metrics land with M8).
- **`tools/list` stays unfiltered** (FR-Y5): denied tools remain visible; denial happens at call time. The README answers this explicitly.
- **Inspection before enforcement** (FR-Y3): `mcprelay policy test [--tool X --args JSON --caller ID | --id <failure-id>] [--json]` prints the decision that *would* be enforced plus the matched rule; `run --policy-dry-run` evaluates every call and logs the would-be decision without enforcing.
- **Docs/architecture**: ADR-0006 (precedence/specificity, matcher semantics, ReDoS mitigation, denial error shape), README policy section, living diagram.

No breaking changes: with no `policy` section the zero-config default stays allow-with-warning (FR-C2); the `policy` key stops being an "unknown top-level section" warning.

## Capabilities

### New Capabilities

- `policy`: declarative allow/deny by tool, caller, and argument; deterministic specificity-based precedence; ReDoS-bounded matching; enforcement, denial audit, and counting; unfiltered `tools/list`; `policy test` and `--policy-dry-run` inspection.

### Modified Capabilities

- `configuration`: the `policy` section (strict keys, precise errors) and the `run --policy-dry-run` flag.

## Impact

- **New code**: `src/policy/` (rule parsing, matcher engine, precedence resolver, ReDoS guards), `src/cli/` `policy test` command, enforcement in `src/proxy/bridge.ts`, config `policy` section.
- **Modified**: `src/config/config.ts`, `src/proxy/bridge.ts` (evaluate before the retry pipeline), `src/cli/run.ts` (command + flag), `README.md`, `AGENTS.md` status line, `docs/architecture/mcprelay.json|html`, `docs/adr/0006-*`.
- **No new dependencies**: matcher engine is hand-rolled over Node built-ins (P5).
- **Out of scope**: filtering `tools/list` (explicitly rejected by FR-Y5), JSON-Schema argument validation (simple matchers only, per D3), rate limits, prompt-injection scanning (PRD §10), HTTP auth (M6/M9), metrics/report numbers (M8), batch replay (M7).

# Tasks — `policy-engine`

Test-first (rule 11): each delta scenario becomes a failing test before its implementation. Scenario names map to `specs/policy/spec.md`, `specs/configuration/spec.md`, and `specs/observability/spec.md`.

## 0. Approval gate (rule 0 — blocks everything below)

- [x] 0.1 The human has read the complete change (proposal → design → delta specs → tasks) and **explicitly approved implementation in this session**

## 1. Matcher engine (pure units)

- [x] 1.1 Write failing unit tests: glob matching (exact, `*`, `?`), each matcher (`equals`, `in`, `prefix`, `regex`, `max_length`, `min`, `max`), dot paths, missing paths, ReDoS rejections (nested quantifiers, oversized pattern), input cap (red)
- [x] 1.2 Implement `src/policy/matchers.ts` until green

## 2. Rule parsing and precedence (pure units)

- [x] 2.1 Write failing unit tests: rule parsing (valid, unknown key, missing action, bad matcher), matching (tool, caller, args), specificity table (exact vs glob, caller, arg count), tie-break by file order, default action (red)
- [x] 2.2 Implement `src/policy/policy.ts` (`evaluateCall`) until green

## 3. Config: policy section

- [x] 3.1 Write failing config tests: defaults with warning, rules parsed in order, malformed rule with path+field, `--policy-dry-run` accepted by `run` (red → green)

## 4. Enforcement in the pipeline

- [x] 4.1 Write failing integration tests: denied call not forwarded (upstream count unchanged), client gets a standard error, audit entry `denied`, no DLQ record, log line decision `denied` attempt 0 (red)
- [x] 4.2 Implement enforcement in `interceptToolCall` (before retry/DLQ) until green

## 5. `tools/list` stays unfiltered

- [x] 5.1 Write failing test: a denied tool still appears in `tools/list` and calling it is denied (red → green; expected to pass by construction — record it as the FR-Y5 proof)

## 6. Inspection before enforcement

- [x] 6.1 Write failing tests: `policy test` flags + `--json`; `--id` uses a stored record; exit codes; `run --policy-dry-run` forwards a would-be-denied call and logs `enforced: false` (red)
- [x] 6.2 Implement the `policy test` command + the dry-run flag until green

## 7. Docs, ADR, diagram

- [x] 7.1 Write ADR-0006: precedence/specificity table, matcher semantics, ReDoS bounds (and the rejected linear-time engine), denial error shape, dry-run marking
- [x] 7.2 Update the living architecture diagram (policy node between bridge and retry) and re-deliver the HTML (showcase)
- [x] 7.3 README policy section (rules, matchers, dry-run, `tools/list` answer, denial error) + AGENTS status line (M5 done → next M6)

## 8. Verification and approval gates

- [x] 8.1 Full gate green: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build && npm run spec:validate`
- [x] 8.2 Real-server gate (demo beat 2): filesystem server with a `write_file` deny rule — `policy test`/dry-run shows the denial, the enforced call is blocked, `read_file` still works; record evidence here
  - Evidence 2026-09-30, `@modelcontextprotocol/server-filesystem` behind `mcprelay run`, rule: deny `write_file` when `path` has prefix `<protected>/`:
    - `tools/list` includes `write_file` (FR-Y5)
    - denied call → `-32001` `policy denied tool 'write_file': matched rule #1 (tool 'write_file')`; target file absent (never forwarded)
    - allowed `write_file` + `read_file` work; log line `decision: denied`, `attempt: 0`
    - `--policy-dry-run`: call forwarded (file written), log `decision: denied` with `enforced: false` + stderr warning
    - `policy test --json` → exit 0, `{decision: deny, rule: 1}`; Store audit `kind: denied`, `detail.rule: 1`
- [ ] 8.3 Human approval for the commit/push — state the exact staged scope and message and wait (rule 0)
- [ ] 8.4 Human approval to archive (rule 0); archive the change after approval

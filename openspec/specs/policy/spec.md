# policy Specification

## Purpose

Declarative allow/deny for `tools/call`: rules match by tool name (globs), caller identity, and argument matchers with deterministic most-specific-wins precedence; matching is ReDoS-bounded; denied calls are returned to the client (`-32001`), audited, logged, and never forwarded or captured in the DLQ, while `tools/list` stays unfiltered; `policy test` and `--policy-dry-run` inspect decisions before enforcement.

## Requirements
### Requirement: Declarative allow/deny with deterministic precedence

The config SHALL declare `policy.default` (`allow` or `deny`, default `allow`) and an ordered list of rules. A rule matches when its `tool` pattern (exact name or glob) matches the tool name, its optional `caller` matches the caller identity, and every `args` matcher matches. Among matching rules the **most specific wins**, scored by tool exactness (exact over glob), the presence of `caller`, and the number of argument matchers; ties are broken by rule order (the first in the file wins). When no rule matches, the default action applies.

#### Scenario: Exact tool rule
- **WHEN** a rule denies `write_file` by exact name
- **THEN** calling `write_file` is denied and no other tool is affected

#### Scenario: Glob tool rule
- **WHEN** a rule denies `fs/delete_*`
- **THEN** `fs/delete_all` is denied and `fs/read_file` is unaffected

#### Scenario: Default action applies
- **WHEN** no rule matches and `policy.default` is `deny`
- **THEN** the call is denied; with `default: allow` it is allowed

#### Scenario: Caller-specific rule
- **WHEN** one rule denies `deploy` for caller `ci-bot` and another allows it for caller `local`
- **THEN** each caller gets the decision of its matching rule

#### Scenario: Specificity beats file order
- **WHEN** a broad deny appears before a more specific allow
- **THEN** the more specific allow wins for the calls it matches

#### Scenario: Ties are deterministic
- **WHEN** two equally specific rules with different actions match
- **THEN** the first rule in the file wins, every time

### Requirement: Argument matchers

Argument rules SHALL support the matchers `equals`, `in`, `prefix`, `regex`, `max_length`, `min`, and `max`, addressed by dot-path into the arguments object. Multiple matchers on the same path SHALL be ANDed. A matcher on an argument path that does not exist SHALL NOT match.

#### Scenario: Prefix matcher
- **WHEN** a rule requires `path` to have prefix `/projects`
- **THEN** `path: /projects/a.txt` matches and `path: /etc/passwd` does not

#### Scenario: In-list matcher
- **WHEN** a rule requires `method` to be in `[GET, HEAD]`
- **THEN** `method: GET` matches and `method: POST` does not

#### Scenario: Regex matcher
- **WHEN** a rule requires `url` to match a bounded regex
- **THEN** matching values pass and non-matching values fail

#### Scenario: Length and numeric bounds
- **WHEN** a rule requires `body` to have `max_length` and `timeout` to be within `min`/`max`
- **THEN** values outside the bounds do not match

#### Scenario: Nested paths
- **WHEN** a rule constrains `config.timeout` via a dot path
- **THEN** the nested value is evaluated

#### Scenario: Missing argument never matches
- **WHEN** a rule constrains `path` but the call has no `path` argument
- **THEN** the rule does not match (the next matching rule or the default applies)

### Requirement: Policy hygiene

At load, regex patterns SHALL be length-limited and rejected when they contain nested quantifiers (ReDoS heuristic); matched input SHALL be length-capped; invalid matcher shapes SHALL fail with the config path and the offending field. Precedence SHALL be deterministic as specified above.

#### Scenario: Dangerous pattern is rejected
- **WHEN** a rule uses a nested-quantifier pattern such as `(a+)+$`
- **THEN** config loading fails naming the rule and field

#### Scenario: Oversized pattern or input is bounded
- **WHEN** a pattern exceeds the length limit, or the matched value exceeds the input cap
- **THEN** the pattern is rejected at load / the value does not match, within bounded time

#### Scenario: Invalid matcher shape fails with path and field
- **WHEN** a rule uses an unknown matcher or a wrong value type
- **THEN** config loading fails naming the rule and field

### Requirement: Denied calls are enforced, audited, and never forwarded

A denied `tools/call` SHALL return a standard MCP error to the client, write a Store audit entry with kind `denied` (including the matched rule and reason), SHALL NOT be forwarded upstream, SHALL NOT enter the DLQ, and SHALL be logged with decision `denied` and zero attempts.

#### Scenario: Denied call is not forwarded
- **WHEN** a call is denied
- **THEN** the upstream receives no `tools/call` for it

#### Scenario: Client receives a standard error
- **WHEN** a call is denied
- **THEN** the client receives a standard MCP error naming the policy denial

#### Scenario: Denial is audited
- **WHEN** a call is denied
- **THEN** an audit entry with kind `denied` links the correlation id, tool, and matched rule

#### Scenario: Denied calls never enter the DLQ
- **WHEN** a call is denied
- **THEN** no failure record exists for it

#### Scenario: Denied calls are logged
- **WHEN** a call is denied
- **THEN** exactly one log line reports decision `denied` with zero attempts and no error class

### Requirement: tools/list is never filtered

`tools/list` SHALL pass through unfiltered: denied tools remain visible to the client, and denial happens at call time.

#### Scenario: Denied tool stays listed
- **WHEN** a tool is denied by policy
- **THEN** `tools/list` still includes it, and calling it is denied

### Requirement: Inspection before enforcement

`mcprelay policy test` SHALL evaluate a hypothetical call (`--tool`, `--args`, `--caller`) or a stored call (`--id`) against the current policy and print the decision that would be enforced plus the matched rule, without enforcing. `run --policy-dry-run` SHALL evaluate every `tools/call` and log the would-be decision while still forwarding the call.

#### Scenario: Test prints the would-be decision
- **WHEN** `policy test --tool write_file --args '{"path":"/etc/passwd"}'` runs against a denying policy
- **THEN** it prints the denial and the matched rule, and nothing is executed

#### Scenario: Test can use a stored call
- **WHEN** `policy test --id <failure-id>` runs
- **THEN** it evaluates the stored record's tool and arguments

#### Scenario: Dry-run forwards but reports
- **WHEN** `run --policy-dry-run` sees a call the policy would deny
- **THEN** the call is forwarded upstream and the log line reports the would-be denial

#### Scenario: JSON output is machine-readable
- **WHEN** `policy test --json` runs
- **THEN** the output is a single parseable JSON document


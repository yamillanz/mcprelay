## ADDED Requirements

### Requirement: Opt-in capture of tool_error results

`isError: true` results SHALL remain non-retryable (unchanged). They SHALL be captured to the DLQ only when the tool opts in via `reliability.per_tool.<tool>.capture_tool_errors: true`; by default they are logged as failed and not captured.

#### Scenario: Default does not capture tool errors
- **WHEN** a tool without `capture_tool_errors` returns `isError: true`
- **THEN** the call is logged as failed and no DLQ record is written

#### Scenario: Opt-in captures the tool error
- **WHEN** a tool with `capture_tool_errors: true` returns `isError: true`
- **THEN** the result is relayed to the client and a record with `failure.class: tool_error` is captured

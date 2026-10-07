## ADDED Requirements

### Requirement: Report command

`mcprelay report [--since <iso>] [--until <iso>] [--tool <name>] [--caller <identity>] [--json] [--config <path>]` SHALL render the store's per-caller+tool metrics for a time range: a human-readable table (caller, tool, calls, errors, error rate, p50/p95 latency, average request/response bytes) and a totals line including `allowed`, `denied`, `failed`, `cancelled`, and `replayed` counts. Defaults SHALL be the last 24 hours (`since` = now − 24 h, `until` = now) and no tool/caller filter; `--since`/`--until` SHALL be ISO-8601 and invalid values SHALL be usage errors. `--json` SHALL emit a single parseable document with the window, totals, and rows. Empty data SHALL print zero totals and exit 0; malformed configuration or arguments SHALL exit 2, and a store-open failure SHALL exit 1. The command SHALL select its store through the `createPersistence` factory.

#### Scenario: Table renders the aggregated metrics
- **WHEN** call events exist in the window and `report` runs
- **THEN** the output shows the window, the totals line with all counts, and one row per caller+tool with counts, error rate, p50/p95, and average payload sizes

#### Scenario: JSON is machine-readable
- **WHEN** `report --json` runs
- **THEN** the output is a single JSON document with the window, totals, and the tool rows

#### Scenario: Filters narrow the window
- **WHEN** `--since`, `--until`, `--tool`, or `--caller` are supplied
- **THEN** only matching call events contribute to the output

#### Scenario: Empty data is not an error
- **WHEN** no call events match the window
- **THEN** zero totals are printed and the command exits 0

#### Scenario: Invalid dates are usage errors
- **WHEN** `--since` or `--until` is not a valid ISO-8601 value
- **THEN** the command exits 2 with the offending value named

#### Scenario: Replayed counts come from the audit trail
- **WHEN** replay audit entries exist in the window
- **THEN** the totals line reports the `replayed` count

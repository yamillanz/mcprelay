## ADDED Requirements

### Requirement: Batch replay

`mcprelay replay run --all` SHALL redrive pending records in batch, selected with the `list` filters (`--tool`, `--correlation-id`, `--since`, `--until`, `--limit`; default limit 50, maximum 500). Selection SHALL always be `status: pending`. `--dry-run` SHALL inspect each selected record with zero upstream `tools/call`; `--force` SHALL apply to every selected record; `--json` SHALL emit one machine-readable summary. `--set` with `--all` and a positional record id with `--all` SHALL be usage errors. Execution SHALL be sequential, and each record SHALL pass through the same guard → claim → attempt → persist sequence as `run <id>`, so concurrent batch runs — or a batch plus a single run — SHALL never execute the same record twice. A record that fails a guard or is claimed elsewhere SHALL be reported and skipped, remaining pending.

#### Scenario: Batch selects pending records with filters
- **WHEN** `run --all --tool X --since <iso>` runs
- **THEN** exactly the pending records matching the filters are attempted, in index order

#### Scenario: Batch and single forms are mutually exclusive
- **WHEN** `run --all` is combined with `--set` or with a positional id
- **THEN** it is a usage error and nothing is executed

#### Scenario: Batch dry-run makes no upstream calls
- **WHEN** `run --all --dry-run` runs
- **THEN** every selected record is inspected, the upstream receives no `tools/call`, and the records remain pending

#### Scenario: Per-record outcomes and summary
- **WHEN** a batch completes
- **THEN** each record reports its outcome and a summary line reports selected, ok, failed, and skipped counts

#### Scenario: Exit codes are CI-meaningful
- **WHEN** a batch completes with every attempted record successful (or with no matching records)
- **THEN** it exits 0; when any record failed or was skipped it exits non-zero

#### Scenario: Concurrent batches never double-execute
- **WHEN** two `run --all` invocations (or a batch and a single run) race for the same pending record
- **THEN** the record is executed at most once and the loser reports it as claimed/skipped

#### Scenario: JSON summary is machine-readable
- **WHEN** `run --all --json` runs
- **THEN** the output is a single parseable JSON document with the summary and per-record outcomes

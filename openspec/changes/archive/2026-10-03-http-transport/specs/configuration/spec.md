## ADDED Requirements

### Requirement: Upstream HTTP section and the HTTP run flag

The config SHALL accept an `upstream` section with `http.headers` (a mapping of header name to string value) and strict key checking; malformed headers SHALL fail with the config path and field. The headers are the middleware's own upstream credentials and apply to every HTTP upstream request. `run --http <url>` SHALL be accepted as the HTTP upstream form, mutually exclusive with the stdio `-- <server command…>` form.

#### Scenario: Configured headers are parsed
- **WHEN** the config sets `upstream.http.headers`
- **THEN** the session uses them for upstream HTTP requests

#### Scenario: Malformed headers fail with path and field
- **WHEN** `upstream.http.headers` is not a mapping of strings
- **THEN** startup fails naming the config path and the offending field

#### Scenario: The HTTP flag is accepted
- **WHEN** `run --http <url>` runs
- **THEN** the session starts against the remote endpoint

#### Scenario: Conflicting upstream forms are a usage error
- **WHEN** `run` receives both `--http <url>` and `-- <server command…>`
- **THEN** it exits with a usage error and starts nothing

#### Scenario: Zero-config stays unchanged
- **WHEN** no config file exists
- **THEN** the stdio form works with the documented defaults and the HTTP section is absent

## ADDED Requirements

### Requirement: Caller identity resolution

The middleware SHALL resolve one caller identity per intercepted `tools/call` from the `identity` config: `profile` (the name for this stdio wrap, default `local`) and `keys` (static API keys mapped to identities). A credential presented in `_meta.authorization` with the `Bearer <key>` shape SHALL resolve to its mapped identity when the key store is non-empty; otherwise the profile applies. `run --identity <name>` SHALL override the configured profile for the session. The resolved identity SHALL feed policy evaluation (the `caller` matcher), the FR-O1 log line, call events (`report` attribution), and `FailureRecord.caller`.

#### Scenario: Profile identity is the caller
- **WHEN** a session runs with `identity.profile: reviewer-bot` and a call arrives without a credential
- **THEN** the log line, call event, and any captured record carry caller `reviewer-bot`, and a policy rule matching `caller: reviewer-bot` applies to it

#### Scenario: A presented key maps to its identity
- **WHEN** `identity.keys` maps a key to `agent-a` and a call presents `_meta.authorization: Bearer <that key>`
- **THEN** the call's caller is `agent-a` in the log line, call events, and records, and `report` attributes the call to `agent-a`

#### Scenario: Zero-config keeps the local default
- **WHEN** no `identity` section exists and no credential is presented
- **THEN** the caller is `local`, exactly as before this change

#### Scenario: The CLI flag overrides the file
- **WHEN** `run --identity ci-bot` runs against a config with a different profile
- **THEN** the session's caller identity is `ci-bot`

#### Scenario: Identity is resolved once per call
- **WHEN** an intercepted call is relayed
- **THEN** exactly one resolution happens per call and the identity is shared by policy, logging, persistence, and capture

### Requirement: Credential validation at the edge

When `identity.keys` is non-empty, a presented credential that matches no key SHALL be rejected before the upstream: the client receives a standard MCP error with code `-32003`, a `denied` audit entry is written with `detail.action = 'auth'`, the log line reports decision `denied`, and the call SHALL NOT be forwarded and SHALL NOT enter the DLQ. The error message SHALL NOT echo the credential. The log, audit, and call-event caller for a rejected call SHALL be the reserved identity `unauthenticated`. When `identity.keys` is empty, presented credentials SHALL NOT be accepted as identity (the profile applies) and SHALL NOT cause a rejection.

#### Scenario: An unrecognized key is rejected
- **WHEN** a key store is configured and a call presents an unknown `Bearer` credential
- **THEN** the call fails with `-32003`, the upstream receives no `tools/call`, an audit entry records the auth denial, and no DLQ record is written

#### Scenario: The rejection does not leak the credential
- **WHEN** a call is rejected for an unrecognized credential
- **THEN** the error message, log line, and audit entry contain no part of the credential value

#### Scenario: No key store means no rejection
- **WHEN** `identity.keys` is empty and a call presents a credential
- **THEN** the profile identity applies and the call proceeds normally

#### Scenario: Rejected traffic is attributable
- **WHEN** a call is rejected for an unrecognized credential
- **THEN** its call event carries caller `unauthenticated` with decision `denied`, visible in `report`

### Requirement: No credential passthrough

Client credentials SHALL never reach an upstream server: the credential field (`authorization`, case-insensitive) SHALL be removed from `_meta` before any relay — stdio stdin or HTTP body — while every other `_meta` key (correlation, OTel trace context, progress tokens) SHALL pass through unchanged. Credentials SHALL NOT be written to logs, call events, audit entries, or `FailureRecord`s, and upstream HTTP headers SHALL remain the middleware's own `upstream.http.headers` only.

#### Scenario: The upstream body carries no credential
- **WHEN** a call presenting `_meta.authorization` is forwarded to an HTTP upstream
- **THEN** the upstream's received parameters contain no credential, and configured `upstream.http.headers` still apply

#### Scenario: A stdio upstream never sees the credential
- **WHEN** a call presenting `_meta.authorization` is forwarded to a stdio upstream whose tool echoes `_meta`
- **THEN** the echoed `_meta` contains no credential and other `_meta` keys are intact

#### Scenario: Credentials are never persisted or logged
- **WHEN** a call presenting a credential is allowed, denied, failed, or rejected
- **THEN** the log line, call event, audit entry, and any captured record contain no credential value

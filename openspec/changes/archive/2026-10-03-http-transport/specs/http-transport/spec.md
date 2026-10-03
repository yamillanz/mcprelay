## ADDED Requirements

### Requirement: Streamable HTTP upstream wrapping

`mcprelay run --http <url>` SHALL wrap a remote Streamable HTTP MCP server 1:1: the client side remains stdio, the upstream runs unmodified and unaware, and the client-facing session mirrors the upstream's identity, capabilities, and instructions. `--http <url>` and the stdio form (`-- <server command…>`) SHALL be mutually exclusive; invoking neither or both SHALL be a usage error.

#### Scenario: HTTP upstream completes a session
- **WHEN** the middleware wraps a Streamable HTTP server and a client initializes
- **THEN** the client sees the upstream's server info, capabilities, and tool inventory

#### Scenario: Transport forms are mutually exclusive
- **WHEN** `run` receives both `--http <url>` and `-- <command>`, or neither
- **THEN** it exits with a usage error and starts nothing

### Requirement: The pipeline is transport-agnostic

Interception, policy, retry classification, redacted DLQ capture, logging, and replay SHALL behave identically over an HTTP upstream: `tools/call` is the only method with intercepted semantics, `tools/list` is never filtered, denials are enforced and audited without being forwarded, and failures are captured with their D4 class.

#### Scenario: Policy denial over HTTP
- **WHEN** a policy rule denies a tool on an HTTP upstream
- **THEN** the client receives the denial error, an audit entry is written, and the upstream receives no `tools/call`

#### Scenario: tools/list stays unfiltered over HTTP
- **WHEN** a tool is denied by policy
- **THEN** `tools/list` still includes it

#### Scenario: Failure capture over HTTP
- **WHEN** a call fails against the HTTP upstream
- **THEN** a FailureRecord is captured with `server.transport: http` before the client sees the error

#### Scenario: Connection failures retry, HTTP responses follow D4
- **WHEN** the HTTP endpoint is unreachable, or responds with a server error after the request arrived
- **THEN** an unreachable endpoint is a pre-execution transport failure (retryable), and a post-arrival HTTP error follows the taxonomy (no auto-retry for non-idempotent tools; timeouts auto-retry only with `idempotent: true`)

### Requirement: Batch-frame boundary over HTTP

JSON-RPC batch frames SHALL remain a stdio-only passthrough: over an HTTP upstream the middleware SHALL answer the batch with a single JSON-RPC error naming the limitation, and SHALL NOT forward it. The stdio behavior (verbatim relay) SHALL stay unchanged.

#### Scenario: Batch over HTTP is rejected with a clear error
- **WHEN** a client sends a JSON-RPC batch frame while the upstream is HTTP
- **THEN** the client receives a JSON-RPC error stating that batch frames are not supported over an HTTP upstream, and the upstream receives nothing

#### Scenario: Batch over stdio still relays verbatim
- **WHEN** a client sends a JSON-RPC batch frame while the upstream is stdio
- **THEN** the batch is relayed verbatim as before

### Requirement: Upstream credential boundary

Upstream HTTP requests SHALL carry only the configured `upstream.http.headers` plus transport-managed headers. Client-supplied values SHALL NOT be forwarded as upstream headers (FR-A3, no token passthrough), and configured header values SHALL never appear in logs or persisted records.

#### Scenario: Configured headers reach the upstream
- **WHEN** `upstream.http.headers` is configured
- **THEN** the upstream receives those headers on its requests

#### Scenario: Client tokens are not forwarded
- **WHEN** a client call carries credential-like `_meta` values
- **THEN** the upstream request headers contain none of them

#### Scenario: Header values are never persisted
- **WHEN** a call against an HTTP upstream fails and is captured
- **THEN** no configured header value appears in the queue or store databases

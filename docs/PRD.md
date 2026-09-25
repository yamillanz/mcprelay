# PRD — `mcprelay`: The Reliability Layer for MCP Tool Calls

| | |
|---|---|
| **Status** | DRAFT — v0.6 (see document history) |
| **Date** | 2026-09-25 |
| **Author** | Yamill Anz (@yamillanz) |
| **Name** | `mcprelay` (decided 2026-09-25) |
| **License** | MIT |
| **Stack** | TypeScript / Node.js ≥ 20, official MCP TypeScript SDK |
| **Method** | Spec-driven (OpenSpec). Each milestone in §12 becomes one `openspec/changes/<id>/` (proposal → design → delta specs → tasks; the infra-only M0 carries proposal + tasks, no deltas). |

> One-liner: **Middleware that sits between MCP clients and MCP servers and gives tool calls what production systems take for granted — policies, observability, and a dead-letter queue with replay.**

---

## 1. Executive Summary

Every team that puts an MCP server in front of an agent rewrites the same plumbing from scratch: which tools may this agent call, what happened when the call failed, who called what, and how do I safely re-run the call that died. The MCP spec standardizes the conversation between clients and servers — it says nothing about what happens when that conversation fails, and by its own text cannot enforce tool-level security (§5.1).

This project is a **transparent middleware** (a local-first proxy/gateway) that wraps any stdio MCP server and adds four layers around `tools/call`:

1. **Proxy** — speaks MCP on both sides; the upstream server never knows the middleware exists.
2. **Reliability** *(the differentiator)* — timeouts, retry with backoff, and a **dead-letter queue (DLQ) with replay**: failed tool calls are captured with full context, inspectable, and re-executable — the SQS/DLQ operational model applied to tool calls. Replay re-executes for the side effect; its result lands in the audit trail, because the original caller's session is gone (see *What replay means* below).
3. **Policy** — declarative YAML allow/deny per tool and per argument, with a `--dry-run` mode.
4. **Observability** — structured logs and per-tool metrics (latency, error rate, payload size, caller), reportable from the CLI.

Infrastructure is **pluggable ("bring your own queue")**: the DLQ lives behind a `QueueProvider` port with a zero-dependency **SQLite** adapter by default and a **RabbitMQ** adapter (dead-letter exchange topology) for real message-queue deployments. **100% open-source stack** — no SaaS, no cloud dependency, runs fully offline.

### The 60-second demo (the README hook)

> 1. Wrap a real MCP server: `npx mcprelay -- npx @modelcontextprotocol/server-filesystem .`
> 2. An agent calls a tool; policy blocks one call (`dry-run` shows it first).
> 3. Another call fails (upstream timeout) → retries with backoff → still failing → **lands in the DLQ** with arguments, error, attempts, correlation id.
> 4. `mcprelay replay --dry-run` → inspect → `mcprelay replay <id>` → the call re-executes, the **side effect lands** (the file is written / the issue is created), and the audit entry captures the replay's own result — the original caller is long gone, so the audit trail is where the outcome lives.
> 5. `mcprelay report` shows per-tool latency and error rates.

This flow is the GIF in the README and the acceptance test of the whole product.

### What replay means (the honest semantics)

A replayed call's response cannot be delivered to the agent that made it — that session is over. Replay is **redrive for side effects**: the call re-executes upstream, its (redacted) result or error is captured into the audit entry linked to the original record (FR-R4), and that audit trail is the **only place a replay's outcome can ever be inspected**. Read-only tools are rarely worth replaying (their only value was the response); the optional per-tool `effects: read` hint makes `replay --dry-run` say so. The demo ends on the visible side effect for exactly this reason — the side effect is the payoff, not the audit link alone.

---

## 2. Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **100% open-source stack** | Every runtime dependency is permissively licensed (MIT / Apache-2.0 / BSD / ISC). No feature requires a SaaS or cloud service. Full functionality offline. |
| P2 | **Local-first defaults** | `npx` one-liner works with zero infrastructure. SQLite is the default queue/store. Real MQ (RabbitMQ) is opt-in via config. |
| P3 | **Zero intrusion** | The upstream MCP server runs unmodified and unaware. No SDK patching, no fork, no sidecar code inside the server. |
| P4 | **Pluggable ports, capped scope** | Exactly two extension ports in v1: `QueueProvider` and `Store`. Everything else is closed. No general plugin system. |
| P5 | **Minimal dependency footprint** | Prefer Node built-ins; every third-party dependency must justify itself. |
| P6 | **Evidence over promises** | Each milestone ships only when it works against a real MCP server. Specs (OpenSpec) precede code; ADRs record real trade-offs. |

---

## 3. Problem & Opportunity

**The problem.** Tool calls are the point where an agent's reasoning becomes real side effects — file writes, API calls, transactions — and today that point is governed by nothing:

- **No permission layer.** Any agent connected to an MCP server can call any tool with any arguments. Prompt injection turns into `rm -rf` (see the Invariant Labs GitHub heist and filesystem-server CVEs).
- **No failure story.** A tool call that times out or errors is simply lost — the agent may see the error and muddle through, but afterwards there is nothing to inspect, no record of what was attempted with which arguments, and no way to re-run the side-effecting call that died at 3 a.m. No dead-letter queue, no inspection, no replay. Teams that know event-driven systems (SQS + DLQs) know exactly what is missing; the MCP ecosystem has not imported that discipline.
- **No observability.** Which tool is slow? Which agent is erroring? What did the model actually call last Tuesday? Nobody logs per-tool-call metrics by default.
- **Every team rewrites it.** Permissions, logs, retries, audit — re-implemented per project, usually as afterthoughts.

**The opportunity.** The MCP spec standardized the *protocol*; the *operational layer* around it is being built right now, in the open, and the reliability niche inside it is still empty (§5). This project claims that niche with a DLQ design descended from proven message-queue operational patterns (SQS-style redrive), shipped as a spec-first open-source artifact.

---

## 4. Target Users & Use Cases

### Primary persona (v1)

**Solo developer / small team, local-first.** Runs MCP servers locally for Claude Desktop, OpenCode, Cursor, VS Code, or a custom agent. Wants guardrails and a failure story without operating infrastructure.

- Launches the middleware with one command per server (1:1 wrap).
- Default everything: SQLite file next to the config, YAML in the project root.
- Opts into RabbitMQ only when they already run it (or want the real-MQ semantics).

### Secondary persona (roadmap)

Platform/infra engineer deploying MCP servers for a team — HTTP transport, API keys/JWT, Postgres store, Prometheus endpoint. Served after v1 (§10, §12).

### First integration targets

| Target | Role |
|---|---|
| `@modelcontextprotocol/server-filesystem` | Canonical real server for the README demo |
| 2–3 additional public servers (e.g. GitHub, fetch) | Example recipes in `/examples` |
| A minimal custom tool server (bundled under `/examples`) | Hermetic integration test #1 — deterministic failures for the DLQ demo |

### Core use cases

- **UC1 — Guardrail:** "My agent should read files but never delete them." Policy allow/deny + argument constraints; `--dry-run` before enforcing.
- **UC2 — Failure capture:** "A tool call failed during a long agent run. I don't want to lose it." Call is retried, then captured in the DLQ with full context.
- **UC3 — Replay:** "The upstream dependency is healthy again. Re-run the failed calls." `replay --dry-run` → `replay` → the side effect lands and the audit trail records what was re-executed with the replay's result captured — the agent session that made the call is gone (*What replay means*, §1).
- **UC4 — Answer "what happened?":** Per-tool latency, error rate, caller attribution via `report` and structured logs.

---

## 5. Positioning & Differentiation

### Positioning statement

> **For** developers running MCP servers in front of agents **who** lose tool calls to failures and have no policy or audit trail, **`mcprelay`** is a **local-first MCP middleware** **that** captures failed tool calls into a dead-letter queue and replays them, with per-tool policies and observability — **unlike** policy/audit proxies and enterprise gateways, **it** makes the failure path (retry → DLQ → replay) the core product and lets you plug in your own queue backend (SQLite or RabbitMQ).

### Competitive landscape (scanned 2026-09)

| Project | Stack | What it does | Gap we exploit |
|---|---|---|---|
| `microsoft/mcp-gateway` (~800★) | .NET/TS, K8s | Enterprise reverse proxy, control plane, Entra ID, portal | K8s/enterprise orchestration; not local-first; no DLQ/replay |
| `P4ST4S/mcp-audit` | Go | Audit proxy: signed logs, redaction, allow/deny, rate limits | Audit-first; explicitly avoids retrying `tools/call`; no DLQ/replay |
| `rsh1k/mcp-gate` | Python | Policy firewall, hash-chained audit, NIST/OWASP mapping | Security-first; no failure-capture/replay workflow |
| `mcpgatehq/gateward` | Python | 12 built-in security rules, stdio only | Fixed rules, no config; no reliability layer |
| `JinBeiCN/mcp-gateway` | Go | Auth, RBAC, rate limits, prompt-injection detection | Security-first; no DLQ |
| `kgeg401/mcp-guard` | Go | Policy, redaction, signed audit, `replay --id` | Replay exists but is audit-integrity oriented (Go); no retry/backoff pipeline, no pluggable queue |
| `yogesh895/gate-mcp` | Node | Control plane + admin UI, multi-tenant, human approval | Heavy enterprise scope; no DLQ/replay |
| `bentabol/mcp-retry` | Python | Retry, idempotency dedup, cache, circuit breaker | Resilience only (no policy/audit/DLQ); not TS; no replay store |
| `CK-Rajput/mcp-resilient` | Python | Retry/circuit-breaker decorator, fallback chains | Library-level, client-side; no DLQ store/replay |
| `mcp-replay` (×2) | TS/Go | Record/replay for **tests** (nock/msw for MCP) | Testing fixtures — different product from operational replay |
| `mcpgateway.com`, `mcptrail.com` | Commercial | Full gateways (observability/DLP/policy) | SaaS/commercial; not OSS, not local-first |

**The niche that is still empty (as of 2026-09):** *operational* dead-letter capture + inspection + replay of failed tool calls, as the core of a product, **in TypeScript**, **local-first**, with **pluggable real-MQ backends**. "Replay" today means test fixtures; nobody owns the failure path.

### Differentiators (headline order)

1. **DLQ + replay is the product** — not a feature footnote. The mental model is SQS redrive, applied to `tools/call`.
2. **Bring your own queue** — `QueueProvider` port: SQLite (zero-infra) or RabbitMQ (dead-letter exchange). Competitors hard-wire their own stores.
3. **TypeScript, on the official MCP SDK** — npm-native (`npx` one-liner), the ecosystem where MCP clients live; most rivals are Go/Python.
4. **Policy + observability included** — enough to be the one middleware you run, deliberately *not* an enterprise security suite (§10).
5. **Spec-first, ADR-driven** — the repo itself is the architecture evidence.

### 5.1 Where the MCP spec's security ends and we begin

The MCP specification **does** define security — but at the **connection** layer, not the **execution** layer. Knowing the boundary is the positioning:

| Layer | Defined by | Coverage |
|---|---|---|
| Transport authorization (HTTP) | MCP spec 2026-07-28, **OPTIONAL** | OAuth 2.1 + PKCE (S256), RFC 8707 audience binding, RFC 9728 protected-resource discovery, short-lived tokens; **token passthrough explicitly forbidden**. Applies to HTTP transports only |
| Transport trust (stdio) | OS process model | Spec says stdio **SHOULD NOT** use its auth model — "retrieve credentials from the environment". No protocol-level auth at all |
| Tool-execution governance | **Nobody — this project's gap** | Which tool may run with which arguments; what happens when a call fails; who called what; capture & replay |

The spec admits the gap itself (Security & Trust & Safety): *"Tools represent arbitrary code execution and must be treated with appropriate caution… **While MCP itself cannot enforce these security principles at the protocol level**, implementors SHOULD…"* — consent, least privilege, and auditability are delegated to hosts and middleware.

The protocol is also moving **away** from delivery guarantees: the 2026-07-28 revision made the core stateless and **removed SSE resumability/redelivery**. Failed-call recovery is, by design, outside the wire protocol — the same line SQS draws between *messaging* and *what happens on failure*. That is precisely the layer this middleware implements.

**Alignment with the roadmap (next spec releases)** — we build on the protocol, never against it:

- **Agent Identity & DPoP** (2026 roadmap priority): when standardized, agent identity becomes the caller dimension of policy (FR-Y1). Our FR-A implements the spec's OAuth 2.1 resource-server rules; as a proxy we never pass tokens through to upstream (spec-forbidden) — we validate at the edge and use our own upstream credentials.
- **ETags / caching for tool calls** (roadmap): the idempotency guard (FR-R5) and content hashes are designed to adopt the standard when it lands.
- **Standardized error handling** (roadmap): the retryable-error taxonomy (D4) will map onto the spec's error surface when defined.
- **OpenTelemetry `_meta` conventions** (already in 2026-07-28: `traceparent`/`tracestate`/`baggage`): correlation in FR-O1/FR-P5 uses these keys when present, so the middleware fits into existing OTel pipelines instead of inventing its own trace model.

---

## 6. Architecture

### 6.1 Topology (v1: 1:1 transparent wrap)

```
   MCP client                 mcprelay (this project)                      MCP server
   ──────────                 ─────────────────────                        ───────────
   Claude Desktop  ──┐                                                  ┌── filesystem
   OpenCode        ──┼──▶  [auth] → [policy] → [proxy]  ────────────────┼── example server
   Cursor          ──┤         │           │          │                  └── any stdio server
   custom agent    ──┘         │           │          │
                               │           │          ├─▶ timeout / retry (backoff)
                               │           │          │         │
                               │           │          │         └─▶ exhausted ─▶ QueueProvider (DLQ)
                               │           │          │                        ├─ sqlite   (default)
                               │           │          │                        └─ rabbitmq (DLX ≈ SQS redrive)
                               │           │          │
                               │           │          └─▶ every call ─▶ Store (logs, metrics, audit)
                               │           │                               ├─ sqlite   (default)
                               │           │                               └─ postgres (later)
                               │           └─ allow/deny per tool + argument rules
                                └─ API keys → JWT (M9, mainly for HTTP)

   CLI: mcprelay run | replay | report | policy | validate
```

- **v1 scope is 1:1**: one middleware process wraps one upstream server command (the `gateward`/`mcp-proxy` UX). Multi-server aggregation/routing (the `meta-mcp`/Microsoft territory) is explicitly out of scope (§10).
- Streamable HTTP transport (1:1 toward a remote server) lands in **M6** (§12); stdio is the v1 core.

### 6.2 Ports & adapters ("bring your own queue")

```ts
// The two — and only two — extension ports of v1.

interface QueueProvider {                 // DLQ + replay substrate
  enqueue(rec: FailureRecord): Promise<string>;       // durable write BEFORE the client sees the error
  list(f?: FailureFilter): Promise<FailureRecord[]>;
  get(id: string): Promise<FailureRecord | null>;
  resolve(id: string, outcome: ReplayOutcome): Promise<void>;
  purge(f: FailureFilter): Promise<number>;
  health(): Promise<HealthStatus>;
}

interface Store {                          // call history, metrics, audit
  recordCall(ev: CallEvent): Promise<void>;
  metrics(f: MetricsFilter): Promise<ToolMetrics[]>;
  audit(entry: AuditEntry): Promise<void>;
}
```

| Port | v1 adapters | Later (documented extension points) |
|---|---|---|
| `QueueProvider` | `sqlite` (default, embedded), `rabbitmq` (durable DLQ via dead-letter exchange) | Redis (BullMQ/Streams), NATS JetStream, ElasticMQ (SQS-compatible) |
| `Store` | `sqlite` (default) | `postgres` |

Config selects providers (see FR-C1). Adding an adapter MUST NOT require changes to core logic.

**Known impedance (D5, M7 design.md):** the port's `list`/`get` are store semantics — AMQP has no query. The RabbitMQ adapter must define them (metadata mirror vs. peek-via-requeue with an atomic `resolve()` guard vs. durable-record + event publish), and whether v1 needs a full DLX topology at all (backoff runs in-process) or a durable direct queue suffices. ADR required.

### 6.3 The call pipeline (every `tools/call`)

```
receive → identify caller → policy check (allow/deny/args)
        → forward with timeout
        → on transient failure: retry w/ exponential backoff + jitter (bounded attempts,
              class-gated per FR-R2: timeouts auto-retry only for idempotent tools)
        → on client cancellation (notifications/cancelled): abort in-flight attempt,
              stop retrying, no DLQ — logged as decision `cancelled` (FR-R2)
        → on success: record CallEvent → return result
        → on exhaustion / non-retryable / timeout:
              enqueue FailureRecord (redacted args, error, attempts, correlation id)
              return standard MCP error to client
        → replay path: queue.list/get → policy re-evaluation (--dry-run first)
                        → re-execute → resolve() → audit link original↔replay
                        → replay result (redacted) captured in the audit entry (FR-R4)
```

---

## 7. Functional Requirements

Requirements use RFC-2119 keywords. Each maps to one or more OpenSpec delta specs per milestone.

### FR-P — Proxy (transparent interception)

- **FR-P1** — The middleware SHALL wrap any stdio MCP server via a one-line invocation (`mcprelay -- <server command…>`) and present itself to the client as an ordinary MCP server.
- **FR-P2** — Protocol fidelity: JSON-RPC messages SHALL pass through semantically unchanged (all fields preserved) except for deliberate interception (`tools/call` handling, error wrapping, injected `_meta` correlation keys). The upstream server SHALL NOT require modification, recompilation, or awareness of the middleware.
  - *Acceptance:* the same client config works with and without the middleware; an unmodified public server (filesystem) completes a full session through the wrapper. Fidelity tests SHALL cover an explicit **passthrough matrix**: every client→server request/notification other than `tools/call` (e.g. `tools/list`, `resources/*`, `prompts/*`, `completion/*`, `logging/setLevel`, `notifications/initialized`), server→client requests (`sampling/createMessage`, `elicitation/create`, `roots/list`), `notifications/progress`, JSON-RPC **batch frames**, and `initialize` capability negotiation on both sides — `tools/call` is the only method with intercepted semantics.
- **FR-P3** — The middleware SHALL intercept `tools/call` as the control point for policy, reliability, and logging, and SHALL record `initialize` and `tools/list` for session context.
- **FR-P4** — Process hygiene: upstream stdout/stderr SHALL be handled so the client session behaves normally (server logs forwarded to stderr/log, never mixed into the protocol stream); upstream exit/crash SHALL surface as a clean transport error, and SHALL NOT corrupt DLQ/Store writes already made.
- **FR-P5** — Correlation: every intercepted call SHALL carry a generated `correlation_id` propagated into logs, metrics, FailureRecords, and replay audit links; when the client supplies OTel `traceparent`/`tracestate`/`baggage` in `_meta` (2026-07-28 conventions), these SHALL be preserved and logged alongside.
- **FR-P6** — Protocol revision: v1 SHALL target the 2026-07-28 revision via the official SDK v2 line. The middleware terminates MCP on both sides (an MCP server toward the client, an MCP client toward upstream), so each side negotiates its revision independently; older revisions SHALL work to the extent the SDK supports them on each side, and this boundary SHALL be documented (ADR).

### FR-R — Reliability (core; the differentiator)

- **FR-R1** — Timeout: each `tools/call` SHALL have a configurable timeout (global default + per-tool override). On expiry the call SHALL fail into the retry pipeline and ultimately return a standard MCP error to the client.
- **FR-R2** — Retry: transient failures SHALL be retried with exponential backoff and jitter, bounded by configurable max attempts (global + per-tool). Retry eligibility SHALL follow the failure-class taxonomy (D4; the class table is the M2 design.md deliverable):
  - **Pre-execution transport failures** (the request provably never reached the tool — spawn/connect/send failures) SHALL be retryable unconditionally.
  - **Post-execution failures** — upstream error responses and **timeouts** — may have side-effected already. A timed-out call SHALL be auto-retried only when the tool is marked `idempotent: true` (global + per-tool): a timeout does not mean "not executed".
  - **`isError: true` results** are completed calls — the tool executed and reported failure. Never auto-retried; logged and counted (FR-O); DLQ capture is opt-in per tool (class `tool_error`, Appendix A).
  - **`input_required` results** (`resultType: "input_required"`, spec 2026-07-28) are in-progress conversations, not failures: no retry, no DLQ; the follow-up `tools/call` with `inputResponses`/`requestState` passes through the same pipeline as one logical call.
  - **Non-retryable errors** (e.g. policy rejections, schema violations) SHALL NOT be retried.
  - **Client cancellation** (`notifications/cancelled` for the in-flight request) SHALL abort the in-flight upstream attempt, stop the retry pipeline, and SHALL NOT enter the DLQ — a cancelled call is not a failure. It is logged (decision `cancelled`, FR-O1) and counted in `report`.
- **FR-R3** — DLQ capture: when a call ultimately fails (attempts exhausted, timeout, or non-retryable), the middleware SHALL durably enqueue a `FailureRecord` **before** returning the error to the client, containing: tool name, redacted arguments, caller identity, error class/message, attempt count, timestamps, correlation id, and a content hash for idempotency (computed over **raw** arguments — NFR-4).
  - *Acceptance:* killing the middleware immediately after an error response leaves the record persisted; `replay` lists it after restart.
- **FR-R4** — Replay CLI: `mcprelay replay` SHALL support `list`, `inspect <id>`, `--dry-run` (re-evaluate policy/schema of the stored call **without** side effects), `run <id>` (re-execute; `run --all --filter …` lands with M7, §12), and SHALL write an audit entry linking original record ↔ replay attempt **that captures the replay's own (redacted) result or error** — the only place a replay's outcome can ever be inspected, since the original caller's session is gone (*What replay means*, §1). The optional per-tool `effects: read` hint SHALL make `--dry-run` warn that a read-only tool is rarely worth replaying.
  - *Acceptance:* the §1 demo flow completes on a real server and ends on the visible side effect; a `--dry-run` performs zero upstream calls; the replayed call's result is visible in its audit entry.
- **FR-R5** — Idempotency guard: replay SHALL detect duplicate side-effect risk (idempotency key via `_meta.idempotencyKey` — our own convention until the spec's ETags/caching work lands, §5.1 — or an args field, plus content hash) and SHALL warn/require `--force` to re-execute a call whose key was already successfully executed within the configurable dedup window.
- **FR-R6** — `QueueProvider` port (§6.2): DLQ persistence SHALL be provider-selected (`queue.provider: sqlite | rabbitmq`). Both adapters SHALL provide durable enqueue, list/get with filters, resolve/purge semantics, and an atomic `resolve()` so concurrent replay invocations cannot double-execute a record. The RabbitMQ topology (DLX `mcp.dlx`/`mcp.dlq` vs. direct durable queue) and its `list`/`get` implementation are the M7 design.md deliverable (D5); the goal is SQS-redrive-equivalent behavior.

### FR-O — Observability

- **FR-O1** — Every intercepted call SHALL emit one structured JSON log line: timestamp, correlation id (plus OTel trace context when present, FR-P5), caller, server, tool, decision (allowed/denied/failed/cancelled), latency_ms, payload sizes, attempt count, error (if any). Secrets SHALL be redacted per NFR-4.
- **FR-O2** — Per-tool metrics SHALL be persisted via the `Store` port: call count, error count/rate, latency p50/p95, payload size — attributable per caller and per tool.
- **FR-O3** — `mcprelay report` SHALL render those metrics for a time range in a human-readable table and in `--json` (CI-friendly). Denied/failed/cancelled/replayed counts SHALL be included.
- **FR-O4** *(stretch — its own change after M8)* — Optional Prometheus exposition endpoint (`/metrics`, OpenMetrics format) for users who scrape local services.

### FR-Y — Policy engine

- **FR-Y1** — Policies SHALL be declarative YAML: allow/deny by tool name (glob patterns), by caller identity (when known), with a configurable default action. Most specific match wins; ordering rules and the deterministic tie-break documented (M5 design.md — no undefined ties).
- **FR-Y2** — Argument rules SHALL constrain call arguments (v1 matcher set: `equals`, `in`, `prefix`, `regex`, `max_length`, numeric bounds) — e.g. `path` must stay under `/projects`, `url` must match an allowlist.
- **FR-Y3** — `--dry-run` (and `mcprelay policy test`) SHALL evaluate stored/ hypothetical calls against the current policy and print the decisions that *would* be enforced, without enforcement.
- **FR-Y4** — Denied calls SHALL return a standard MCP error to the client and a Store audit entry; they SHALL NOT be forwarded upstream and SHALL NOT enter the DLQ (a denial is not a failure); the `report` SHALL count them.
- **FR-Y5** — `tools/list` SHALL pass through unfiltered (v1): the agent sees the full tool inventory; denial happens at call time and is counted (FR-Y4). Hiding denied tools would be an invisible behavior change; revisit post-v1 behind an explicit opt-in. The README answers this explicitly — it will be asked.
- **FR-Y6** — Policy-engine hygiene: safe YAML parsing, ReDoS-bounded regex matching (input-length + execution budget), and the deterministic precedence of FR-Y1.

### FR-C — Configuration & CLI

- **FR-C1** — One YAML config file (default `./mcprelay.config.yaml`) SHALL configure policy, reliability (timeouts/retries), `queue` and `store` providers, logging, and redaction. CLI flags SHALL override file values. `mcprelay validate` SHALL check the config and report precise errors (path + message).
- **FR-C2** — Zero-config UX: running with no config file SHALL work with safe defaults (SQLite providers, deny-nothing policy with warning, retries on, redaction on).
- **FR-C3** — Command surface: `run`, `replay`, `report`, `policy`, `validate`, `version` — each with `--help`; exit codes SHALL be meaningful (0 ok, non-zero on validation failure / replay failure / denied-only runs per documented codes) for CI use.

### FR-A — Auth (deferred to M9; matters mainly for HTTP)

- **FR-A1** — The middleware SHALL support static API keys mapped to caller identities that feed policy decisions (header-based for the HTTP transport; profile-named identities for stdio).
- **FR-A2** *(stretch)* — JWT validation (OAuth2 resource-server style: issuer/JWKS, audience per RFC 8707) and mTLS as a further stretch. Where the MCP auth spec applies (HTTP transports), the middleware SHALL act as an OAuth 2.1 resource server per that spec rather than inventing a custom scheme.
- **FR-A3** — No token passthrough: bearer tokens received from clients SHALL be validated at the middleware edge and SHALL NOT be forwarded verbatim to upstream servers (spec-forbidden); upstream connections use the middleware's own credentials/identity. Agent-identity standards (roadmap DPoP/delegation work) SHALL be adopted when stabilized instead of custom identity schemes.

---

## 8. Non-Functional Requirements

| # | Requirement | Measure / acceptance |
|---|---|---|
| NFR-1 | **OSS-only dependencies** (P1) | Every runtime dep permissive (MIT/Apache-2.0/BSD/ISC); `npm ls` audit in CI; no feature requires network egress to a vendor service. |
| NFR-2 | **Zero intrusion** (P3) | Unmodified upstream server passes an end-to-end session (FR-P2 test). |
| NFR-3 | **Latency overhead** | Middleware overhead (policy + log + queue bookkeeping, excluding upstream) ≤ 5 ms p95 on the demo machine, measured by the committed benchmark script (`bench/`: N calls direct vs. through the middleware, same machine, p95 of the middleware-only delta); failure-path work (backoff) never blocks the success path. |
| NFR-4 | **Secrets redaction** | Configurable key patterns (`api_key`, `token`, `password`, `authorization`, `secret`, …) redacted in logs, FailureRecords, reports — and in error messages and replay/audit **result payloads**, which echo arguments back; applied before persistence. `arguments_hash` is computed over raw (unredacted) arguments for dedup stability; redacted values are what get persisted. |
| NFR-5 | **Durability** | DLQ enqueue completes before the client receives the error (FR-R3); middleware crash loses at most in-flight upstream calls, never already-captured records. |
| NFR-6 | **Portability** | Linux + macOS first-class; Windows best-effort (stdio spawn semantics documented); Node ≥ 20. |
| NFR-7 | **DX** | One-line start; complete `--help`; config errors actionable; README quickstart works verbatim. |
| NFR-8 | **Testability** | Policy + pipeline + sqlite adapter hermetic in CI; RabbitMQ adapter tested against a real broker via Docker Compose (CI job or documented local step). |
| NFR-9 | **Local concurrency & growth** | SQLite files shared safely across the middleware process(es) and the `replay` CLI (WAL + busy_timeout; several wrapped servers may share `./.mcprelay/`); Store growth bounded by configurable retention (default 30 days of CallEvents; cleanup documented). |

---

## 9. Success Metrics

### Gating (milestone exit criteria)

- §1 demo flow (call → deny → fail → DLQ → replay → report) passes on a real server — ending on the visible replayed side effect — and is recorded as the README GIF.
- `docker compose up` demo (middleware + RabbitMQ + example server) works from M7 on.
- CI green on every PR: tests, typecheck, lint, config-validation smoke.
- Package published to npm and runnable via `npx mcprelay`.
- ≥ 3 documented examples with public MCP servers in `/examples`.
- Zero-intrusion proof test (FR-P2) in the suite.

### Community & visibility (non-gating)

- Repo public **from M2** with real commit history (developed in the open, not a finished-dump); first **usable** release — real npm publish + working `npx mcprelay` README hook — at **M4**.
- README: one-liner, 60s GIF, architecture diagram, design decisions (3–4 ADRs with rejected alternatives).
- Launch post: *"Why your agent's tool calls need a dead-letter queue"* (with the DLQ GIF).
- Listings: PRs to `awesome-mcp-servers` lists; post in r/MCP + MCP Discord showing the problem, not the repo.
- README quickstart leads with the **client-config snippet** (Claude Desktop / OpenCode / Cursor wrapping one server) — the persona's real install path; the bare CLI demo is secondary.
- README answers the two questions it will definitely get: `tools/list` visibility (FR-Y5) and replay semantics (*What replay means*, §1).
- The README competitive table carries per-row repo links (falsifiable scan); star counts re-verified at publish time.

### Aspirational (tracked, not gating)

Stars, npm downloads, community adapters (Redis/NATS), external contributors. Nice-to-have; explicitly not a success criterion for v1.

---

## 10. Out of Scope (v1)

| Excluded | Why | Where it belongs |
|---|---|---|
| Web dashboard / admin UI | Scope; CLI-first is the product | Maybe v2 |
| Multi-tenant / SaaS control plane | Local-first positioning | Enterprise forks |
| Multi-server aggregation & routing (1:N gateway) | Different product; crowded (`meta-mcp`, Microsoft) | v2+ if ever |
| General plugin system | P4 — only the two ports | — |
| K8s/operator/enterprise deployment tooling | Not the user | `microsoft/mcp-gateway` |
| Prompt-injection / content scanning | Security-suite scope | `gateward`, `mcp-gate` |
| Schema-drift scanning of tool definitions | Different problem | `mcp-sentinel` (schema-drift variant) |
| Postgres store, Redis/NATS/ElasticMQ queue adapters | Deferred adapters (documented extension points) | v1.1 / community |
| OAuth2 provider implementation, mTLS | Stretch, tied to HTTP auth | M9 stretch |

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Crowded market** (10+ projects, 2025–26 wave) | Differentiation erodes | Reliability-first discipline (§5): DLQ+replay stays the headline; competitive table lives in the README; do not rebuild `mcp-audit` features. |
| **Scope creep via adapters** | Missed deadlines | Hard cap: 2 ports, 2 queue adapters, 1 store adapter in v1. New adapters = post-v1. |
| **Maintainer bandwidth** (solo, part-time) | Half-finished repo is worse than none | 3-week cut rule: if the repo is not public after 3 weeks of part-time work, stop polishing and cut scope to the **M0–M4 spine** (proxy + logs + retry + DLQ + replay, SQLite) and ship it. A public M4 (per §9) beats M0–M10 half-done |
| **MCP spec/SDK churn** (spec 2026-07-28, SDK v2 line; roadmap: Agent Identity/DPoP, ETags for tool calls, standardized errors) | Protocol fidelity breaks; future spec features duplicate parts of the middleware | Pin SDK version; fidelity tests (FR-P2); **track-and-adopt policy** (§5.1): when spec features land (identity, ETags, error taxonomy), our policy/idempotency/error layers adopt them instead of keeping custom equivalents. The execution-governance gap (DLQ/replay/audit) is *not* on the spec roadmap |
| **Replay & retry side effects** | Duplicate writes in upstream systems | Dry-run by default UX, idempotency guard (FR-R5), timeout-retry gated on per-tool `idempotent` (FR-R2), result-capturing audit links (FR-R4), explicit warnings. |
| **Name squatting** (`mcprelay` verified free 2026-09-25; the space is crowded — `mcp-sentinel`, `mcp-gateway`, `toolgate` are all taken; names are claimed weekly) | Lose the name / discoverability | **Reserve immediately, not at publish:** npm placeholder publish at M0 (real publish at M4, §9); GitHub repo (`github.com/yamillanz/mcprelay`) already exists — pushed and public by M2, or earlier if the 3-week rule triggers; npm scope fallback (`@yamillanz/mcprelay`) if the bare name is claimed first |

---

## 12. Roadmap

Each milestone is an OpenSpec change (`openspec/changes/<id>/`), is independently publishable, and exits against its acceptance criteria. **Change-sizing rule:** one change = one capability, one demo beat, ≤ ~4 FRs — if a change grows past that, split it. Infra-only changes (M0) carry proposal + tasks but no delta specs — they change no capability (if `openspec validate` rejects delta-less changes, M0 runs as a plain chore instead; decided at M0 kickoff).

| # | OpenSpec id | Deliverable | Exit criteria | Est. |
|---|---|---|---|---|
| **M0** | `bootstrap` | Repo scaffold: strict TS, build, vitest, lint/format; **`openspec init`** + `project.md` (PRD = product truth); CI incl. `openspec validate`; ADR-0001 (repo layout); LICENSE; CLI skeleton (`--help`, `version`, exit codes); **npm placeholder publish** (name reservation, §11) | Clean clone → `npm install && npm test` (smoke) green; `openspec validate` clean; `mcprelay --version` runs; npm name reserved | 1 n |
| **M1** | `proxy-stdio` | Transparent stdio proxy + structured logs: FR-P1–P6, FR-O1; `run` command | Demo step 1 on a real server; FR-P2 fidelity matrix green; logs readable | 2–3 n |
| **M2** | `retry-pipeline` | Timeout + retry with the D4 failure-class taxonomy (cancellation, `isError`, `input_required`, timeout⇄`idempotent`); config file + CLI flags (FR-C begins) | D4 class table tested; flaky server retried; cancelled calls not retried | 1–2 n |
| **M3** | `dlq-sqlite` | DLQ capture: `QueueProvider` port + SQLite adapter (FR-R3, FR-R6); hash-raw/redact-persist (NFR-4/5); Store port + audit; `replay list/inspect`; `validate` completes FR-C1/C2 | Demo step 3; durability test (NFR-5): kill-after-error leaves the record | 2 n |
| **M4** | `replay-cli` | Replay: `--dry-run`/`run <id>`, result capture, dedup/`--force` (FR-R4–R5), atomic `resolve()`; **first public release: repo public + real npm publish + honest README** | Demo step 4, ending on the visible side effect; `npx mcprelay` works from npm | 2 n |
| **M5** | `policy-engine` | Policy: FR-Y1–Y6; `policy test` | Demo step 2 (block + dry-run); policy suite green | 3 n |
| **M6** | `http-transport` | Streamable HTTP toward remote servers (same pipeline) | Filesystem + one remote server under the same policy/DLQ config | 2 n |
| **M7** | `rabbitmq-batch` | RabbitMQ adapter (D5 topology); batch replay (`run --all --filter`); `docker compose up` demo | Same DLQ/replay flow over `queue.provider: rabbitmq`; concurrent replay safe (atomic `resolve()`); compose demo reproducible | 3–4 n |
| **M8** | `metrics-report` | FR-O2–O3: per-tool metrics in Store; `report` (table + `--json`); retention (NFR-9). FR-O4 (`/metrics`) = its own post-M8 change if wanted | Demo step 5 with real numbers; metrics match logs | 2–3 n |
| **M9** | `auth-identities` | FR-A1, FR-A3 (API keys → identities); FR-A2 (JWT) = post-M9 stretch | Identities feed policy decisions and `report` attribution | 2–3 n |
| **M10** | `release-1-0` | README w/ GIF + 3–4 ADRs; `/examples` (≥3 recipes); awesome-list PRs; launch post | All §9 gating metrics green | 1–2 n |

**CLI surface as it lands:** `version` (M0) → `run` (M1) → config flags (M2) → `replay list/inspect` + `validate` (M3) → `replay --dry-run/run` (M4) → `policy test` (M5) → `report` (M8).

**Total:** ≈ 21–27 nights ≈ 4–6 weeks part-time — same scope as the previous 7-milestone sketch; the split adds checkpoint ceremony, not work. The public-release path is M0–M4 (~8–10 nights), which is the unit the §11 3-week cut rule protects. Reorder rationale: the README hook (fail → DLQ → replay) ships at **M4**, not later — the differentiator is public as early as possible; HTTP moves after policy because its exit criteria already required policy/DLQ config.

---

## 13. How This PRD Feeds OpenSpec

1. This document is the **product truth** (what & why). Do not put implementation detail here — it lives in `design.md` per change.
2. Each milestone = one change: `openspec/changes/<id>/` (the *OpenSpec id* column in §12) with `proposal.md`, `design.md`, `specs/<capability>/spec.md` (delta, Given/When/Then), `tasks.md` (phased, with human approval gates).
3. FR-* requirements here map 1:1 to delta specs (e.g. `retry-pipeline` emits deltas covering FR-R1–FR-R2; `dlq-sqlite` covers FR-R3 + FR-R6; `replay-cli` covers FR-R4–FR-R5). Scenario-level detail is written in the specs, not duplicated here.
4. After each milestone is verified: `/opsx:archive` promotes deltas into `openspec/specs/`.
5. Notable design decisions (provider port shape, RabbitMQ topology, retry taxonomy, policy precedence) get ADRs in `docs/adr/` and are referenced from `design.md`.

---

## 14. Decisions

### Resolved

| # | Decision | Resolution | Date |
|---|---|---|---|
| D1 | **Final name** | **`mcprelay`** — repo `github.com/yamillanz/mcprelay`, npm package `mcprelay` (verified free 2026-09-25). Rationale: proxy/relay connotation fits the whole middleware (not just the DLQ); clean `npx mcprelay` UX | 2026-09-25 |

### Open

| # | Decision | Options | Recommendation | Needed by |
|---|---|---|---|---|
| D2 | Postgres `Store` adapter timing | v1.1 vs. stretch in M6 | v1.1 — keeps v1 cap (P4) honest | M6 |
| D3 | Argument-rule engine depth | Simple matchers (FR-Y2) vs. JSON-Schema subset | Simple matchers for v1; revisit if users demand schema | M3 kickoff |
| D4 | Retryable-error taxonomy | Client-supplied hints vs. heuristic classification | Heuristic class table covering: pre-execution transport vs. post-execution (upstream error / timeout), `isError: true` (no retry; opt-in capture), timeout⇄`idempotent` gating (FR-R2), per-tool override — the table itself is the M2 design.md deliverable | M2 design.md |
| D5 | RabbitMQ adapter `list`/`get` semantics & topology | Metadata mirror / peek-via-requeue + atomic `resolve()` / durable record + event publish; DLX vs. direct durable queue | The replay path is the only list/filter consumer — favor the simplest design that keeps replay correct and concurrent-safe; in-process backoff may make a plain durable queue sufficient | M7 design.md |

---

## Appendix A — FailureRecord shape (normative sketch)

```yaml
id: ulid
correlation_id: uuid
captured_at: iso8601
caller: { type: stdio|http, identity: string }
server: { name: string, command: string }
tool: { name: string, arguments_hash: sha256, arguments: {} }   # hash over raw args (NFR-4); persisted arguments redacted
failure: { class: timeout|upstream_error|transport|non_retryable|tool_error, message: string, attempts: int }
# tool_error = opt-in capture of isError:true results (FR-R2); cancelled calls are not failures and never enter the DLQ
replay: { status: pending|replayed|discarded, attempts: [], last_outcome: null }
# last_outcome = the replay's own (redacted) result or error — the only place a replay's outcome lives (FR-R4)
```

## Appendix B — Example config

```yaml
# mcprelay.config.yaml
queue:
  provider: sqlite                    # sqlite | rabbitmq
  sqlite: { path: ./.mcprelay/queue.db }
  rabbitmq: { url: amqp://localhost, exchange: mcp.dlx, queue: mcp.dlq }

store:
  provider: sqlite
  sqlite: { path: ./.mcprelay/history.db }

reliability:
  timeout_ms: 30000
  retry: { max_attempts: 3, backoff: exponential, base_ms: 250, jitter: true }
  replay: { dedup_window: 24h }        # FR-R5 idempotency window
  per_tool:
    slow_tool: { timeout_ms: 120000, retry: { max_attempts: 1 } }
    create_issue: { idempotent: true }  # FR-R2: timed-out calls auto-retry only for idempotent tools
    flaky_search: { effects: read }     # FR-R4: replay --dry-run warns on read-only tools

policy:
  default: allow                      # allow | deny
  rules:
    - { tool: "fs/delete_*", action: deny }
    - { tool: "fs/read_file", args: { path: { prefix: "/projects" } }, action: allow }
    - { tool: "http/fetch",   args: { url:   { prefix: "https://api.github.com/" } }, action: allow }

redaction:
  patterns: [api_key, token, password, authorization, secret, credential]
```

---

*Document history: v0.1 (2026-09-25) — initial draft; competitive scan of the 2026-09 ecosystem; positioning decisions (reliability-first, local-first, stdio-first, pluggable OSS providers). v0.2 (2026-09-25) — added §5.1 protocol-security boundary (MCP spec 2026-07-28 auth model + roadmap alignment), FR-P6 protocol revisions, FR-A3 no-token-passthrough, OTel `_meta` correlation, spec-churn track-and-adopt policy. v0.3 (2026-09-25) — product-only framing throughout (this document describes the solution, nothing about its origin context). v0.4 (2026-09-25) — D1 resolved: the project name is `mcprelay`. v0.5 (2026-09-25) — review pass (product + protocol + architecture): replay semantics made explicit — result → audit trail ("What replay means", §1), demo ends on the side effect, FR-R4 result capture; FR-R2 failure-class semantics (cancellation, `isError: true`, `input_required`, timeout⇄`idempotent`); FR-P2 passthrough matrix; FR-Y5/Y6; FR-R6 atomic resolve; D4 widened, D5 added (RabbitMQ `list`/`get` impedance); NFR-3 method, NFR-4 hash-raw/persist-redacted, NFR-9; batch replay moved M2 → M4; name reservation immediate; §11 cut rule harmonized with §9; Appendix A/B fixes. v0.6 (2026-09-25) — roadmap restructure for OpenSpec-sized changes: M0 `bootstrap` added (scaffold, `openspec init`, CI incl. `openspec validate`, ADR-0001, npm placeholder publish); old M2 split into `retry-pipeline` (M2) / `dlq-sqlite` (M3) / `replay-cli` (M4, = first public release with real npm publish); old M6 split into `auth-identities` (M9) and `release-1-0` (M10); HTTP moved after policy (M6); RabbitMQ + batch replay at M7; change-sizing rule + CLI-surface map added; cross-references updated (FR-R4→M7, FR-O4 post-M8, FR-A→M9, §9/§11 public-release timing, D5→M7).*

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';

import type { CallDecision } from '../observability/call-log.js';

export type { CallDecision };

/** Call history, metrics, and audit substrate (PRD §6.2). */
export interface Store {
  recordCall(event: CallEvent): Promise<void>;
  metrics(filter: MetricsFilter): Promise<StoreMetrics>;
  audit(entry: AuditEntry): Promise<void>;
}

/** One persisted call event per intercepted tools/call (mirrors the log line). */
export interface CallEvent {
  correlation_id: string;
  timestamp: string;
  caller: { type: 'stdio' | 'http'; identity: string };
  tool: string;
  decision: CallDecision;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
  attempt: number;
}

export interface MetricsFilter {
  since?: string;
  until?: string;
  tool?: string;
  caller?: string;
}

/** Per caller+tool aggregation row (FR-O2). */
export interface ToolMetrics {
  caller: string;
  tool: string;
  calls: number;
  errors: number;
  error_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  avg_request_bytes: number;
  avg_response_bytes: number;
}

export interface DecisionTotals {
  allowed: number;
  denied: number;
  failed: number;
  cancelled: number;
}

export interface StoreMetrics {
  tools: ToolMetrics[];
  decisions: DecisionTotals;
  replayed: number;
}

export interface AuditEntry {
  kind: string;
  correlationId?: string;
  failureId?: string;
  toolName?: string;
  detail?: unknown;
}

export interface AuditFilter {
  correlationId?: string;
  failureId?: string;
  limit?: number;
}

export interface StoredAuditEntry {
  id: string;
  at: string;
  kind: string;
  correlation_id: string | null;
  failure_id: string | null;
  tool_name: string | null;
  detail: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  correlation_id TEXT,
  failure_id TEXT,
  tool_name TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_correlation ON audit(correlation_id);
CREATE INDEX IF NOT EXISTS audit_failure ON audit(failure_id);
CREATE TABLE IF NOT EXISTS call_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  caller_type TEXT NOT NULL,
  caller_identity TEXT NOT NULL,
  tool TEXT NOT NULL,
  decision TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  request_bytes INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL,
  attempt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_events_at ON call_events(at);
CREATE INDEX IF NOT EXISTS call_events_tool ON call_events(tool);
CREATE INDEX IF NOT EXISTS call_events_caller ON call_events(caller_identity);
`;

const monotonicUlid = monotonicFactory();

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface CallEventRow {
  at: string;
  caller_identity: string;
  tool: string;
  decision: string;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
}

function buildCallWhere(filter: MetricsFilter): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.since !== undefined) {
    conditions.push('at >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push('at <= ?');
    params.push(filter.until);
  }
  if (filter.tool !== undefined) {
    conditions.push('tool = ?');
    params.push(filter.tool);
  }
  if (filter.caller !== undefined) {
    conditions.push('caller_identity = ?');
    params.push(filter.caller);
  }
  return {
    clause: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

/** Nearest-rank percentile over ascending values (⌈p/100 · n⌉-th, no interpolation). */
function nearestRank(ascending: number[], percentile: number): number {
  if (ascending.length === 0) return 0;
  const rank = Math.ceil((percentile / 100) * ascending.length);
  return ascending[Math.min(Math.max(rank, 1), ascending.length) - 1] as number;
}

function toToolMetrics(group: CallEventRow[]): ToolMetrics {
  const latencies = group.map((row) => row.latency_ms).sort((a, b) => a - b);
  const errors = group.filter((row) => row.decision === 'failed').length;
  const average = (pick: (row: CallEventRow) => number): number =>
    Math.round(group.reduce((sum, row) => sum + pick(row), 0) / group.length);
  return {
    caller: group[0]?.caller_identity as string,
    tool: group[0]?.tool as string,
    calls: group.length,
    errors,
    error_rate: errors / group.length,
    latency_p50_ms: nearestRank(latencies, 50),
    latency_p95_ms: nearestRank(latencies, 95),
    avg_request_bytes: average((row) => row.request_bytes),
    avg_response_bytes: average((row) => row.response_bytes),
  };
}

interface AuditRow {
  id: string;
  at: string;
  kind: string;
  correlation_id: string | null;
  failure_id: string | null;
  tool_name: string | null;
  detail: string | null;
}

function toAuditEntry(row: AuditRow): StoredAuditEntry {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    correlation_id: row.correlation_id,
    failure_id: row.failure_id,
    tool_name: row.tool_name,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as unknown),
  };
}

/** SQLite-backed store; WAL + busy_timeout so the CLI can share the file. */
export class SqliteStore implements Store {
  private readonly db: Database.Database;
  private readonly path: string;
  private readonly retentionDays: number;

  constructor(options: { path: string; retentionDays?: number }) {
    this.path = options.path;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    // busy_timeout first: the WAL pragma needs a lock and must wait, not fail.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.pruneCallEvents();
  }

  /** Bounds call-event growth (NFR-9); `0` keeps everything. Audit is untouched. */
  private pruneCallEvents(): void {
    if (this.retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - this.retentionDays * MS_PER_DAY).toISOString();
    this.db.prepare('DELETE FROM call_events WHERE at < ?').run(cutoff);
  }

  async recordCall(event: CallEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO call_events (
          id, at, correlation_id, caller_type, caller_identity, tool, decision,
          latency_ms, request_bytes, response_bytes, attempt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        monotonicUlid(),
        event.timestamp,
        event.correlation_id,
        event.caller.type,
        event.caller.identity,
        event.tool,
        event.decision,
        event.latency_ms,
        event.request_bytes,
        event.response_bytes,
        event.attempt,
      );
  }

  async metrics(filter: MetricsFilter): Promise<StoreMetrics> {
    const { clause, params } = buildCallWhere(filter);
    const rows = this.db
      .prepare(`SELECT * FROM call_events ${clause} ORDER BY at ASC`)
      .all(...params) as CallEventRow[];

    const decisions: DecisionTotals = { allowed: 0, denied: 0, failed: 0, cancelled: 0 };
    const groups = new Map<string, CallEventRow[]>();
    for (const row of rows) {
      if (row.decision in decisions) decisions[row.decision as CallDecision] += 1;
      const key = `${row.caller_identity}\u0000${row.tool}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [row]);
      else group.push(row);
    }

    const tools = [...groups.values()]
      .map((group) => toToolMetrics(group))
      .sort(
        (a, b) =>
          b.calls - a.calls || a.caller.localeCompare(b.caller) || a.tool.localeCompare(b.tool),
      );

    const replayConditions = ["kind = 'replayed'"];
    const replayParams: unknown[] = [];
    if (filter.since !== undefined) {
      replayConditions.push('at >= ?');
      replayParams.push(filter.since);
    }
    if (filter.until !== undefined) {
      replayConditions.push('at <= ?');
      replayParams.push(filter.until);
    }
    const replayRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM audit WHERE ${replayConditions.join(' AND ')}`)
      .get(...replayParams) as { count: number };

    return { tools, decisions, replayed: replayRow.count };
  }

  async audit(entry: AuditEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit (id, at, kind, correlation_id, failure_id, tool_name, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        monotonicUlid(),
        new Date().toISOString(),
        entry.kind,
        entry.correlationId ?? null,
        entry.failureId ?? null,
        entry.toolName ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      );
  }

  /** Read side for tests and the replay CLI (not part of the port). */
  async listAudit(filter: AuditFilter = {}): Promise<StoredAuditEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.correlationId !== undefined) {
      conditions.push('correlation_id = ?');
      params.push(filter.correlationId);
    }
    if (filter.failureId !== undefined) {
      conditions.push('failure_id = ?');
      params.push(filter.failureId);
    }
    const clause = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = this.db
      .prepare(`SELECT * FROM audit ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as AuditRow[];
    return rows.map(toAuditEntry);
  }

  close(): void {
    this.db.close();
  }
}

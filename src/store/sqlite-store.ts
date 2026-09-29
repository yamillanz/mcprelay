import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { ulid } from 'ulid';

/** Call history, metrics, and audit substrate (PRD §6.2). */
export interface Store {
  recordCall(event: CallEvent): Promise<void>;
  metrics(filter: MetricsFilter): Promise<ToolMetrics[]>;
  audit(entry: AuditEntry): Promise<void>;
}

/** Written by the metrics milestone (M8). */
export interface CallEvent {
  correlation_id: string;
  timestamp: string;
  tool: string;
  decision: string;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
  attempt: number;
}

export interface MetricsFilter {
  since?: string;
  until?: string;
  tool?: string;
}

export interface ToolMetrics {
  tool: string;
  calls: number;
  errors: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
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
`;

const NOT_IMPLEMENTED =
  'recordCall/metrics land with the metrics change (M8); the audit path is implemented now';

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

  constructor(options: { path: string }) {
    this.path = options.path;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  async recordCall(_event: CallEvent): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async metrics(_filter: MetricsFilter): Promise<ToolMetrics[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async audit(entry: AuditEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit (id, at, kind, correlation_id, failure_id, tool_name, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
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

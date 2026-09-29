import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type {
  ExecutionEntry,
  ExecutionRecord,
  FailureFilter,
  FailureRecord,
  HealthStatus,
  ReplayOutcome,
} from './failure-record.js';

export class AlreadyResolvedError extends Error {
  constructor(id: string) {
    super(`failure record '${id}' is not pending (already resolved)`);
    this.name = 'AlreadyResolvedError';
  }
}

export class RecordNotFoundError extends Error {
  constructor(id: string) {
    super(`failure record '${id}' not found`);
    this.name = 'RecordNotFoundError';
  }
}

/** Idempotency index over the queue database (used by replay dedup). */
export interface IdempotencyIndex {
  recordExecution(entry: ExecutionEntry): Promise<void>;
  lastExecution(key: string): Promise<ExecutionRecord | null>;
  lastExecutionByHash(argumentsHash: string): Promise<ExecutionRecord | null>;
}

export class AlreadyClaimedError extends Error {
  constructor(id: string) {
    super(`failure record '${id}' is already claimed by another replay`);
    this.name = 'AlreadyClaimedError';
  }
}

/** DLQ + replay substrate (PRD §6.2). */
export interface QueueProvider {
  enqueue(record: FailureRecord): Promise<string>;
  list(filter?: FailureFilter): Promise<FailureRecord[]>;
  get(id: string): Promise<FailureRecord | null>;
  resolve(id: string, outcome: ReplayOutcome): Promise<void>;
  claim(id: string, leaseMs: number): Promise<void>;
  release(id: string): Promise<void>;
  purge(filter?: FailureFilter): Promise<number>;
  health(): Promise<HealthStatus>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS failures (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  caller_type TEXT NOT NULL,
  caller_identity TEXT NOT NULL,
  server_name TEXT NOT NULL,
  server_command TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  arguments TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  failure_message TEXT NOT NULL,
  failure_attempts INTEGER NOT NULL,
  replay_status TEXT NOT NULL DEFAULT 'pending',
  replay_attempts TEXT NOT NULL DEFAULT '[]',
  last_outcome TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS failures_tool ON failures(tool_name);
CREATE INDEX IF NOT EXISTS failures_correlation ON failures(correlation_id);
CREATE INDEX IF NOT EXISTS failures_captured_at ON failures(captured_at);
CREATE INDEX IF NOT EXISTS failures_replay_status ON failures(replay_status);
CREATE TABLE IF NOT EXISTS executions (
  key TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_hash ON executions(arguments_hash);
`;

interface FailureRow {
  id: string;
  correlation_id: string;
  captured_at: string;
  caller_type: string;
  caller_identity: string;
  server_name: string;
  server_command: string;
  tool_name: string;
  arguments_hash: string;
  arguments: string;
  failure_class: string;
  failure_message: string;
  failure_attempts: number;
  replay_status: string;
  replay_attempts: string;
  last_outcome: string | null;
}

function buildWhere(filter: FailureFilter): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) {
    conditions.push('replay_status = ?');
    params.push(filter.status);
  }
  if (filter.tool !== undefined) {
    conditions.push('tool_name = ?');
    params.push(filter.tool);
  }
  if (filter.correlationId !== undefined) {
    conditions.push('correlation_id = ?');
    params.push(filter.correlationId);
  }
  if (filter.since !== undefined) {
    conditions.push('captured_at >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push('captured_at <= ?');
    params.push(filter.until);
  }
  return {
    clause: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

/** Adds a column when an older database predates it (in-place migration). */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function toExecutionRecord(row: {
  key: string;
  tool_name: string;
  arguments_hash: string;
  executed_at: string;
  source: string;
}): ExecutionRecord {
  return {
    key: row.key,
    toolName: row.tool_name,
    argumentsHash: row.arguments_hash,
    executedAt: row.executed_at,
    source: row.source as ExecutionRecord['source'],
  };
}

function toRecord(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    correlation_id: row.correlation_id,
    captured_at: row.captured_at,
    caller: { type: row.caller_type as 'stdio' | 'http', identity: row.caller_identity },
    server: { name: row.server_name, command: row.server_command },
    tool: {
      name: row.tool_name,
      arguments_hash: row.arguments_hash,
      arguments: JSON.parse(row.arguments) as unknown,
    },
    failure: {
      class: row.failure_class as FailureRecord['failure']['class'],
      message: row.failure_message,
      attempts: row.failure_attempts,
    },
    replay: {
      status: row.replay_status as FailureRecord['replay']['status'],
      attempts: JSON.parse(row.replay_attempts) as unknown[],
      last_outcome: row.last_outcome === null ? null : (JSON.parse(row.last_outcome) as unknown),
    },
  };
}

/** Durable DLQ backed by SQLite: WAL + busy_timeout, shared with the replay CLI. */
export class SqliteQueueProvider implements QueueProvider, IdempotencyIndex {
  private readonly db: Database.Database;
  private readonly path: string;

  constructor(options: { path: string }) {
    this.path = options.path;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    // busy_timeout first: the WAL pragma needs a lock and must wait, not fail.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    ensureColumn(this.db, 'failures', 'claimed_at', 'claimed_at TEXT');
    ensureColumn(this.db, 'failures', 'claim_expires_at', 'claim_expires_at TEXT');
  }

  async enqueue(record: FailureRecord): Promise<string> {
    this.db
      .prepare(
        `INSERT INTO failures (
          id, correlation_id, captured_at, caller_type, caller_identity,
          server_name, server_command, tool_name, arguments_hash, arguments,
          failure_class, failure_message, failure_attempts,
          replay_status, replay_attempts, last_outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.correlation_id,
        record.captured_at,
        record.caller.type,
        record.caller.identity,
        record.server.name,
        record.server.command,
        record.tool.name,
        record.tool.arguments_hash,
        JSON.stringify(record.tool.arguments ?? null),
        record.failure.class,
        record.failure.message,
        record.failure.attempts,
        record.replay.status,
        JSON.stringify(record.replay.attempts),
        record.replay.last_outcome === null ? null : JSON.stringify(record.replay.last_outcome),
      );
    return record.id;
  }

  async list(filter: FailureFilter = {}): Promise<FailureRecord[]> {
    const { clause, params } = buildWhere(filter);
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const rows = this.db
      .prepare(`SELECT * FROM failures ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as FailureRow[];
    return rows.map(toRecord);
  }

  async get(id: string): Promise<FailureRecord | null> {
    const row = this.db.prepare('SELECT * FROM failures WHERE id = ?').get(id) as
      FailureRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async resolve(id: string, outcome: ReplayOutcome): Promise<void> {
    const info = this.db
      .prepare(
        `UPDATE failures
         SET replay_status = ?, replay_attempts = ?, last_outcome = ?, resolved_at = ?
         WHERE id = ? AND replay_status = 'pending'`,
      )
      .run(
        outcome.status,
        JSON.stringify(outcome.attempts ?? []),
        outcome.lastOutcome === undefined ? null : JSON.stringify(outcome.lastOutcome),
        new Date().toISOString(),
        id,
      );
    if (info.changes === 0) {
      const exists = this.db.prepare('SELECT 1 FROM failures WHERE id = ?').get(id);
      if (exists === undefined) throw new RecordNotFoundError(id);
      throw new AlreadyResolvedError(id);
    }
  }

  async claim(id: string, leaseMs: number): Promise<void> {
    const now = new Date();
    const info = this.db
      .prepare(
        `UPDATE failures
         SET claimed_at = ?, claim_expires_at = ?
         WHERE id = ? AND replay_status = 'pending'
           AND (claim_expires_at IS NULL OR claim_expires_at < ?)`,
      )
      .run(
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        id,
        now.toISOString(),
      );
    if (info.changes === 0) {
      const row = this.db.prepare('SELECT replay_status FROM failures WHERE id = ?').get(id) as
        { replay_status: string } | undefined;
      if (row === undefined) throw new RecordNotFoundError(id);
      if (row.replay_status !== 'pending') throw new AlreadyResolvedError(id);
      throw new AlreadyClaimedError(id);
    }
  }

  async release(id: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE failures SET claimed_at = NULL, claim_expires_at = NULL
         WHERE id = ? AND replay_status = 'pending'`,
      )
      .run(id);
  }

  async recordExecution(entry: ExecutionEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO executions (key, tool_name, arguments_hash, executed_at, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           tool_name = excluded.tool_name,
           arguments_hash = excluded.arguments_hash,
           executed_at = excluded.executed_at,
           source = excluded.source`,
      )
      .run(entry.key, entry.toolName, entry.argumentsHash, entry.executedAt, entry.source);
  }

  async lastExecution(key: string): Promise<ExecutionRecord | null> {
    const row = this.db.prepare('SELECT * FROM executions WHERE key = ?').get(key) as
      | {
          key: string;
          tool_name: string;
          arguments_hash: string;
          executed_at: string;
          source: string;
        }
      | undefined;
    return row === undefined ? null : toExecutionRecord(row);
  }

  async lastExecutionByHash(argumentsHash: string): Promise<ExecutionRecord | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM executions WHERE arguments_hash = ? ORDER BY executed_at DESC LIMIT 1',
      )
      .get(argumentsHash) as
      | {
          key: string;
          tool_name: string;
          arguments_hash: string;
          executed_at: string;
          source: string;
        }
      | undefined;
    return row === undefined ? null : toExecutionRecord(row);
  }

  async purge(filter: FailureFilter = {}): Promise<number> {
    const { clause, params } = buildWhere(filter);
    const info = this.db.prepare(`DELETE FROM failures ${clause}`).run(...params);
    return info.changes;
  }

  async health(): Promise<HealthStatus> {
    try {
      this.db.prepare('SELECT 1').get();
      return { ok: true, provider: 'sqlite', path: this.path };
    } catch {
      return { ok: false, provider: 'sqlite', path: this.path };
    }
  }

  close(): void {
    this.db.close();
  }
}

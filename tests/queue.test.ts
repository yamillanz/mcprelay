import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AlreadyClaimedError,
  AlreadyResolvedError,
  SqliteQueueProvider,
} from '../src/queue/sqlite-queue.js';
import { newFailureRecordId, type FailureRecord } from '../src/queue/failure-record.js';

const providers: SqliteQueueProvider[] = [];

function queuePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mcprelay-queue-')), '.mcprelay', 'queue.db');
}

function open(path = queuePath()): { provider: SqliteQueueProvider; path: string } {
  const provider = new SqliteQueueProvider({ path });
  providers.push(provider);
  return { provider, path };
}

function record(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    id: newFailureRecordId(),
    correlation_id: 'corr-1',
    captured_at: new Date().toISOString(),
    caller: { type: 'stdio', identity: 'local' },
    server: { name: 'echo-server', command: 'node echo.js', transport: 'stdio' },
    tool: { name: 'echo', arguments_hash: 'a'.repeat(64), arguments: { safe: 'value' } },
    failure: { class: 'upstream_error', message: 'flaky failure 1', attempts: 3 },
    replay: { status: 'pending', attempts: [], last_outcome: null },
    ...overrides,
  };
}

afterEach(() => {
  for (const provider of providers.splice(0)) provider.close();
});

describe('QueueProvider contract', () => {
  it('enqueues and reads back a full record', async () => {
    const { provider } = open();
    const original = record();

    const id = await provider.enqueue(original);
    expect(id).toBe(original.id);

    const loaded = await provider.get(id);
    expect(loaded).toEqual(original);
    expect(await provider.get('missing-id')).toBeNull();
  });

  it('round-trips the http transport', async () => {
    const { provider } = open();
    const original = record({
      server: {
        name: 'http-echo-server',
        command: 'http://127.0.0.1:9999/mcp',
        transport: 'http',
      },
    });

    await provider.enqueue(original);
    const loaded = await provider.get(original.id);
    expect(loaded?.server.transport).toBe('http');
    expect(loaded?.server.command).toBe('http://127.0.0.1:9999/mcp');
  });

  it('migrates pre-M6 databases to transport stdio', async () => {
    const path = queuePath();
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE failures (
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
    `);
    legacy
      .prepare(
        `INSERT INTO failures (
          id, correlation_id, captured_at, caller_type, caller_identity,
          server_name, server_command, tool_name, arguments_hash, arguments,
          failure_class, failure_message, failure_attempts,
          replay_status, replay_attempts, last_outcome, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '01J00000000000000000000000',
        'corr-old',
        '2026-09-01T00:00:00.000Z',
        'stdio',
        'local',
        'old-server',
        'node old.js',
        'echo',
        'a'.repeat(64),
        '{}',
        'upstream_error',
        'old failure',
        1,
        'pending',
        '[]',
        null,
        null,
      );
    legacy.close();

    const { provider } = open(path);
    const loaded = await provider.get('01J00000000000000000000000');
    expect(loaded?.server.transport).toBe('stdio');
    expect(loaded?.server.command).toBe('node old.js');
  });

  it('lists with filters', async () => {
    const { provider } = open();
    const older = record({
      captured_at: '2026-09-01T00:00:00.000Z',
      tool: { name: 'echo', arguments_hash: 'h', arguments: {} },
    });
    const newer = record({
      captured_at: '2026-09-20T00:00:00.000Z',
      tool: { name: 'flaky', arguments_hash: 'h', arguments: {} },
      correlation_id: 'corr-2',
    });
    await provider.enqueue(older);
    await provider.enqueue(newer);

    expect((await provider.list()).length).toBe(2);
    expect((await provider.list({ tool: 'flaky' })).map((r) => r.id)).toEqual([newer.id]);
    expect((await provider.list({ correlationId: 'corr-1' })).map((r) => r.id)).toEqual([older.id]);
    expect((await provider.list({ since: '2026-09-10T00:00:00.000Z' })).map((r) => r.id)).toEqual([
      newer.id,
    ]);
    expect((await provider.list({ until: '2026-09-10T00:00:00.000Z' })).map((r) => r.id)).toEqual([
      older.id,
    ]);
    expect((await provider.list({ limit: 1 })).length).toBe(1);
  });

  it('resolves atomically: exactly one concurrent resolver wins', async () => {
    const first = open();
    const second = open(first.path);
    const original = record();
    await first.provider.enqueue(original);

    const results = await Promise.allSettled([
      first.provider.resolve(original.id, { status: 'replayed', lastOutcome: { ok: true } }),
      second.provider.resolve(original.id, { status: 'discarded' }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyResolvedError);

    const loaded = await first.provider.get(original.id);
    expect(loaded?.replay.status).not.toBe('pending');
  });

  it('purges matching records and reports the count', async () => {
    const { provider } = open();
    await provider.enqueue(record());
    await provider.enqueue(record({ tool: { name: 'flaky', arguments_hash: 'h', arguments: {} } }));

    expect(await provider.purge({ tool: 'flaky' })).toBe(1);
    expect((await provider.list()).length).toBe(1);
    expect(await provider.purge()).toBe(1);
    expect(await provider.list()).toEqual([]);
  });

  it('reports health with provider and path', async () => {
    const { provider, path } = open();
    expect(await provider.health()).toEqual({ ok: true, provider: 'sqlite', path });
  });

  it('keeps records across reopen (restart durability)', async () => {
    const { provider, path } = open();
    const original = record();
    await provider.enqueue(original);
    provider.close();

    const reopened = open(path);
    expect(await reopened.provider.get(original.id)).toEqual(original);
  });

  it('opens with WAL and busy_timeout configured', () => {
    const { provider, path } = open();
    provider.close();
    const db = new Database(path, { readonly: true });
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
  });

  it('creates missing parent directories on open', async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'mcprelay-queue-')),
      'nested',
      '.mcprelay',
      'queue.db',
    );
    const { provider } = open(path);
    expect(await provider.health()).toMatchObject({ ok: true, path });
  });
});

describe('claim, release, and the idempotency index', () => {
  it('claims atomically: exactly one concurrent claimer wins', async () => {
    const first = open();
    const second = open(first.path);
    const original = record();
    await first.provider.enqueue(original);

    const results = await Promise.allSettled([
      first.provider.claim(original.id, 60_000),
      second.provider.claim(original.id, 60_000),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toBeInstanceOf(AlreadyClaimedError);
  });

  it('reclaims an expired lease and releases a claim', async () => {
    const { provider } = open();
    const original = record();
    await provider.enqueue(original);

    await provider.claim(original.id, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(provider.claim(original.id, 60_000)).resolves.toBeUndefined();

    await provider.release(original.id);
    await expect(provider.claim(original.id, 60_000)).resolves.toBeUndefined();
  });

  it('records and reads executions by key and by hash', async () => {
    const { provider } = open();

    await provider.recordExecution({
      key: 'key-1',
      toolName: 'create_issue',
      argumentsHash: 'h'.repeat(64),
      executedAt: '2026-09-29T10:00:00.000Z',
      source: 'live',
    });
    await provider.recordExecution({
      key: 'key-2',
      toolName: 'create_issue',
      argumentsHash: 'h'.repeat(64),
      executedAt: '2026-09-29T11:00:00.000Z',
      source: 'replay',
    });

    expect(await provider.lastExecution('key-1')).toMatchObject({
      key: 'key-1',
      toolName: 'create_issue',
      source: 'live',
    });
    expect(await provider.lastExecution('missing')).toBeNull();
    expect(await provider.lastExecutionByHash('h'.repeat(64))).toMatchObject({ key: 'key-2' });
  });

  it('upserts an execution so the latest wins', async () => {
    const { provider } = open();
    await provider.recordExecution({
      key: 'k',
      toolName: 't',
      argumentsHash: 'a'.repeat(64),
      executedAt: '2026-09-29T10:00:00.000Z',
      source: 'live',
    });
    await provider.recordExecution({
      key: 'k',
      toolName: 't',
      argumentsHash: 'a'.repeat(64),
      executedAt: '2026-09-29T12:00:00.000Z',
      source: 'replay',
    });
    expect((await provider.lastExecution('k'))?.executedAt).toBe('2026-09-29T12:00:00.000Z');
  });

  it('migrates an existing M3 database in place', async () => {
    const path = queuePath();
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new Database(path, {});
    legacy.exec(`
      CREATE TABLE failures (
        id TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, captured_at TEXT NOT NULL,
        caller_type TEXT NOT NULL, caller_identity TEXT NOT NULL,
        server_name TEXT NOT NULL, server_command TEXT NOT NULL,
        tool_name TEXT NOT NULL, arguments_hash TEXT NOT NULL, arguments TEXT NOT NULL,
        failure_class TEXT NOT NULL, failure_message TEXT NOT NULL, failure_attempts INTEGER NOT NULL,
        replay_status TEXT NOT NULL DEFAULT 'pending', replay_attempts TEXT NOT NULL DEFAULT '[]',
        last_outcome TEXT, resolved_at TEXT
      );
    `);
    const original = record();
    legacy
      .prepare(
        `INSERT INTO failures (id, correlation_id, captured_at, caller_type, caller_identity, server_name, server_command, tool_name, arguments_hash, arguments, failure_class, failure_message, failure_attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        original.id,
        original.correlation_id,
        original.captured_at,
        'stdio',
        'local',
        'echo-server',
        'node echo.js',
        'echo',
        'a'.repeat(64),
        '{}',
        'upstream_error',
        'boom',
        1,
      );
    legacy.close();

    const { provider } = open(path);
    const columns = (
      provider as unknown as {
        db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } };
      }
    ).db
      .prepare('PRAGMA table_info(failures)')
      .all()
      .map((column) => column.name);
    expect(columns).toContain('claimed_at');
    expect(columns).toContain('claim_expires_at');
    expect(await provider.get(original.id)).toMatchObject({ id: original.id });
    await expect(provider.claim(original.id, 1000)).resolves.toBeUndefined();
  });
});

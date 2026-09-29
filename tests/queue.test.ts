import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { AlreadyResolvedError, SqliteQueueProvider } from '../src/queue/sqlite-queue.js';
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
    server: { name: 'echo-server', command: 'node echo.js' },
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

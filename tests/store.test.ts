import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteStore, type CallEvent, type CallDecision } from '../src/store/sqlite-store.js';

const stores: SqliteStore[] = [];

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mcprelay-store-')), '.mcprelay', 'history.db');
}

function open(path = storePath(), retentionDays?: number): { store: SqliteStore; path: string } {
  const store = new SqliteStore({
    path,
    ...(retentionDays === undefined ? {} : { retentionDays }),
  });
  stores.push(store);
  return { store, path };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function event(overrides: Partial<CallEvent> = {}): CallEvent {
  return {
    correlation_id: 'corr-1',
    timestamp: '2026-10-05T12:00:00.000Z',
    caller: { type: 'stdio', identity: 'local' },
    tool: 'read_file',
    decision: 'allowed',
    latency_ms: 10,
    request_bytes: 100,
    response_bytes: 200,
    attempt: 1,
    ...overrides,
  };
}

describe('Store audit trail', () => {
  it('writes an audit entry linking correlation id and failure id', async () => {
    const { store } = open();

    await store.audit({
      kind: 'captured',
      correlationId: 'corr-1',
      failureId: '01J000000000000000000000AA',
      toolName: 'flaky',
    });

    const entries = await store.listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'captured',
      correlation_id: 'corr-1',
      failure_id: '01J000000000000000000000AA',
      tool_name: 'flaky',
    });
    expect(entries[0]?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Date(entries[0]?.at ?? '').toString()).not.toBe('Invalid Date');
  });

  it('keeps audit entries across reopen', async () => {
    const { store, path } = open();
    await store.audit({ kind: 'captured', correlationId: 'corr-2' });
    store.close();

    const reopened = open(path);
    const entries = await reopened.store.listAudit();
    expect(entries.map((entry) => entry.correlation_id)).toEqual(['corr-2']);
  });

  it('filters audit entries by correlation id', async () => {
    const { store } = open();
    await store.audit({ kind: 'captured', correlationId: 'corr-a' });
    await store.audit({ kind: 'captured', correlationId: 'corr-b' });

    expect((await store.listAudit({ correlationId: 'corr-a' })).length).toBe(1);
  });
});

describe('Store call events and metrics', () => {
  it('persists one call event per decision and reports decision totals', async () => {
    const { store } = open();
    for (const decision of ['allowed', 'denied', 'failed', 'cancelled'] as CallDecision[]) {
      await store.recordCall(event({ decision }));
    }

    const metrics = await store.metrics({});
    expect(metrics.decisions).toEqual({ allowed: 1, denied: 1, failed: 1, cancelled: 1 });
    expect(metrics.tools).toHaveLength(1);
    expect(metrics.tools[0]).toMatchObject({
      caller: 'local',
      tool: 'read_file',
      calls: 4,
      errors: 1,
      error_rate: 0.25,
    });
  });

  it('groups per caller and tool', async () => {
    const { store } = open();
    await store.recordCall(event({ tool: 'read_file' }));
    await store.recordCall(event({ tool: 'write_file' }));
    await store.recordCall(
      event({ caller: { type: 'stdio', identity: 'agent-2' }, tool: 'read_file' }),
    );

    const rows = (await store.metrics({})).tools;
    expect(rows.map((row) => `${row.caller}/${row.tool}:${row.calls}`).sort()).toEqual([
      'agent-2/read_file:1',
      'local/read_file:1',
      'local/write_file:1',
    ]);
  });

  it('filters narrow the aggregate', async () => {
    const { store } = open();
    const early = '2026-01-01T00:00:00.000Z';
    const late = '2026-06-01T00:00:00.000Z';
    await store.recordCall(event({ timestamp: early, tool: 'read_file' }));
    await store.recordCall(event({ timestamp: late, tool: 'read_file' }));
    await store.recordCall(
      event({ timestamp: late, tool: 'write_file', caller: { type: 'stdio', identity: 'other' } }),
    );

    expect((await store.metrics({ since: late })).tools).toHaveLength(2);
    expect((await store.metrics({ until: early })).tools).toHaveLength(1);
    expect((await store.metrics({ tool: 'write_file' })).tools).toHaveLength(1);
    expect((await store.metrics({ caller: 'other' })).tools).toHaveLength(1);
    expect((await store.metrics({ tool: 'write_file', caller: 'other' })).tools).toHaveLength(1);
  });

  it('uses nearest-rank percentiles', async () => {
    const { store } = open();
    for (const latency of [40, 10, 30, 20]) {
      await store.recordCall(event({ latency_ms: latency }));
    }

    expect((await store.metrics({})).tools[0]).toMatchObject({
      latency_p50_ms: 20,
      latency_p95_ms: 40,
    });
  });

  it('averages payload sizes per row', async () => {
    const { store } = open();
    await store.recordCall(event({ request_bytes: 100, response_bytes: 200 }));
    await store.recordCall(event({ request_bytes: 301, response_bytes: 401 }));

    expect((await store.metrics({})).tools[0]).toMatchObject({
      avg_request_bytes: 201,
      avg_response_bytes: 301,
    });
  });

  it('counts replayed audit entries in range', async () => {
    const { store } = open();
    await store.audit({ kind: 'replayed', correlationId: 'corr-1', toolName: 'read_file' });
    await store.audit({ kind: 'captured', correlationId: 'corr-1' });

    expect((await store.metrics({})).replayed).toBe(1);
    expect((await store.metrics({ since: '2999-01-01T00:00:00.000Z' })).replayed).toBe(0);
  });

  it('survives reopening the store', async () => {
    const { store, path } = open();
    await store.recordCall(event({ decision: 'failed' }));
    store.close();

    const reopened = open(path);
    const metrics = await reopened.store.metrics({});
    expect(metrics.decisions.failed).toBe(1);
    expect(metrics.tools[0]?.calls).toBe(1);
  });

  it('migrates a pre-M8 store file in place', async () => {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new Database(path);
    legacy.exec(
      'CREATE TABLE audit (id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, correlation_id TEXT, failure_id TEXT, tool_name TEXT, detail TEXT)',
    );
    legacy
      .prepare('INSERT INTO audit (id, at, kind) VALUES (?, ?, ?)')
      .run('01AAA', '2026-01-01', 'captured');
    legacy.close();

    const { store } = open(path);
    await store.recordCall(event());

    expect((await store.metrics({})).tools[0]?.calls).toBe(1);
    expect((await store.listAudit()).map((entry) => entry.id)).toContain('01AAA');
  });
});

describe('Store call-event retention', () => {
  it('prunes events older than the window on open', async () => {
    const path = storePath();
    const { store } = open(path);
    await store.recordCall(
      event({
        timestamp: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(),
        tool: 'old_tool',
      }),
    );
    await store.recordCall(event({ timestamp: new Date().toISOString(), tool: 'new_tool' }));
    store.close();

    const reopened = open(path, 30);
    expect((await reopened.store.metrics({})).tools.map((row) => row.tool)).toEqual(['new_tool']);
  });

  it('keeps events inside the window', async () => {
    const path = storePath();
    const { store } = open(path);
    await store.recordCall(
      event({ timestamp: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() }),
    );
    store.close();

    const reopened = open(path, 30);
    expect((await reopened.store.metrics({})).tools).toHaveLength(1);
  });

  it('keeps everything when retention is zero', async () => {
    const path = storePath();
    const { store } = open(path);
    await store.recordCall(event({ timestamp: '2020-01-01T00:00:00.000Z' }));
    store.close();

    const reopened = open(path, 0);
    expect((await reopened.store.metrics({})).tools).toHaveLength(1);
  });

  it('does not prune audit entries', async () => {
    const path = storePath();
    const { store } = open(path);
    await store.audit({ kind: 'captured', correlationId: 'corr-old' });
    store.close();
    const db = new Database(path);
    db.prepare('UPDATE audit SET at = ?').run('2020-01-01T00:00:00.000Z');
    db.close();

    const reopened = open(path, 30);
    expect((await reopened.store.listAudit()).map((entry) => entry.correlation_id)).toEqual([
      'corr-old',
    ]);
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteStore } from '../src/store/sqlite-store.js';

const stores: SqliteStore[] = [];

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mcprelay-store-')), '.mcprelay', 'history.db');
}

function open(path = storePath()): { store: SqliteStore; path: string } {
  const store = new SqliteStore({ path });
  stores.push(store);
  return { store, path };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

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

  it('reports the metrics methods as not implemented yet', async () => {
    const { store } = open();
    await expect(store.recordCall({} as never)).rejects.toThrow(/metrics/i);
    await expect(store.metrics({})).rejects.toThrow(/metrics/i);
  });
});

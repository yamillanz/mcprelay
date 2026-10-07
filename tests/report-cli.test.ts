import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { startRaw, type RawSession } from './helpers/raw-client.js';
import { SqliteStore, type CallEvent } from '../src/store/sqlite-store.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'mcprelay-report-'));
}

function configPath(dir: string, storeYaml?: string): string {
  const path = join(dir, 'mcprelay.config.yaml');
  writeFileSync(
    path,
    storeYaml ?? `store:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'history.db')}\n`,
    'utf8',
  );
  return path;
}

function event(overrides: Partial<CallEvent> = {}): CallEvent {
  return {
    correlation_id: 'corr-1',
    timestamp: new Date().toISOString(),
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

async function seed(dir: string): Promise<void> {
  const store = new SqliteStore({ path: join(dir, 'history.db') });
  await store.recordCall(event({ tool: 'read_file', decision: 'allowed', latency_ms: 10 }));
  await store.recordCall(
    event({ tool: 'read_file', decision: 'failed', latency_ms: 30, response_bytes: 0 }),
  );
  await store.recordCall(
    event({ tool: 'write_file', decision: 'denied', latency_ms: 0, response_bytes: 0 }),
  );
  await store.audit({ kind: 'replayed', toolName: 'read_file' });
  store.close();
}

function runReport(dir: string, args: string[] = []): RawSession {
  const raw = startRaw(NODE, [CLI, 'report', '--config', configPath(dir), ...args]);
  sessions.push(raw);
  return raw;
}

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
});

describe('mcprelay report', () => {
  it('renders the window, totals, and per caller+tool rows', async () => {
    const dir = workdir();
    await seed(dir);

    const raw = runReport(dir);
    expect(await raw.waitForExit()).toBe(0);
    const out = raw.stdout();

    expect(out).toContain('window:');
    expect(out).toContain('calls 3');
    expect(out).toContain('allowed 1');
    expect(out).toContain('denied 1');
    expect(out).toContain('failed 1');
    expect(out).toContain('cancelled 0');
    expect(out).toContain('replayed 1');
    expect(out).toContain('read_file');
    expect(out).toContain('write_file');
    expect(out).toContain('50.0%');
  });

  it('emits one parseable JSON document with --json', async () => {
    const dir = workdir();
    await seed(dir);

    const raw = runReport(dir, ['--json']);
    expect(await raw.waitForExit()).toBe(0);
    const doc = JSON.parse(raw.stdout().trim()) as {
      since: string;
      until: string;
      totals: Record<string, number>;
      tools: Array<{ caller: string; tool: string; calls: number; errors: number }>;
    };

    expect(doc.since).toBeDefined();
    expect(doc.until).toBeDefined();
    expect(doc.totals).toMatchObject({
      calls: 3,
      errors: 1,
      allowed: 1,
      denied: 1,
      failed: 1,
      cancelled: 0,
      replayed: 1,
    });
    expect(doc.tools.map((row) => `${row.caller}/${row.tool}:${row.calls}`).sort()).toEqual([
      'local/read_file:2',
      'local/write_file:1',
    ]);
  });

  it('narrows the aggregate with filters', async () => {
    const dir = workdir();
    await seed(dir);

    const byTool = runReport(dir, ['--tool', 'read_file', '--json']);
    expect(await byTool.waitForExit()).toBe(0);
    expect(JSON.parse(byTool.stdout().trim()).totals.calls).toBe(2);

    const byCaller = runReport(dir, ['--caller', 'nobody', '--json']);
    expect(await byCaller.waitForExit()).toBe(0);
    expect(JSON.parse(byCaller.stdout().trim()).totals.calls).toBe(0);

    const future = runReport(dir, ['--since', '2999-01-01T00:00:00.000Z', '--json']);
    expect(await future.waitForExit()).toBe(0);
    expect(JSON.parse(future.stdout().trim()).totals.calls).toBe(0);

    const past = runReport(dir, ['--until', '2000-01-01T00:00:00.000Z', '--json']);
    expect(await past.waitForExit()).toBe(0);
    expect(JSON.parse(past.stdout().trim()).totals.calls).toBe(0);
  });

  it('treats empty data as success', async () => {
    const dir = workdir();
    configPath(dir);

    const raw = runReport(dir);
    expect(await raw.waitForExit()).toBe(0);
    expect(raw.stdout()).toContain('calls 0');
  });

  it('rejects invalid dates as usage errors', async () => {
    const dir = workdir();
    const raw = runReport(dir, ['--since', 'yesterday']);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain('--since');
    expect(raw.stderr()).toContain('yesterday');
  });

  it('rejects unknown options', async () => {
    const dir = workdir();
    const raw = runReport(dir, ['--bogus']);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain("Unknown option '--bogus'");
  });

  it('reports a malformed config as a usage error', async () => {
    const dir = workdir();
    const path = configPath(dir, 'store:\n  retention_days: -1\n');
    const raw = startRaw(NODE, [CLI, 'report', '--config', path]);
    sessions.push(raw);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain('store.retention_days');
  });
});

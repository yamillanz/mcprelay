import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { startRaw, type RawSession } from './helpers/raw-client.js';
import { quoteCommandLine } from '../src/replay/command-line.js';
import { SqliteQueueProvider } from '../src/queue/sqlite-queue.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import { newFailureRecordId, type FailureRecord } from '../src/queue/failure-record.js';
import { hashArguments } from '../src/redaction/redact.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const ECHO = fileURLToPath(new URL('../build/examples/echo-server/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];
const providers: SqliteQueueProvider[] = [];
const stores: SqliteStore[] = [];

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'mcprelay-replay-run-'));
}

function configPath(dir: string, extra = ''): string {
  const path = join(dir, 'mcprelay.config.yaml');
  writeFileSync(
    path,
    `queue:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'queue.db')}\n` +
      `store:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'history.db')}\n` +
      `reliability:\n  timeout_ms: 5000\n` +
      extra,
    'utf8',
  );
  return path;
}

function queueOf(dir: string): SqliteQueueProvider {
  const provider = new SqliteQueueProvider({ path: join(dir, 'queue.db') });
  providers.push(provider);
  return provider;
}

function storeOf(dir: string): SqliteStore {
  const store = new SqliteStore({ path: join(dir, 'history.db') });
  stores.push(store);
  return store;
}

function seed(dir: string, overrides: Partial<FailureRecord> = {}): FailureRecord {
  const record: FailureRecord = {
    id: newFailureRecordId(),
    correlation_id: 'corr-run-1',
    captured_at: '2026-09-29T10:00:00.000Z',
    caller: { type: 'stdio', identity: 'local' },
    server: { name: 'echo-server', command: quoteCommandLine(NODE, [ECHO]) },
    tool: { name: 'echo', arguments_hash: hashArguments({ value: 1 }), arguments: { value: 1 } },
    failure: { class: 'upstream_error', message: 'boom', attempts: 1 },
    replay: { status: 'pending', attempts: [], last_outcome: null },
    ...overrides,
  };
  const provider = queueOf(dir);
  void provider.enqueue(record);
  provider.close();
  return record;
}

function run(dir: string, args: string[]): RawSession {
  const raw = startRaw(NODE, [
    CLI,
    'replay',
    'run',
    args[0] as string,
    '--config',
    configPath(dir),
    ...args.slice(1),
  ]);
  sessions.push(raw);
  return raw;
}

function runWithConfig(dir: string, args: string[], extraConfig: string): RawSession {
  const raw = startRaw(NODE, [
    CLI,
    'replay',
    'run',
    args[0] as string,
    '--config',
    configPath(dir, extraConfig),
    ...args.slice(1),
  ]);
  sessions.push(raw);
  return raw;
}

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
  for (const provider of providers.splice(0)) provider.close();
  for (const store of stores.splice(0)) store.close();
});

describe('replay run: execution and capture', () => {
  it('executes the stored call, resolves the record, and captures the redacted result', async () => {
    const dir = workdir();
    const record = seed(dir);

    const raw = run(dir, [record.id]);
    expect(await raw.nextLine()).toContain('replay ok');
    expect(await raw.waitForExit()).toBe(0);

    const queue = queueOf(dir);
    const updated = await queue.get(record.id);
    expect(updated?.replay.status).toBe('replayed');
    expect(updated?.replay.attempts).toHaveLength(1);
    const outcome = updated?.replay.last_outcome as { ok: boolean; result: unknown };
    expect(outcome.ok).toBe(true);
    const text = JSON.stringify(outcome.result);
    expect(text).toContain('value');

    const audit = await storeOf(dir).listAudit({ failureId: record.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: 'replayed', correlation_id: record.correlation_id });
  });

  it('redacts secrets in the captured result', async () => {
    const dir = workdir();
    const record = seed(dir, {
      tool: {
        name: 'echo',
        arguments_hash: hashArguments({ api_key: '[REDACTED]' }),
        arguments: { api_key: '[REDACTED]' },
      },
    });

    const raw = run(dir, [record.id, '--set', 'api_key=real-secret']);
    expect(await raw.waitForExit()).toBe(0);

    const updated = await queueOf(dir).get(record.id);
    const text = JSON.stringify(updated?.replay.last_outcome);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('real-secret');
  });

  it('captures a failed attempt without retrying', async () => {
    const dir = workdir();
    const record = seed(dir, {
      tool: {
        name: 'flaky',
        arguments_hash: hashArguments({ fail_times: 5 }),
        arguments: { fail_times: 5 },
      },
    });

    const raw = run(dir, [record.id]);
    expect(await raw.waitForExit()).toBe(1);

    const updated = await queueOf(dir).get(record.id);
    expect(updated?.replay.status).toBe('replayed');
    const outcome = updated?.replay.last_outcome as { ok: boolean; error: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('flaky failure 1');
  });

  it('releases the claim when the tool cannot be reached and leaves the record pending', async () => {
    const dir = workdir();
    const record = seed(dir, {
      server: { name: 'broken', command: quoteCommandLine(NODE, ['/nonexistent/echo.js']) },
    });

    const raw = run(dir, [record.id]);
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('left pending');

    const queue = queueOf(dir);
    expect((await queue.get(record.id))?.replay.status).toBe('pending');
    await expect(queue.claim(record.id, 1000)).resolves.toBeUndefined();
  });
});

describe('replay run: dry-run', () => {
  it('makes no upstream tool calls and leaves the record pending', async () => {
    const dir = workdir();
    const record = seed(dir);

    const raw = run(dir, [record.id, '--dry-run']);
    expect(await raw.waitForExit()).toBe(0);
    expect(raw.stdout()).toContain('no upstream tools/call');

    const queue = queueOf(dir);
    expect((await queue.get(record.id))?.replay.status).toBe('pending');
    expect(await queue.lastExecutionByHash(record.tool.arguments_hash)).toBeNull();
  });

  it('reports a missing tool and exits non-zero', async () => {
    const dir = workdir();
    const record = seed(dir, {
      tool: { name: 'definitely_missing', arguments_hash: hashArguments({}), arguments: {} },
    });
    const raw = run(dir, [record.id, '--dry-run']);
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('does not exist upstream');
  });

  it('warns about effects: read', async () => {
    const dir = workdir();
    const record = seed(dir);
    const raw = runWithConfig(
      dir,
      [record.id, '--dry-run'],
      '  per_tool:\n    echo:\n      effects: read\n',
    );
    expect(await raw.waitForExit()).toBe(0);
    expect(raw.stdout()).toContain('effects: read');
  });

  it('reports a duplicate verdict', async () => {
    const dir = workdir();
    const record = seed(dir, {
      tool: {
        name: 'echo',
        arguments_hash: hashArguments({ idempotency_key: 'op-1' }),
        arguments: { idempotency_key: 'op-1' },
      },
    });
    const queue = queueOf(dir);
    await queue.recordExecution({
      key: 'op-1',
      toolName: 'echo',
      argumentsHash: record.tool.arguments_hash,
      executedAt: new Date().toISOString(),
      source: 'live',
    });

    const raw = run(dir, [record.id, '--dry-run']);
    expect(await raw.waitForExit()).toBe(0);
    expect(raw.stdout()).toContain('--force required');
  });
});

describe('replay run: guards', () => {
  it('refuses to replay redacted arguments without --set', async () => {
    const dir = workdir();
    const record = seed(dir, {
      tool: {
        name: 'echo',
        arguments_hash: hashArguments({ api_key: '[REDACTED]' }),
        arguments: { api_key: '[REDACTED]' },
      },
    });
    const raw = run(dir, [record.id]);
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('--set');
    expect((await queueOf(dir).get(record.id))?.replay.status).toBe('pending');
  });

  it('lists the markers still missing after partial overrides', async () => {
    const dir = workdir();
    const record = seed(dir, {
      tool: {
        name: 'echo',
        arguments_hash: hashArguments({ api_key: '[REDACTED]', token: '[REDACTED]' }),
        arguments: { api_key: '[REDACTED]', token: '[REDACTED]' },
      },
    });
    const raw = run(dir, [record.id, '--set', 'api_key=x']);
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('token');
  });

  it('requires --force for a duplicate key within the window', async () => {
    const dir = workdir();
    const record = seed(dir, {
      tool: {
        name: 'echo',
        arguments_hash: hashArguments({ idempotency_key: 'op-1' }),
        arguments: { idempotency_key: 'op-1' },
      },
    });
    const queue = queueOf(dir);
    await queue.recordExecution({
      key: 'op-1',
      toolName: 'echo',
      argumentsHash: record.tool.arguments_hash,
      executedAt: new Date().toISOString(),
      source: 'live',
    });

    const refused = run(dir, [record.id]);
    expect(await refused.waitForExit()).toBe(1);
    expect(refused.stderr()).toContain('duplicate');

    const forced = run(dir, [record.id, '--force']);
    expect(await forced.waitForExit()).toBe(0);
    expect((await queue.lastExecution('op-1'))?.source).toBe('replay');
  });

  it('falls back to the arguments hash for unkeyed duplicates', async () => {
    const dir = workdir();
    const record = seed(dir);
    const queue = queueOf(dir);
    await queue.recordExecution({
      key: 'other',
      toolName: 'echo',
      argumentsHash: record.tool.arguments_hash,
      executedAt: new Date().toISOString(),
      source: 'live',
    });

    const raw = run(dir, [record.id]);
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('duplicate');
  });

  it('lets exactly one concurrent run execute', async () => {
    const dir = workdir();
    const record = seed(dir);

    const first = run(dir, [record.id]);
    const second = run(dir, [record.id]);
    const [firstCode, secondCode] = await Promise.all([first.waitForExit(), second.waitForExit()]);
    const codes = [firstCode, secondCode].sort();
    expect(codes).toEqual([0, 1]);
    const loser = firstCode === 1 ? first : second;
    expect(loser.stderr()).toMatch(/claim/i);
  });
});

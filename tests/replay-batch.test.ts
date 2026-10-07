import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { startRaw, type RawSession } from './helpers/raw-client.js';
import { quoteCommandLine } from '../src/replay/command-line.js';
import { newFailureRecordId, type FailureRecord } from '../src/queue/failure-record.js';
import { SqliteQueueProvider } from '../src/queue/sqlite-queue.js';
import { hashArguments } from '../src/redaction/redact.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const ECHO = fileURLToPath(new URL('../build/examples/echo-server/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];
const providers: SqliteQueueProvider[] = [];

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'mcprelay-replay-batch-'));
}

function configPath(dir: string): string {
  const path = join(dir, 'mcprelay.config.yaml');
  writeFileSync(
    path,
    `queue:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'queue.db')}\n` +
      `store:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'history.db')}\n` +
      `reliability:\n  timeout_ms: 5000\n`,
    'utf8',
  );
  return path;
}

function queueOf(dir: string): SqliteQueueProvider {
  const provider = new SqliteQueueProvider({ path: join(dir, 'queue.db') });
  providers.push(provider);
  return provider;
}

function seed(dir: string, overrides: Partial<FailureRecord> = {}): FailureRecord {
  const record: FailureRecord = {
    id: newFailureRecordId(),
    correlation_id: 'corr-batch-1',
    captured_at: '2026-09-29T10:00:00.000Z',
    caller: { type: 'stdio', identity: 'local' },
    server: { name: 'echo-server', command: quoteCommandLine(NODE, [ECHO]), transport: 'stdio' },
    tool: { name: 'echo', arguments_hash: hashArguments({ value: 1 }), arguments: { value: 1 } },
    failure: { class: 'upstream_error', message: 'boom', attempts: 1 },
    replay: { status: 'pending', attempts: [], last_outcome: null },
    ...overrides,
  };
  const provider = queueOf(dir);
  void provider.enqueue(record);
  return record;
}

function toolCall(name: string, value: number): Partial<FailureRecord> {
  return {
    tool: { name, arguments_hash: hashArguments({ value }), arguments: { value } },
  };
}

function runBatch(dir: string, args: string[] = []): RawSession {
  const raw = startRaw(NODE, [CLI, 'replay', 'run', '--all', '--config', configPath(dir), ...args]);
  sessions.push(raw);
  return raw;
}

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
  for (const provider of providers.splice(0)) provider.close();
});

describe('replay run --all', () => {
  it('selects pending records with filters and respects the limit', async () => {
    const dir = workdir();
    const older = seed(dir, toolCall('echo', 1));
    const newer = seed(dir, toolCall('echo', 2));
    seed(dir, toolCall('boom', 3));

    const raw = runBatch(dir, ['--tool', 'echo', '--limit', '1']);
    expect(await raw.nextLine()).toContain('replay ok');
    expect(await raw.waitForExit()).toBe(0);

    const queue = queueOf(dir);
    expect((await queue.get(newer.id))?.replay.status).toBe('replayed');
    expect((await queue.get(older.id))?.replay.status).toBe('pending');
  });

  it('reports per-record outcomes and a summary, exiting non-zero when any fail', async () => {
    const dir = workdir();
    seed(dir, toolCall('echo', 1));
    seed(dir, toolCall('boom', 2));

    const raw = runBatch(dir);
    const firstLine = await raw.nextLine();
    const summary = await raw.nextLine();

    expect(firstLine).toContain('replay ok');
    expect(summary).toContain('2 selected, 1 ok, 1 failed, 0 skipped');
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('replay failed');
  });

  it('exits zero when nothing matches', async () => {
    const dir = workdir();
    seed(dir, toolCall('echo', 1));

    const raw = runBatch(dir, ['--tool', 'nope']);
    expect(await raw.nextLine()).toContain('0 selected, 0 ok, 0 failed, 0 skipped');
    expect(await raw.waitForExit()).toBe(0);
  });

  it('rejects --set together with --all', async () => {
    const dir = workdir();
    const raw = runBatch(dir, ['--set', 'value=9']);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain("'--set' is not supported with '--all'");
  });

  it('rejects a positional id together with --all', async () => {
    const dir = workdir();
    const record = seed(dir);
    const raw = startRaw(NODE, [
      CLI,
      'replay',
      'run',
      '--all',
      record.id,
      '--config',
      configPath(dir),
    ]);
    sessions.push(raw);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain('not both');
  });

  it('skips records whose arguments still contain redaction markers', async () => {
    const dir = workdir();
    const redacted = seed(dir, {
      tool: {
        name: 'echo',
        arguments_hash: 'hash-redacted',
        arguments: { api_key: '[REDACTED]' },
      },
    });

    const raw = runBatch(dir);
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('replay skipped');
    const queue = queueOf(dir);
    expect((await queue.get(redacted.id))?.replay.status).toBe('pending');
  });

  it('dry-run inspects every record and leaves it pending', async () => {
    const dir = workdir();
    const record = seed(dir, toolCall('echo', 1));

    const raw = runBatch(dir, ['--dry-run']);
    expect(await raw.waitForExit()).toBe(0);
    expect(raw.stdout()).toContain('dry-run:');
    expect(raw.stdout()).toContain('1 selected, 1 ok, 0 failed, 0 skipped');
    const queue = queueOf(dir);
    expect((await queue.get(record.id))?.replay.status).toBe('pending');
  });

  it('emits one JSON summary with per-record outcomes', async () => {
    const dir = workdir();
    const record = seed(dir, toolCall('echo', 1));

    const raw = runBatch(dir, ['--json']);
    expect(await raw.waitForExit()).toBe(0);
    const summary = JSON.parse(raw.stdout().trim().split('\n').pop() as string) as {
      all: boolean;
      selected: number;
      ok: number;
      failed: number;
      skipped: number;
      records: Array<{ id: string; status: string }>;
    };
    expect(summary).toMatchObject({ all: true, selected: 1, ok: 1, failed: 0, skipped: 0 });
    expect(summary.records).toEqual([{ id: record.id, status: 'ok' }]);
  });

  it('skips a record already claimed by another replay', async () => {
    const dir = workdir();
    const record = seed(dir, toolCall('echo', 1));
    const queue = queueOf(dir);
    await queue.claim(record.id, 60_000);

    const raw = runBatch(dir);
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('replay skipped');
    expect((await queue.get(record.id))?.replay.status).toBe('pending');
  });

  it('never executes a record twice across concurrent batches', async () => {
    const dir = workdir();
    const first = seed(dir, toolCall('echo', 1));
    const second = seed(dir, toolCall('echo', 2));

    const batchA = runBatch(dir);
    const batchB = runBatch(dir);
    const codes = await Promise.all([batchA.waitForExit(), batchB.waitForExit()]);
    expect(codes.every((code) => code === 0 || code === 1)).toBe(true);

    const queue = queueOf(dir);
    for (const record of [first, second]) {
      const updated = await queue.get(record.id);
      expect(updated?.replay.status).toBe('replayed');
      expect(updated?.replay.attempts.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { startRaw, waitForStderr, type RawSession } from './helpers/raw-client.js';
import { SqliteQueueProvider } from '../src/queue/sqlite-queue.js';
import { newFailureRecordId, type FailureRecord } from '../src/queue/failure-record.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];

function seeded(): { dir: string; configPath: string; record: FailureRecord } {
  const dir = mkdtempSync(join(tmpdir(), 'mcprelay-replay-'));
  const configPath = join(dir, 'mcprelay.config.yaml');
  writeFileSync(
    configPath,
    `queue:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'queue.db')}\n`,
    'utf8',
  );
  const record: FailureRecord = {
    id: newFailureRecordId(),
    correlation_id: 'corr-replay-1',
    captured_at: '2026-09-28T12:00:00.000Z',
    caller: { type: 'stdio', identity: 'local' },
    server: { name: 'echo-server', command: 'node echo.js' },
    tool: { name: 'flaky', arguments_hash: 'b'.repeat(64), arguments: { api_key: '[REDACTED]' } },
    failure: { class: 'upstream_error', message: 'flaky failure 1', attempts: 3 },
    replay: { status: 'pending', attempts: [], last_outcome: null },
  };
  const provider = new SqliteQueueProvider({ path: join(dir, 'queue.db') });
  // Seeding is synchronous under the hood; fire and forget with a sync flush.
  void provider.enqueue(record);
  provider.close();
  return { dir, configPath, record };
}

function run(args: string[]): RawSession {
  const raw = startRaw(NODE, [CLI, ...args]);
  sessions.push(raw);
  return raw;
}

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
});

describe('mcprelay replay list', () => {
  it('lists captured records with the key fields', async () => {
    const { configPath, record } = seeded();
    const raw = run(['replay', 'list', '--config', configPath]);

    const line = await raw.nextLine();
    expect(line).toContain(record.id);
    expect(line).toContain('flaky');
    expect(line).toContain('upstream_error');
    expect(line).toContain('pending');
    expect(await raw.waitForExit()).toBe(0);
  });

  it('emits machine-readable JSON', async () => {
    const { configPath, record } = seeded();
    const raw = run(['replay', 'list', '--config', configPath, '--json']);

    const parsed = JSON.parse(await raw.nextLine()) as FailureRecord[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe(record.id);
  });

  it('filters by tool', async () => {
    const { configPath } = seeded();
    const raw = run(['replay', 'list', '--config', configPath, '--tool', 'other', '--json']);
    expect(JSON.parse(await raw.nextLine())).toEqual([]);
  });

  it('reports a missing explicit config', async () => {
    const raw = run(['replay', 'list', '--config', '/tmp/does-not-exist-mcprelay.yaml']);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain('/tmp/does-not-exist-mcprelay.yaml');
  });
});

describe('mcprelay replay inspect', () => {
  it('prints the full record', async () => {
    const { configPath, record } = seeded();
    const raw = run(['replay', 'inspect', record.id, '--config', configPath, '--json']);

    const parsed = JSON.parse(await raw.nextLine()) as FailureRecord;
    expect(parsed.id).toBe(record.id);
    expect(parsed.tool.arguments).toEqual({ api_key: '[REDACTED]' });
    expect(await raw.waitForExit()).toBe(0);
  });

  it('exits 1 for an unknown id', async () => {
    const { configPath } = seeded();
    const raw = run(['replay', 'inspect', '01J000000000000000000000XX', '--config', configPath]);
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('not found');
  });

  it('rejects a missing id with a usage error', async () => {
    const { configPath } = seeded();
    const raw = run(['replay', 'inspect', '--config', configPath]);
    expect(await raw.waitForExit()).toBe(2);
  });
});

describe('mcprelay replay database errors', () => {
  it('reports a clean error when the queue database cannot be opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprelay-replay-'));
    const configPath = join(dir, 'mcprelay.config.yaml');
    writeFileSync(configPath, `queue:\n  provider: sqlite\n  sqlite:\n    path: ${dir}\n`, 'utf8');
    const raw = run(['replay', 'list', '--config', configPath]);
    expect(await raw.waitForExit()).toBe(1);
    expect(raw.stderr()).toContain('cannot open queue database');
  });
});

describe('replay parser characterization', () => {
  const cases: Array<[string, string]> = [
    ['replay list --config', "Missing value for '--config'."],
    ['replay list --tool', "Missing value for '--tool'."],
    ['replay list --correlation-id', "Missing value for '--correlation-id'."],
    ['replay list --since', "Missing value for '--since'."],
    ['replay list --until', "Missing value for '--until'."],
    ['replay list --status', "Missing value for '--status'."],
    ['replay list --status bogus', "Invalid status 'bogus'."],
    ['replay list --limit', "Invalid value for '--limit': undefined"],
    ['replay list --limit abc', "Invalid value for '--limit': abc"],
    ['replay list --limit 0', "Invalid value for '--limit': 0"],
    ['replay list --bogus', "Unknown option '--bogus'."],
    ['replay inspect', 'Missing record id. Usage: mcprelay replay inspect <id>'],
    ['replay inspect one two', "Unknown option 'two'."],
    ['replay inspect --json', 'Missing record id. Usage: mcprelay replay inspect <id>'],
    ['replay run', 'Missing record id. Usage: mcprelay replay run <id>'],
    ['replay run --set', "Missing value for '--set'."],
    ['replay run --set nope', "Invalid --set 'nope'; expected key=value."],
    ['replay run a b', "Unknown option 'b'."],
    ['replay run --bogus', "Unknown option '--bogus'."],
    ['replay run --dry-run', 'Missing record id. Usage: mcprelay replay run <id>'],
    ['replay run --force --json', 'Missing record id. Usage: mcprelay replay run <id>'],
  ];

  it.each(cases)('rejects "%s" with exit 2 and the exact message', async (commandLine, message) => {
    const raw = run(commandLine.split(' '));
    await waitForStderr(raw, message);
    expect(await raw.waitForExit()).toBe(2);
  });
});

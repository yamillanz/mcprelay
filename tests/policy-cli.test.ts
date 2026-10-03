import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, waitForStderr, type RawSession } from './helpers/raw-client.js';
import { SqliteQueueProvider } from '../src/queue/sqlite-queue.js';
import { newFailureRecordId, type FailureRecord } from '../src/queue/failure-record.js';
import { SqliteStore } from '../src/store/sqlite-store.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const ECHO = fileURLToPath(new URL('../build/examples/echo-server/index.js', import.meta.url));
const NODE = process.execPath;

const POLICY_YAML = `policy:
  default: allow
  rules:
    - tool: echo
      args:
        path:
          prefix: /projects
      action: deny
    - tool: deploy
      caller: ci-bot
      action: deny
`;

const sessions: RawSession[] = [];

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'mcprelay-policy-cli-'));
}

function configFile(dir: string, policyYaml: string): string {
  const path = join(dir, 'mcprelay.config.yaml');
  writeFileSync(
    path,
    `queue:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'queue.db')}\n` +
      `store:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'history.db')}\n` +
      policyYaml,
    'utf8',
  );
  return path;
}

function seedRecord(dir: string, argumentsValue: unknown): FailureRecord {
  const record: FailureRecord = {
    id: newFailureRecordId(),
    correlation_id: 'corr-policy-1',
    captured_at: '2026-09-29T12:00:00.000Z',
    caller: { type: 'stdio', identity: 'local' },
    server: { name: 'echo-server', command: 'node echo.js', transport: 'stdio' },
    tool: { name: 'echo', arguments_hash: 'c'.repeat(64), arguments: argumentsValue },
    failure: { class: 'upstream_error', message: 'boom', attempts: 1 },
    replay: { status: 'pending', attempts: [], last_outcome: null },
  };
  const provider = new SqliteQueueProvider({ path: join(dir, 'queue.db') });
  void provider.enqueue(record);
  provider.close();
  return record;
}

function run(args: string[]): RawSession {
  const raw = startRaw(NODE, [CLI, ...args]);
  sessions.push(raw);
  return raw;
}

function storeOf(dir: string): SqliteStore {
  const store = new SqliteStore({ path: join(dir, 'history.db') });
  sessions.push({ close: () => store.close() } as unknown as RawSession);
  return store;
}

/** Waits until stdout contains the marker (async flush), then returns all of it. */
async function outputUntil(raw: RawSession, marker: string): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (raw.stdout().includes(marker)) return raw.stdout();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return raw.stdout();
}

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
});

describe('FR-Y3 — mcprelay policy test', () => {
  it('prints the would-be denial and the matched rule', async () => {
    const dir = workdir();
    const configPath = configFile(dir, POLICY_YAML);
    const raw = run([
      'policy',
      'test',
      '--config',
      configPath,
      '--tool',
      'echo',
      '--args',
      '{"path":"/projects/a"}',
    ]);

    const output = await outputUntil(raw, 'reason:');
    expect(output).toContain('decision: deny');
    expect(output).toContain('#1');
    expect(await raw.waitForExit()).toBe(0);
  });

  it('reports allow when no rule matches', async () => {
    const dir = workdir();
    const configPath = configFile(dir, POLICY_YAML);
    const raw = run([
      'policy',
      'test',
      '--config',
      configPath,
      '--tool',
      'echo',
      '--args',
      '{"path":"/tmp/a"}',
    ]);

    expect(await outputUntil(raw, 'reason:')).toContain('decision: allow');
    expect(await raw.waitForExit()).toBe(0);
  });

  it('honors the simulated caller identity', async () => {
    const dir = workdir();
    const configPath = configFile(dir, POLICY_YAML);
    const raw = run([
      'policy',
      'test',
      '--config',
      configPath,
      '--tool',
      'deploy',
      '--caller',
      'ci-bot',
    ]);

    expect(await outputUntil(raw, 'reason:')).toContain('decision: deny');
    expect(await raw.waitForExit()).toBe(0);
  });

  it('emits a single parseable JSON document', async () => {
    const dir = workdir();
    const configPath = configFile(dir, POLICY_YAML);
    const raw = run([
      'policy',
      'test',
      '--config',
      configPath,
      '--tool',
      'echo',
      '--args',
      '{"path":"/projects/a"}',
      '--json',
    ]);

    const parsed = JSON.parse(await raw.nextLine()) as {
      tool: string;
      caller: string;
      decision: string;
      rule: number | null;
      reason: string;
    };
    expect(parsed).toMatchObject({ tool: 'echo', caller: 'local', decision: 'deny', rule: 1 });
    expect(await raw.waitForExit()).toBe(0);
  });

  it('evaluates a stored call by id', async () => {
    const dir = workdir();
    const configPath = configFile(dir, POLICY_YAML);
    const record = seedRecord(dir, { path: '/projects/secret.txt' });
    const raw = run(['policy', 'test', '--config', configPath, '--id', record.id, '--json']);

    const parsed = JSON.parse(await raw.nextLine()) as { decision: string; tool: string };
    expect(parsed).toMatchObject({ decision: 'deny', tool: 'echo' });
    expect(await raw.waitForExit()).toBe(0);
  });

  it('exits 1 for an unknown record id', async () => {
    const dir = workdir();
    const configPath = configFile(dir, POLICY_YAML);
    const raw = run([
      'policy',
      'test',
      '--config',
      configPath,
      '--id',
      '01J000000000000000000000XX',
    ]);
    await waitForStderr(raw, 'not found');
    expect(await raw.waitForExit()).toBe(1);
  });

  it('rejects invalid arguments and missing selectors with exit 2', async () => {
    const dir = workdir();
    const configPath = configFile(dir, POLICY_YAML);

    const badArgs = run([
      'policy',
      'test',
      '--config',
      configPath,
      '--tool',
      'echo',
      '--args',
      'not-json',
    ]);
    expect(await badArgs.waitForExit()).toBe(2);

    const noSelector = run(['policy', 'test', '--config', configPath]);
    await waitForStderr(noSelector, '--tool');
    expect(await noSelector.waitForExit()).toBe(2);
  });
});

describe('FR-Y3 — run --policy-dry-run', () => {
  it('forwards a would-be-denied call and logs it as unenforced', async () => {
    const dir = workdir();
    const configPath = configFile(
      dir,
      `policy:\n  default: allow\n  rules:\n    - tool: echo\n      action: deny\n`,
    );
    const raw = startRaw(NODE, [
      CLI,
      'run',
      '--policy-dry-run',
      '--config',
      configPath,
      '--',
      NODE,
      ECHO,
    ]);
    sessions.push(raw);

    raw.send(
      requestFrame(1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
        clientInfo: { name: 'raw-test-client', version: '0.0.0' },
      }),
    );
    await raw.nextMessage();
    raw.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    raw.send(requestFrame(10, 'tools/call', { name: 'echo', arguments: { value: 1 } }));
    const response = (await raw.nextMessage(15000)) as { result?: { content: unknown[] } };
    expect(response.result).toBeDefined();

    raw.send(requestFrame(11, 'x/stats'));
    const stats = (await raw.nextMessage()) as { result: { toolCalls: number } };
    expect(stats.result.toolCalls).toBe(1);

    await waitForStderr(raw, '"enforced":false');
    const log = raw
      .stderr()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { tool: string; decision: string; enforced?: boolean })
      .find((entry) => entry.tool === 'echo');
    expect(log).toMatchObject({ decision: 'denied', enforced: false });
    expect(await storeOf(dir).listAudit()).toEqual([]);
  });
});

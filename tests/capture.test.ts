import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, type RawSession } from './helpers/raw-client.js';
import { SqliteQueueProvider } from '../src/queue/sqlite-queue.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import { hashArguments, REDACTED } from '../src/redaction/redact.js';
import type { FailureRecord } from '../src/queue/failure-record.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const ECHO = fileURLToPath(new URL('../build/examples/echo-server/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'mcprelay-capture-'));
}

function configFile(dir: string, extra = ''): string {
  const path = join(dir, 'mcprelay.config.yaml');
  writeFileSync(
    path,
    `queue:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'queue.db')}\n` +
      `store:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'history.db')}\n` +
      extra,
    'utf8',
  );
  return path;
}

function proxy(dir: string, extra = ''): RawSession {
  const raw = startRaw(NODE, [CLI, 'run', '--config', configFile(dir, extra), '--', NODE, ECHO]);
  sessions.push(raw);
  return raw;
}

async function handshake(raw: RawSession): Promise<void> {
  raw.send(
    requestFrame(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
      clientInfo: { name: 'raw-test-client', version: '0.0.0' },
    }),
  );
  await raw.nextMessage();
  raw.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function callTool(
  raw: RawSession,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ result?: Record<string, unknown>; error?: { code: number } }> {
  raw.send(requestFrame(id, 'tools/call', { name, arguments: args }));
  return (await raw.nextMessage(15000)) as {
    result?: Record<string, unknown>;
    error?: { code: number };
  };
}

function queueOf(dir: string): SqliteQueueProvider {
  const provider = new SqliteQueueProvider({ path: join(dir, 'queue.db') });
  sessions.push({ close: () => provider.close() } as unknown as RawSession);
  return provider;
}

function storeOf(dir: string): SqliteStore {
  const store = new SqliteStore({ path: join(dir, 'history.db') });
  sessions.push({ close: () => store.close() } as unknown as RawSession);
  return store;
}

interface LogEntry {
  correlation_id: string;
  tool: string;
  decision: string;
  attempt: number;
}

function callLogs(raw: RawSession): LogEntry[] {
  return raw
    .stderr()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogEntry)
    .filter((entry) => entry.tool !== undefined);
}

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
});

describe('DLQ capture', () => {
  it('captures an exhausted retry before returning the error', async () => {
    const dir = workdir();
    const raw = proxy(
      dir,
      `reliability:\n  retry:\n    max_attempts: 2\n    base_ms: 10\n    jitter: false\n  per_tool:\n    flaky:\n      idempotent: true\n`,
    );
    await handshake(raw);

    const response = await callTool(raw, 10, 'flaky', { fail_times: 5 });
    expect(response.error).toBeTypeOf('object');

    const records = await queueOf(dir).list();
    expect(records).toHaveLength(1);
    const record = records[0] as FailureRecord;
    expect(record.tool.name).toBe('flaky');
    expect(record.failure.class).toBe('upstream_error');
    expect(record.failure.attempts).toBe(2);
    expect(record.replay.status).toBe('pending');
    expect(record.server.name).toBe('echo-server');
    expect(record.server.command).toContain('echo-server');
    expect(record.caller).toEqual({ type: 'stdio', identity: 'local' });
    expect(callLogs(raw).at(-1)?.correlation_id).toBe(record.correlation_id);
  });

  it('redacts arguments and hashes the raw ones', async () => {
    const dir = workdir();
    const raw = proxy(dir, `reliability:\n  retry:\n    max_attempts: 1\n`);
    await handshake(raw);

    const args = { api_key: 'sk-secret', nested: { token: 'tok-secret' }, safe: 'keep' };
    await callTool(raw, 10, 'flaky', { ...args, fail_times: 5 });

    const record = (await queueOf(dir).list())[0] as FailureRecord;
    const stored = record.tool.arguments as {
      api_key: string;
      nested: { token: string };
      safe: string;
    };
    expect(stored.api_key).toBe(REDACTED);
    expect(stored.nested.token).toBe(REDACTED);
    expect(stored.safe).toBe('keep');
    expect(record.tool.arguments_hash).toBe(hashArguments({ ...args, fail_times: 5 }));
  });

  it('maps failure classes from the D4 taxonomy', async () => {
    const dir = workdir();
    const raw = proxy(dir, `reliability:\n  timeout_ms: 50\n  retry:\n    max_attempts: 1\n`);
    await handshake(raw);

    await callTool(raw, 10, 'flaky-protocol');
    await callTool(raw, 11, 'sleep', { ms: 300 });
    await callTool(raw, 12, 'rpc-error');

    const classes = (await queueOf(dir).list()).map((record) => record.failure.class);
    expect(classes).toEqual(expect.arrayContaining(['non_retryable', 'timeout', 'upstream_error']));
  });

  it('never captures successes or cancellations', async () => {
    const dir = workdir();
    const raw = proxy(dir, `reliability:\n  timeout_ms: 5000\n  retry:\n    max_attempts: 2\n`);
    await handshake(raw);

    await callTool(raw, 10, 'echo', { ok: true });
    raw.send(requestFrame(11, 'tools/call', { name: 'sleep', arguments: { ms: 1000 } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    raw.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 11 },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await queueOf(dir).list()).toEqual([]);
  });

  it('captures tool errors only when the tool opts in', async () => {
    const dir = workdir();
    const raw = proxy(dir, `reliability:\n  retry:\n    max_attempts: 1\n`);
    await handshake(raw);
    await callTool(raw, 10, 'boom');
    expect(await queueOf(dir).list()).toEqual([]);
    raw.close();

    const dir2 = workdir();
    const raw2 = proxy(
      dir2,
      `reliability:\n  retry:\n    max_attempts: 1\n  per_tool:\n    boom:\n      capture_tool_errors: true\n`,
    );
    await handshake(raw2);
    await callTool(raw2, 10, 'boom');

    const records = await queueOf(dir2).list();
    expect(records).toHaveLength(1);
    expect(records[0]?.failure.class).toBe('tool_error');
  });

  it('writes an audit entry linking the correlation id and the failure id', async () => {
    const dir = workdir();
    const raw = proxy(dir, `reliability:\n  retry:\n    max_attempts: 1\n`);
    await handshake(raw);
    await callTool(raw, 10, 'flaky', { fail_times: 5 });

    const record = (await queueOf(dir).list())[0] as FailureRecord;
    const entries = await storeOf(dir).listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'captured',
      correlation_id: record.correlation_id,
      failure_id: record.id,
      tool_name: 'flaky',
    });
  });

  it('survives SIGKILL right after the error (durability)', async () => {
    const dir = workdir();
    const raw = proxy(dir, `reliability:\n  retry:\n    max_attempts: 1\n`);
    await handshake(raw);

    const response = await callTool(raw, 10, 'flaky', { fail_times: 5 });
    expect(response.error).toBeTypeOf('object');

    raw.child.kill('SIGKILL');
    await raw.waitForExit(5000);

    const records = await queueOf(dir).list();
    expect(records).toHaveLength(1);
    expect(records[0]?.tool.name).toBe('flaky');
  });
});

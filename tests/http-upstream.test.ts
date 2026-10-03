import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, type RawSession } from './helpers/raw-client.js';
import { SqliteQueueProvider } from '../src/queue/sqlite-queue.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import { newFailureRecordId, type FailureRecord } from '../src/queue/failure-record.js';
import { hashArguments } from '../src/redaction/redact.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const HTTP_ECHO = fileURLToPath(
  new URL('../build/examples/http-echo-server/index.js', import.meta.url),
);
const NODE = process.execPath;

const sessions: RawSession[] = [];
const fixtures: ChildProcess[] = [];

async function startFixture(): Promise<string> {
  const child = spawn(NODE, [HTTP_ECHO], { stdio: ['ignore', 'pipe', 'pipe'] });
  fixtures.push(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(
      () => reject(new Error(`fixture did not print a URL: ${stderr}`)),
      10000,
    );
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const match = /listening on (\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1] as string);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited ${String(code)}: ${stderr}`));
    });
  });
}

function stopFixture(child: ChildProcess): void {
  if (!child.killed) child.kill('SIGKILL');
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'mcprelay-http-'));
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

function proxy(url: string, configPath: string, extraArgs: string[] = []): RawSession {
  const raw = startRaw(NODE, [CLI, 'run', '--http', url, '--config', configPath, ...extraArgs]);
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
  meta?: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const params: Record<string, unknown> = { name, arguments: args };
  if (meta) params._meta = meta;
  raw.send(requestFrame(id, 'tools/call', params));
  return (await raw.nextMessage(15000)) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

async function upstreamStats(raw: RawSession, id = 900): Promise<Record<string, unknown>> {
  raw.send(requestFrame(id, 'x/stats'));
  const response = (await raw.nextMessage(15000)) as { result: Record<string, unknown> };
  return response.result;
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
  tool: string;
  decision: string;
  attempt: number;
  error?: { message: string; code?: number };
}

function callLogs(raw: RawSession): LogEntry[] {
  return raw
    .stderr()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogEntry)
    .filter((entry) => entry.tool !== undefined);
}

function seedHttpRecord(dir: string, url: string): FailureRecord {
  const record: FailureRecord = {
    id: newFailureRecordId(),
    correlation_id: 'corr-http-replay',
    captured_at: new Date().toISOString(),
    caller: { type: 'stdio', identity: 'local' },
    server: { name: 'http-echo-server', command: url, transport: 'http' },
    tool: { name: 'echo', arguments_hash: hashArguments({ value: 7 }), arguments: { value: 7 } },
    failure: { class: 'upstream_error', message: 'boom', attempts: 1 },
    replay: { status: 'pending', attempts: [], last_outcome: null },
  };
  const provider = new SqliteQueueProvider({ path: join(dir, 'queue.db') });
  void provider.enqueue(record);
  provider.close();
  return record;
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
  for (const fixture of fixtures.splice(0)) stopFixture(fixture);
});

describe('http-transport — wrapping and fidelity', () => {
  it('mirrors the upstream session and lists its tools', async () => {
    const url = await startFixture();
    const dir = workdir();
    const raw = proxy(url, configFile(dir));
    const init = await (async () => {
      raw.send(
        requestFrame(1, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
          clientInfo: { name: 'raw-test-client', version: '0.0.0' },
        }),
      );
      const response = (await raw.nextMessage(15000)) as {
        result: { serverInfo: { name: string } };
      };
      raw.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return response;
    })();
    expect(init.result.serverInfo.name).toBe('http-echo-server');

    raw.send(requestFrame(2, 'tools/list'));
    const listing = (await raw.nextMessage(15000)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listing.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['echo', 'boom', 'rpc-error', 'sleep']),
    );
  });

  it('relays tools/call and results over HTTP', async () => {
    const url = await startFixture();
    const raw = proxy(url, configFile(workdir()));
    await handshake(raw);

    const call = await callTool(raw, 10, 'echo', { value: 42 });
    expect(JSON.parse((call.result!.content as Array<{ text: string }>)[0]!.text)).toEqual({
      value: 42,
    });

    const boom = await callTool(raw, 11, 'boom');
    expect(boom.result?.isError).toBe(true);
  });

  it('enforces policy without forwarding, and tools/list stays unfiltered', async () => {
    const url = await startFixture();
    const dir = workdir();
    const raw = proxy(
      url,
      configFile(
        dir,
        'policy:\n  default: allow\n  rules:\n    - tool: echo\n      action: deny\n',
      ),
    );
    await handshake(raw);

    raw.send(requestFrame(2, 'tools/list'));
    const listing = (await raw.nextMessage(15000)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listing.result.tools.map((tool) => tool.name)).toContain('echo');

    const denied = await callTool(raw, 10, 'echo', {});
    expect(denied.error?.code).toBe(-32001);

    const stats = await upstreamStats(raw);
    expect(stats.toolCalls).toBe(0);

    const audit = await storeOf(dir).listAudit();
    expect(audit.some((entry) => entry.kind === 'denied')).toBe(true);
  });

  it('captures failures with the http transport recorded', async () => {
    const url = await startFixture();
    const dir = workdir();
    const raw = proxy(url, configFile(dir, 'reliability:\n  retry:\n    max_attempts: 1\n'));
    await handshake(raw);

    const failed = await callTool(raw, 10, 'rpc-error');
    expect(failed.error?.code).toBe(-32000);

    const records = await queueOf(dir).list();
    expect(records).toHaveLength(1);
    const record = records[0] as FailureRecord;
    expect(record.server.transport).toBe('http');
    expect(record.server.command).toBe(url);
  });

  it('rejects batch frames with a clear error and forwards nothing', async () => {
    const url = await startFixture();
    const raw = proxy(url, configFile(workdir()));
    await handshake(raw);

    raw.sendLine(JSON.stringify([requestFrame(20, 'ping')]));
    const response = (await raw.nextMessage(15000)) as {
      error?: { code: number; message: string };
    };
    expect(response.error?.code).toBe(-32600);
    expect(response.error?.message).toContain('batch');

    const stats = await upstreamStats(raw);
    expect(stats.toolCalls).toBe(0);
  });

  it('sends configured headers and never forwards client credentials', async () => {
    const url = await startFixture();
    const raw = proxy(
      url,
      configFile(
        workdir(),
        'upstream:\n  http:\n    headers:\n      x-test-header: configured-value\n',
      ),
    );
    await handshake(raw);

    await callTool(raw, 10, 'echo', { value: 1 }, { authorization: 'Bearer client-token' });
    const stats = await upstreamStats(raw);
    const headers = stats.lastHeaders as Record<string, string>;
    expect(headers['x-test-header']).toBe('configured-value');
    expect(JSON.stringify(headers)).not.toContain('client-token');
  });
});

describe('http-transport — D4 classification', () => {
  it('retries a pre-execution connection failure and captures it as transport', async () => {
    const url = await startFixture();
    const dir = workdir();
    const raw = proxy(
      url,
      configFile(
        dir,
        'reliability:\n  retry:\n    max_attempts: 2\n    base_ms: 10\n    jitter: false\n',
      ),
    );
    await handshake(raw);

    for (const fixture of fixtures) stopFixture(fixture);

    const failed = await callTool(raw, 10, 'echo', { value: 1 });
    expect(failed.error).toBeTypeOf('object');
    expect(callLogs(raw).at(-1)?.attempt).toBe(2);

    const record = (await queueOf(dir).list())[0] as FailureRecord;
    expect(record.failure.class).toBe('transport');
  });

  it('does not auto-retry an HTTP 500 for a non-idempotent tool', async () => {
    const url = await startFixture();
    const dir = workdir();
    const raw = proxy(
      url,
      configFile(
        dir,
        'reliability:\n  retry:\n    max_attempts: 3\n    base_ms: 10\n    jitter: false\n',
      ),
    );
    await handshake(raw);

    const failed = await callTool(raw, 10, 'http-error');
    expect(failed.error).toBeTypeOf('object');
    expect(callLogs(raw).at(-1)?.attempt).toBe(1);

    const record = (await queueOf(dir).list())[0] as FailureRecord;
    expect(record.failure.attempts).toBe(1);
  });

  it('retries an HTTP 500 for an idempotent tool', async () => {
    const url = await startFixture();
    const dir = workdir();
    const raw = proxy(
      url,
      configFile(
        dir,
        'reliability:\n  retry:\n    max_attempts: 2\n    base_ms: 10\n    jitter: false\n  per_tool:\n    http-error:\n      idempotent: true\n',
      ),
    );
    await handshake(raw);

    await callTool(raw, 10, 'http-error');
    expect(callLogs(raw).at(-1)?.attempt).toBe(2);
  });

  it('gates timeout retries on idempotent over HTTP', async () => {
    const url = await startFixture();

    const nonIdempotentDir = workdir();
    const nonIdempotent = proxy(
      url,
      configFile(
        nonIdempotentDir,
        'reliability:\n  timeout_ms: 50\n  retry:\n    max_attempts: 2\n    base_ms: 10\n    jitter: false\n',
      ),
    );
    await handshake(nonIdempotent);
    await callTool(nonIdempotent, 10, 'sleep', { ms: 300 });
    expect(callLogs(nonIdempotent).at(-1)?.attempt).toBe(1);

    const idempotentDir = workdir();
    const idempotent = proxy(
      url,
      configFile(
        idempotentDir,
        'reliability:\n  timeout_ms: 50\n  retry:\n    max_attempts: 2\n    base_ms: 10\n    jitter: false\n  per_tool:\n    sleep:\n      idempotent: true\n',
      ),
    );
    await handshake(idempotent);
    await callTool(idempotent, 10, 'sleep', { ms: 300 });
    expect(callLogs(idempotent).at(-1)?.attempt).toBe(2);
  });
});

describe('http-transport — replay over HTTP', () => {
  it('re-executes an HTTP record against the recorded endpoint', async () => {
    const url = await startFixture();
    const dir = workdir();
    const record = seedHttpRecord(dir, url);
    const raw = startRaw(NODE, [CLI, 'replay', 'run', record.id, '--config', configFile(dir)]);
    sessions.push(raw);

    expect(await raw.nextLine(20000)).toContain('replay ok');
    expect(await raw.waitForExit(20000)).toBe(0);

    const updated = await queueOf(dir).get(record.id);
    expect(updated?.replay.status).toBe('replayed');
    expect((await storeOf(dir).listAudit()).some((entry) => entry.kind === 'replayed')).toBe(true);
  });

  it('dry-run lists tools over HTTP with zero tools/call', async () => {
    const url = await startFixture();
    const dir = workdir();
    const record = seedHttpRecord(dir, url);
    const raw = startRaw(NODE, [
      CLI,
      'replay',
      'run',
      record.id,
      '--dry-run',
      '--config',
      configFile(dir),
    ]);
    sessions.push(raw);

    expect(await outputUntil(raw, 'tool check:')).toContain('tool check:  present');
    expect(await raw.waitForExit(20000)).toBe(0);
    expect((await queueOf(dir).get(record.id))?.replay.status).toBe('pending');
  });

  it('never persists configured header values', async () => {
    const url = await startFixture();
    const dir = workdir();
    const configPath = configFile(
      dir,
      'upstream:\n  http:\n    headers:\n      authorization: Bearer super-secret-value\n',
    );
    const record = seedHttpRecord(dir, url);
    const raw = startRaw(NODE, [CLI, 'replay', 'run', record.id, '--config', configPath]);
    sessions.push(raw);
    expect(await raw.waitForExit(20000)).toBe(0);

    const databases = ['queue.db', 'queue.db-wal', 'history.db', 'history.db-wal'];
    for (const name of databases) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      expect(readFileSync(path, 'latin1')).not.toContain('super-secret-value');
    }
  });
});

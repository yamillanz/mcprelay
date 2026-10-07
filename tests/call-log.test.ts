import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, type RawSession } from './helpers/raw-client.js';
import { SqliteStore } from '../src/store/sqlite-store.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const ECHO = fileURLToPath(new URL('../build/examples/echo-server/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];

function proxy(): RawSession {
  const raw = startRaw(NODE, [CLI, 'run', '--', NODE, ECHO]);
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
): Promise<void> {
  raw.send(requestFrame(id, 'tools/call', { name, arguments: args }));
  await raw.nextMessage(8000);
}

interface LogEntry {
  timestamp: string;
  correlation_id: string;
  caller: { type: string; identity: string };
  server: string;
  tool: string;
  decision: string;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
  attempt: number;
  error?: { message: string; code?: number };
  enforced?: boolean;
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

describe('FR-O1 — structured call logs', () => {
  it('emits one complete JSON line for a successful call', async () => {
    const raw = proxy();
    await handshake(raw);
    await callTool(raw, 10, 'echo', { value: 1 });

    const logs = callLogs(raw);
    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry.decision).toBe('allowed');
    expect(entry.tool).toBe('echo');
    expect(entry.server).toBe('echo-server');
    expect(entry.caller).toEqual({ type: 'stdio', identity: 'local' });
    expect(entry.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.latency_ms).toBeGreaterThanOrEqual(0);
    expect(entry.request_bytes).toBeGreaterThan(0);
    expect(entry.response_bytes).toBeGreaterThan(0);
    expect(entry.attempt).toBe(1);
    expect(entry.error).toBeUndefined();
    expect(new Date(entry.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('logs an isError result as failed with an error', async () => {
    const raw = proxy();
    await handshake(raw);
    await callTool(raw, 11, 'boom');

    const logs = callLogs(raw);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.decision).toBe('failed');
    expect(logs[0]!.error?.message).toBe('isError result');
  });

  it('logs an upstream JSON-RPC error with its code', async () => {
    const raw = proxy();
    await handshake(raw);
    await callTool(raw, 12, 'rpc-error');

    const logs = callLogs(raw);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.decision).toBe('failed');
    expect(logs[0]!.error).toMatchObject({ code: -32000 });
  });

  it('never writes argument values into the log line', async () => {
    const raw = proxy();
    await handshake(raw);
    await callTool(raw, 13, 'echo', { api_key: 'super-secret-value' });

    expect(raw.stderr()).not.toContain('super-secret-value');
  });

  it('writes machine-readable lines only', async () => {
    const raw = proxy();
    await handshake(raw);
    await callTool(raw, 14, 'echo', { value: 2 });

    for (const line of raw.stderr().split('\n')) {
      if (line.startsWith('{')) expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it('keeps the failure line intact when the upstream crashes', async () => {
    const raw = proxy();
    await handshake(raw);
    raw.send(requestFrame(15, 'tools/call', { name: 'crash', arguments: { delay_ms: 20 } }));
    await raw.nextMessage(8000);
    await raw.waitForExit(8000);

    const logs = callLogs(raw);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.decision).toBe('failed');
    expect(logs[0]!.tool).toBe('crash');
  });
});

function parityWorkdir(): string {
  return mkdtempSync(join(tmpdir(), 'mcprelay-parity-'));
}

function parityConfig(dir: string, extra = ''): string {
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

function proxyWithConfig(configPath: string, flags: string[] = []): RawSession {
  const raw = startRaw(NODE, [CLI, 'run', '--config', configPath, ...flags, '--', NODE, ECHO]);
  sessions.push(raw);
  return raw;
}

function callEvents(dir: string): Array<Record<string, unknown>> {
  const db = new Database(join(dir, 'history.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM call_events ORDER BY at ASC, id ASC').all() as Array<
    Record<string, unknown>
  >;
  db.close();
  return rows;
}

describe('Call events mirror the log lines', () => {
  it('reconciles every decision one-for-one with the structured logs', async () => {
    const dir = parityWorkdir();
    const config = parityConfig(
      dir,
      'policy:\n  default: allow\n  rules:\n    - tool: rpc-error\n      action: deny\n',
    );
    const raw = proxyWithConfig(config);
    await handshake(raw);

    await callTool(raw, 10, 'echo', { value: 1 });
    await callTool(raw, 11, 'boom', {});
    await callTool(raw, 12, 'rpc-error', {});

    raw.send(requestFrame(13, 'tools/call', { name: 'sleep', arguments: { ms: 1000 } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    raw.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 13, reason: 'parity' },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const logs = callLogs(raw);
    expect(logs.map((entry) => entry.decision).sort()).toEqual([
      'allowed',
      'cancelled',
      'denied',
      'failed',
    ]);

    const events = callEvents(dir);
    expect(events).toHaveLength(logs.length);
    for (const log of logs) {
      const event = events.find((row) => row.correlation_id === log.correlation_id);
      expect(event).toBeDefined();
      expect(event).toMatchObject({
        tool: log.tool,
        decision: log.decision,
        request_bytes: log.request_bytes,
        response_bytes: log.response_bytes,
        attempt: log.attempt,
        caller_type: log.caller.type,
        caller_identity: log.caller.identity,
      });
    }

    const store = new SqliteStore({ path: join(dir, 'history.db') });
    const metrics = await store.metrics({});
    store.close();
    expect(metrics.decisions).toEqual({ allowed: 1, denied: 1, failed: 1, cancelled: 1 });
  });

  it('persists exactly one event for a success after retries', async () => {
    const dir = parityWorkdir();
    const config = parityConfig(
      dir,
      'reliability:\n  timeout_ms: 5000\n  per_tool:\n    flaky:\n      idempotent: true\n      timeout_ms: 5000\n      retry: { max_attempts: 5, base_ms: 1, jitter: false }\n',
    );
    const raw = proxyWithConfig(config);
    await handshake(raw);
    await callTool(raw, 10, 'flaky', {});

    const logs = callLogs(raw);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ decision: 'allowed', attempt: 3 });

    const events = callEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'allowed', attempt: 3, tool: 'flaky' });
  });

  it('logs dry-run denials without persisting an event', async () => {
    const dir = parityWorkdir();
    const config = parityConfig(
      dir,
      'policy:\n  default: allow\n  rules:\n    - tool: echo\n      action: deny\n',
    );
    const raw = proxyWithConfig(config, ['--policy-dry-run']);
    await handshake(raw);
    await callTool(raw, 10, 'echo', { value: 1 });

    const lines = callLogs(raw).map((entry) => ({
      decision: entry.decision,
      enforced: entry.enforced,
    }));
    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual({ decision: 'denied', enforced: false });
    expect(lines).toContainEqual({ decision: 'allowed', enforced: undefined });

    const events = callEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'allowed', tool: 'echo' });
  });

  it('warns on a store failure and still completes the call', async () => {
    const dir = parityWorkdir();
    writeFileSync(join(dir, 'blocker'), 'not a directory');
    const path = join(dir, 'mcprelay.config.yaml');
    writeFileSync(
      path,
      `store:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'blocker', 'history.db')}\n`,
      'utf8',
    );
    const raw = proxyWithConfig(path);
    await handshake(raw);
    await callTool(raw, 10, 'echo', { value: 1 });

    expect(callLogs(raw)).toHaveLength(1);
    expect(callLogs(raw)[0]?.decision).toBe('allowed');
    expect(raw.stderr()).toContain('metrics write failed');
  });
});

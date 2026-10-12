import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, waitForStderr, type RawSession } from './helpers/raw-client.js';
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

/**
 * Log lines arrive on stderr, a separate pipe from responses, so a response
 * can be observed before its log line. Wait for `count` lines; on timeout
 * return what arrived so the assertion reports the real diff.
 */
async function callLogsWhen(raw: RawSession, count: number, timeoutMs = 5000): Promise<LogEntry[]> {
  const deadline = Date.now() + timeoutMs;
  while (callLogs(raw).length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return callLogs(raw);
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

    const logs = await callLogsWhen(raw, 1);
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

    const logs = await callLogsWhen(raw, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.decision).toBe('failed');
    expect(logs[0]!.error?.message).toBe('isError result');
  });

  it('logs an upstream JSON-RPC error with its code', async () => {
    const raw = proxy();
    await handshake(raw);
    await callTool(raw, 12, 'rpc-error');

    const logs = await callLogsWhen(raw, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.decision).toBe('failed');
    expect(logs[0]!.error).toMatchObject({ code: -32000 });
  });

  it('never writes argument values into the log line', async () => {
    const raw = proxy();
    await handshake(raw);
    await callTool(raw, 13, 'echo', { api_key: 'super-secret-value' });

    await callLogsWhen(raw, 1);
    expect(raw.stderr()).not.toContain('super-secret-value');
  });

  it('writes machine-readable lines only', async () => {
    const raw = proxy();
    await handshake(raw);
    await callTool(raw, 14, 'echo', { value: 2 });

    await callLogsWhen(raw, 1);
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

    const logs = await callLogsWhen(raw, 1);
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

function rawRows(dbPath: string, sql: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

/** A never-created queue file means zero captures (the provider is lazy). */
function failureCount(dir: string): number {
  const path = join(dir, 'queue.db');
  if (!existsSync(path)) return 0;
  return rawRows(path, 'SELECT * FROM failures').length;
}

function callToolWithMeta(
  raw: RawSession,
  id: number,
  name: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown>,
): Promise<unknown> {
  raw.send(requestFrame(id, 'tools/call', { name, arguments: args, _meta: meta }));
  return raw.nextMessage(8000);
}

async function stats(raw: RawSession, id: number): Promise<Record<string, number>> {
  raw.send(requestFrame(id, 'x/stats'));
  const response = (await raw.nextMessage(8000)) as {
    result: { perTool: Record<string, number> };
  };
  return response.result.perTool;
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const IDENTITY_CONFIG = `identity:
  profile: reviewer-bot
  keys:
    - { key: sk-agent-a, identity: agent-a }
policy:
  default: allow
  rules:
    - { tool: boom, caller: reviewer-bot, action: deny }
reliability:
  timeout_ms: 30000
  per_tool:
    boom: { capture_tool_errors: true }
`;

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

    const logs = await callLogsWhen(raw, 4);
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

    const logs = await callLogsWhen(raw, 1);
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

    const lines = (await callLogsWhen(raw, 2)).map((entry) => ({
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

    await waitForStderr(raw, 'metrics write failed');
    const logs = await callLogsWhen(raw, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.decision).toBe('allowed');
    expect(raw.stderr()).toContain('metrics write failed');
  });
});

describe('Caller identities (FR-A1/A3)', () => {
  it('feeds the profile identity into logs, events, policy, and audit', async () => {
    const dir = parityWorkdir();
    const raw = proxyWithConfig(parityConfig(dir, IDENTITY_CONFIG));
    await handshake(raw);

    await callTool(raw, 10, 'echo', { value: 1 });
    await callTool(raw, 11, 'boom', {});

    const logs = await callLogsWhen(raw, 2);
    expect(logs.map((entry) => `${entry.tool}:${entry.decision}`).sort()).toEqual([
      'boom:denied',
      'echo:allowed',
    ]);
    for (const entry of logs) {
      expect(entry.caller).toEqual({ type: 'stdio', identity: 'reviewer-bot' });
    }
    expect(logs.find((entry) => entry.tool === 'boom')?.error?.message).toContain('policy denied');

    const events = callEvents(dir);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.caller_identity).toBe('reviewer-bot');
    }

    const audits = rawRows(join(dir, 'history.db'), "SELECT * FROM audit WHERE kind = 'denied'");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tool_name: 'boom' });
  });

  it('maps a presented key to its identity end to end', async () => {
    const dir = parityWorkdir();
    const raw = proxyWithConfig(parityConfig(dir, IDENTITY_CONFIG));
    await handshake(raw);

    await callToolWithMeta(raw, 12, 'boom', {}, { authorization: 'Bearer sk-agent-a' });

    const logs = await callLogsWhen(raw, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      tool: 'boom',
      decision: 'failed',
      caller: { type: 'stdio', identity: 'agent-a' },
    });

    const events = callEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.caller_identity).toBe('agent-a');

    const failures = rawRows(join(dir, 'queue.db'), 'SELECT * FROM failures');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.caller_identity).toBe('agent-a');
  });

  it('rejects an unknown key at the edge without forwarding or capturing', async () => {
    const dir = parityWorkdir();
    const raw = proxyWithConfig(parityConfig(dir, IDENTITY_CONFIG));
    await handshake(raw);

    const response = (await callToolWithMeta(
      raw,
      13,
      'echo',
      { value: 1 },
      { authorization: 'Bearer sk-nope' },
    )) as { error?: { code: number; message: string } };

    expect(response.error?.code).toBe(-32003);
    expect(response.error?.message).toContain('unrecognized api key');
    expect(JSON.stringify(response)).not.toContain('sk-nope');

    const perTool = await stats(raw, 14);
    expect(perTool.echo ?? 0).toBe(0);

    const audits = rawRows(join(dir, 'history.db'), "SELECT * FROM audit WHERE kind = 'denied'");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toContain('"action":"auth"');

    expect(failureCount(dir)).toBe(0);

    const logs = await callLogsWhen(raw, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      decision: 'denied',
      caller: { type: 'stdio', identity: 'unauthenticated' },
    });
    expect(raw.stderr()).not.toContain('sk-nope');
  });

  it('strips the credential before the stdio upstream while other meta keys survive', async () => {
    const dir = parityWorkdir();
    const raw = proxyWithConfig(parityConfig(dir, IDENTITY_CONFIG));
    await handshake(raw);

    const response = (await callToolWithMeta(
      raw,
      15,
      'echo-meta',
      { value: 1 },
      { authorization: 'Bearer sk-agent-a', keep: 'yes' },
    )) as { result: { content: Array<{ text: string }> } };

    const echoed = JSON.parse(response.result.content[0]?.text as string) as {
      meta: Record<string, unknown>;
    };
    expect(echoed.meta.authorization).toBeUndefined();
    expect(echoed.meta.keep).toBe('yes');
    expect(JSON.stringify(echoed.meta.mcprelay)).toContain('correlation_id');
    await callLogsWhen(raw, 1);
    expect(raw.stderr()).not.toContain('sk-agent-a');

    const events = callEvents(dir);
    expect(JSON.stringify(events)).not.toContain('sk-agent-a');
  });

  it('lets the CLI flag override the configured profile', async () => {
    const dir = parityWorkdir();
    const raw = proxyWithConfig(parityConfig(dir, IDENTITY_CONFIG), ['--identity', 'ci-bot']);
    await handshake(raw);
    await callTool(raw, 18, 'echo', { value: 1 });

    const logs = await callLogsWhen(raw, 1);
    expect(logs[0]?.caller).toEqual({ type: 'stdio', identity: 'ci-bot' });
    const events = callEvents(dir);
    expect(events[0]?.caller_identity).toBe('ci-bot');
  });

  it('groups report rows per resolved identity', async () => {
    const dir = parityWorkdir();
    const config = parityConfig(dir, IDENTITY_CONFIG);
    const raw = proxyWithConfig(config);
    await handshake(raw);

    await callTool(raw, 16, 'echo', { value: 1 });
    await callToolWithMeta(raw, 17, 'echo', { value: 2 }, { authorization: 'Bearer sk-agent-a' });

    const report = await runCli(['report', '--config', config, '--json']);
    expect(report.code).toBe(0);
    const doc = JSON.parse(report.stdout.trim()) as {
      tools: Array<{ caller: string; tool: string; calls: number }>;
    };
    expect(doc.tools.map((row) => `${row.caller}/${row.tool}:${row.calls}`).sort()).toEqual([
      'agent-a/echo:1',
      'reviewer-bot/echo:1',
    ]);
  });
});

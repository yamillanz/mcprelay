import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, type RawSession } from './helpers/raw-client.js';

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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, type RawSession } from './helpers/raw-client.js';
import { SqliteQueueProvider } from '../src/queue/sqlite-queue.js';
import { SqliteStore } from '../src/store/sqlite-store.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const ECHO = fileURLToPath(new URL('../build/examples/echo-server/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'mcprelay-policy-'));
}

function configFile(dir: string, policyYaml: string): string {
  const path = join(dir, 'mcprelay.config.yaml');
  writeFileSync(
    path,
    `queue:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'queue.db')}\n` +
      `store:\n  provider: sqlite\n  sqlite:\n    path: ${join(dir, 'history.db')}\n` +
      `reliability:\n  retry:\n    max_attempts: 1\n` +
      policyYaml,
    'utf8',
  );
  return path;
}

function proxy(dir: string, policyYaml: string): RawSession {
  const raw = startRaw(NODE, [
    CLI,
    'run',
    '--config',
    configFile(dir, policyYaml),
    '--',
    NODE,
    ECHO,
  ]);
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
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  raw.send(requestFrame(id, 'tools/call', { name, arguments: args }));
  return (await raw.nextMessage(15000)) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
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

const DENY_ECHO = `policy:\n  default: allow\n  rules:\n    - tool: echo\n      action: deny\n`;

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
});

describe('FR-Y4 — denials are enforced, audited, and never forwarded', () => {
  it('returns a standard MCP error and does not forward the call upstream', async () => {
    const dir = workdir();
    const raw = proxy(dir, DENY_ECHO);
    await handshake(raw);

    const denied = await callTool(raw, 10, 'echo', { value: 1 });
    expect(denied.result).toBeUndefined();
    expect(denied.error?.code).toBe(-32001);
    expect(denied.error?.message).toContain('policy denied');
    expect(denied.error?.message).toContain('echo');

    raw.send(requestFrame(11, 'x/stats'));
    const stats = (await raw.nextMessage()) as { result: { toolCalls: number } };
    expect(stats.result.toolCalls).toBe(0);
  });

  it('keeps the session alive after a denial', async () => {
    const dir = workdir();
    const raw = proxy(dir, DENY_ECHO);
    await handshake(raw);

    await callTool(raw, 10, 'echo', {});
    const allowed = await callTool(raw, 11, 'boom');
    expect(allowed.result?.isError).toBe(true);
  });

  it('writes a denied audit entry with the matched rule', async () => {
    const dir = workdir();
    const raw = proxy(dir, DENY_ECHO);
    await handshake(raw);
    await callTool(raw, 10, 'echo', { value: 1 });

    const log = callLogs(raw).at(-1);
    const entries = await storeOf(dir).listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'denied',
      correlation_id: log?.correlation_id,
      tool_name: 'echo',
    });
    expect(entries[0]?.detail).toMatchObject({ action: 'deny', rule: 1 });
  });

  it('never captures a denial in the DLQ', async () => {
    const dir = workdir();
    const raw = proxy(dir, DENY_ECHO);
    await handshake(raw);
    await callTool(raw, 10, 'echo', {});

    expect(await queueOf(dir).list()).toEqual([]);
  });

  it('logs decision denied with zero attempts', async () => {
    const dir = workdir();
    const raw = proxy(dir, DENY_ECHO);
    await handshake(raw);
    await callTool(raw, 10, 'echo', {});

    const entry = callLogs(raw).find((log) => log.tool === 'echo');
    expect(entry).toMatchObject({ decision: 'denied', attempt: 0 });
    expect(entry?.error?.message).toContain('policy denied');
    expect(entry?.enforced).toBeUndefined();
  });

  it('evaluates argument rules before forwarding', async () => {
    const dir = workdir();
    const raw = proxy(
      dir,
      `policy:\n  default: allow\n  rules:\n    - tool: echo\n      args:\n        path:\n          prefix: /projects\n      action: deny\n`,
    );
    await handshake(raw);

    const allowed = await callTool(raw, 10, 'echo', { path: '/tmp/a' });
    expect(allowed.error).toBeUndefined();

    const denied = await callTool(raw, 11, 'echo', { path: '/projects/a' });
    expect(denied.error?.code).toBe(-32001);

    raw.send(requestFrame(12, 'x/stats'));
    const stats = (await raw.nextMessage()) as { result: { toolCalls: number } };
    expect(stats.result.toolCalls).toBe(1);
  });
});

describe('FR-Y5 — tools/list is never filtered', () => {
  it('still lists a denied tool, and calling it is denied', async () => {
    const dir = workdir();
    const raw = proxy(dir, DENY_ECHO);
    await handshake(raw);

    raw.send(requestFrame(10, 'tools/list'));
    const listing = (await raw.nextMessage()) as { result: { tools: Array<{ name: string }> } };
    expect(listing.result.tools.map((tool) => tool.name)).toContain('echo');

    const denied = await callTool(raw, 11, 'echo', {});
    expect(denied.error?.code).toBe(-32001);
  });
});

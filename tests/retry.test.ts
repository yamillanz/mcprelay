import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, type RawSession } from './helpers/raw-client.js';
import { backoffDelayMs, runWithRetry } from '../src/pipeline/retry.js';
import type { AttemptOutcome } from '../src/pipeline/classify.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const ECHO = fileURLToPath(new URL('../build/examples/echo-server/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];

function configFile(yaml: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mcprelay-retry-')), 'mcprelay.config.yaml');
  writeFileSync(path, yaml, 'utf8');
  return path;
}

function proxy(yaml: string, echoArgs: string[] = []): RawSession {
  const raw = startRaw(NODE, [
    CLI,
    'run',
    '--config',
    configFile(yaml),
    '--',
    NODE,
    ECHO,
    ...echoArgs,
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

interface ToolResponse {
  id?: number;
  result?: { content?: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

async function callTool(
  raw: RawSession,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResponse> {
  raw.send(requestFrame(id, 'tools/call', { name, arguments: args }));
  return (await raw.nextMessage(15000)) as ToolResponse;
}

async function stats(raw: RawSession, id: number): Promise<Record<string, number>> {
  raw.send(requestFrame(id, 'x/stats'));
  const response = (await raw.nextMessage()) as { result: { perTool: Record<string, number> } };
  return response.result.perTool;
}

interface LogEntry {
  tool: string;
  decision: string;
  attempt: number;
  latency_ms: number;
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

describe('timeout (FR-R1)', () => {
  it('fails a non-idempotent timeout without retrying', async () => {
    const raw = proxy(`
reliability:
  timeout_ms: 50
  retry:
    max_attempts: 3
`);
    await handshake(raw);

    const response = await callTool(raw, 10, 'sleep', { ms: 300 });
    expect(response.error).toBeTypeOf('object');
    expect(await stats(raw, 11)).toMatchObject({ sleep: 1 });
    expect(callLogs(raw).at(-1)).toMatchObject({ decision: 'failed', attempt: 1 });
  });

  it('retries a timeout for an idempotent tool with a per-tool override', async () => {
    const raw = proxy(`
reliability:
  timeout_ms: 5000
  retry:
    max_attempts: 2
    base_ms: 10
    jitter: false
  per_tool:
    sleep:
      timeout_ms: 50
      idempotent: true
`);
    await handshake(raw);

    const response = await callTool(raw, 10, 'sleep', { ms: 300 });
    expect(response.error).toBeTypeOf('object');
    expect(await stats(raw, 11)).toMatchObject({ sleep: 2 });
    expect(callLogs(raw).at(-1)).toMatchObject({ decision: 'failed', attempt: 2 });
  });
});

describe('retry with backoff (FR-R2)', () => {
  it('retries a transient upstream error until success', async () => {
    const raw = proxy(`
reliability:
  retry:
    max_attempts: 3
    base_ms: 10
    jitter: false
  per_tool:
    flaky:
      idempotent: true
`);
    await handshake(raw);

    const response = await callTool(raw, 10, 'flaky', { fail_times: 2 });
    expect(response.error).toBeUndefined();
    expect(response.result?.content?.[0]?.text).toBe('flaky success on call 3');
    expect(await stats(raw, 11)).toMatchObject({ flaky: 3 });
    expect(callLogs(raw).at(-1)).toMatchObject({ decision: 'allowed', attempt: 3 });
  });

  it('never exceeds the attempt bound', async () => {
    const raw = proxy(`
reliability:
  retry:
    max_attempts: 2
    base_ms: 10
    jitter: false
  per_tool:
    flaky:
      idempotent: true
`);
    await handshake(raw);

    const response = await callTool(raw, 10, 'flaky', { fail_times: 5 });
    expect(response.error).toBeTypeOf('object');
    expect(await stats(raw, 11)).toMatchObject({ flaky: 2 });
    expect(callLogs(raw).at(-1)).toMatchObject({ decision: 'failed', attempt: 2 });
  });

  it('does not retry a transient error for a non-idempotent tool', async () => {
    const raw = proxy(`
reliability:
  retry:
    max_attempts: 3
    base_ms: 10
`);
    await handshake(raw);

    const response = await callTool(raw, 10, 'flaky', { fail_times: 5 });
    expect(response.error).toBeTypeOf('object');
    expect(await stats(raw, 11)).toMatchObject({ flaky: 1 });
  });

  it('never retries protocol errors, even for idempotent tools', async () => {
    const raw = proxy(`
reliability:
  retry:
    max_attempts: 3
    base_ms: 10
  per_tool:
    flaky-protocol:
      idempotent: true
`);
    await handshake(raw);

    const response = await callTool(raw, 10, 'flaky-protocol');
    expect(response.error).toMatchObject({ code: -32602 });
    expect(await stats(raw, 11)).toMatchObject({ 'flaky-protocol': 1 });
  });

  it('never retries isError results', async () => {
    const raw = proxy(`
reliability:
  retry:
    max_attempts: 3
    base_ms: 10
  per_tool:
    boom:
      idempotent: true
`);
    await handshake(raw);

    const response = await callTool(raw, 10, 'boom');
    expect(response.result?.isError).toBe(true);
    expect(await stats(raw, 11)).toMatchObject({ boom: 1 });
    expect(callLogs(raw).at(-1)).toMatchObject({ decision: 'failed', attempt: 1 });
  });

  it('waits exponentially between attempts when jitter is off', async () => {
    const raw = proxy(`
reliability:
  retry:
    max_attempts: 3
    base_ms: 50
    jitter: false
  per_tool:
    flaky:
      idempotent: true
`);
    await handshake(raw);

    const startedAt = Date.now();
    const response = await callTool(raw, 10, 'flaky', { fail_times: 2 });
    const elapsed = Date.now() - startedAt;
    expect(response.error).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });
});

describe('cancellation (FR-R2)', () => {
  it('aborts the in-flight attempt, stops retries, logs cancelled, and notifies upstream', async () => {
    const raw = proxy(`
reliability:
  timeout_ms: 5000
  retry:
    max_attempts: 3
`);
    await handshake(raw);

    raw.send(requestFrame(40, 'tools/call', { name: 'sleep', arguments: { ms: 1000 } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    raw.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 40, reason: 'test' },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    raw.send(requestFrame(41, 'x/notifications'));
    const notifications = (await raw.nextMessage()) as {
      result: { notifications: Array<{ method: string; params: { requestId?: number } }> };
    };
    const cancelled = notifications.result.notifications.filter(
      (entry) => entry.method === 'notifications/cancelled',
    );
    expect(cancelled.length).toBeGreaterThanOrEqual(1);

    expect(await stats(raw, 42)).toMatchObject({ sleep: 1 });
    expect(callLogs(raw).at(-1)).toMatchObject({ decision: 'cancelled', attempt: 1 });
  });
});

describe('CLI configuration errors', () => {
  it('rejects a malformed config with exit 2 and an actionable message', async () => {
    const path = configFile('reliability:\n  timeout_ms: soon\n');
    const raw = startRaw(NODE, [CLI, 'run', '--config', path, '--', NODE, ECHO]);
    sessions.push(raw);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain('reliability.timeout_ms');
  });

  it('rejects invalid flag values', async () => {
    const raw = startRaw(NODE, [CLI, 'run', '--timeout-ms', 'abc', '--', NODE, ECHO]);
    sessions.push(raw);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain('--timeout-ms');
  });

  it('rejects unknown run options', async () => {
    const raw = startRaw(NODE, [CLI, 'run', '--nope', '--', NODE, ECHO]);
    sessions.push(raw);
    expect(await raw.waitForExit()).toBe(2);
  });
});

describe('retry loop unit behavior', () => {
  it('retries pre-execution transport failures up to the bound', async () => {
    const attempts: number[] = [];
    const sleeps: number[] = [];
    const result = await runWithRetry({
      attempt: async (attemptNumber) => {
        attempts.push(attemptNumber);
        return {
          kind: 'error',
          error: new Error('not connected'),
          phase: 'pre_send',
        } satisfies AttemptOutcome;
      },
      classify: () => ({ class: 'transport_pre_execution', retry: true }),
      policy: { maxAttempts: 3, baseMs: 10, jitter: false },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(attempts).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([10, 20]);
    expect(result.attempts).toBe(3);
  });

  it('stops immediately on a non-retryable classification', async () => {
    let calls = 0;
    const result = await runWithRetry({
      attempt: async () => {
        calls += 1;
        return {
          kind: 'error',
          error: new Error('nope'),
          phase: 'post_send',
        } satisfies AttemptOutcome;
      },
      classify: () => ({ class: 'non_retryable', retry: false }),
      policy: { maxAttempts: 5, baseMs: 1, jitter: false },
      sleep: async () => {},
    });
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
  });
});

describe('backoff delays', () => {
  it('grows exponentially and caps', () => {
    const policy = { maxAttempts: 10, baseMs: 100, jitter: false };
    expect(backoffDelayMs(policy, 1, Math.random)).toBe(100);
    expect(backoffDelayMs(policy, 2, Math.random)).toBe(200);
    expect(backoffDelayMs(policy, 3, Math.random)).toBe(400);
    expect(backoffDelayMs(policy, 10, Math.random)).toBe(30000);
  });

  it('stays within the exponential envelope when jitter is on', () => {
    const policy = { maxAttempts: 5, baseMs: 100, jitter: true };
    expect(backoffDelayMs(policy, 3, () => 0)).toBe(0);
    expect(backoffDelayMs(policy, 3, () => 0.5)).toBe(200);
    expect(backoffDelayMs(policy, 3, () => 0.999)).toBeLessThanOrEqual(400);
  });
});

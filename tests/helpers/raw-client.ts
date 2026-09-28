import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface RawSession {
  readonly child: ChildProcessWithoutNullStreams;
  send(frame: unknown): void;
  sendLine(line: string): void;
  nextMessage(timeoutMs?: number): Promise<unknown>;
  nextLine(timeoutMs?: number): Promise<string>;
  stderr(): string;
  waitForExit(timeoutMs?: number): Promise<number | null>;
  close(): void;
}

interface Pending {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Spawns a command and speaks raw newline-delimited JSON-RPC to it.
 * Needed for frames the SDK cannot express: batch arrays, unknown methods,
 * unsupported revisions.
 */
export function startRaw(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): RawSession {
  const child = spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env ?? process.env,
  }) as ChildProcessWithoutNullStreams;

  const lines: string[] = [];
  const pending: Pending[] = [];
  let stdoutBuffer = '';
  let stderrText = '';
  let exitCode: number | null = null;
  const exitWaiters: Array<(code: number | null) => void> = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let index: number;
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.length === 0) continue;
      const waiter = pending.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        lines.push(line);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
  });

  child.on('exit', (code) => {
    exitCode = code;
    for (const waiter of pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('process exited before a frame arrived'));
    }
    for (const resolve of exitWaiters.splice(0)) resolve(code);
  });

  function takeLine(timeoutMs: number): Promise<string> {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (exitCode !== null) return Promise.reject(new Error('process already exited'));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = pending.findIndex((p) => p.timer === timer);
        if (index >= 0) pending.splice(index, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a frame`));
      }, timeoutMs);
      pending.push({ resolve, reject, timer });
    });
  }

  return {
    child,
    send(frame: unknown): void {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    sendLine(line: string): void {
      child.stdin.write(`${line}\n`);
    },
    async nextLine(timeoutMs = 5000): Promise<string> {
      return takeLine(timeoutMs);
    },
    async nextMessage(timeoutMs = 5000): Promise<unknown> {
      return JSON.parse(await takeLine(timeoutMs));
    },
    stderr(): string {
      return stderrText;
    },
    waitForExit(timeoutMs = 5000): Promise<number | null> {
      if (exitCode !== null) return Promise.resolve(exitCode);
      return new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('process did not exit')), timeoutMs);
        exitWaiters.push((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
    close(): void {
      child.kill('SIGKILL');
    },
  };
}

export function requestFrame(id: number, method: string, params?: unknown): unknown {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

/** Waits until the child's accumulated stderr contains `text` (async flush). */
export async function waitForStderr(
  raw: RawSession,
  text: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (raw.stderr().includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for stderr to contain ${JSON.stringify(text)}`);
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  deserializeMessage,
  isJSONRPCNotification,
  serializeMessage,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type Transport,
} from '@modelcontextprotocol/server';

export interface UpstreamTransportOptions {
  command: string;
  args: readonly string[];
  onStderr(chunk: string): void;
}

function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((line) => line.trim()).filter((line) => line.length > 0), rest };
}

/**
 * Transport for the wrapped upstream server: spawns the command and speaks
 * newline-delimited JSON-RPC. Single messages go through the SDK protocol
 * classes; JSON-RPC batch arrays are surfaced through `onBatch` and relayed
 * verbatim, because the SDK message model cannot represent them.
 */
export class UpstreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onBatch?: (line: string) => void;
  onNotification?: (notification: JSONRPCNotification) => void;

  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private closed = false;
  private processing: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(private readonly options: UpstreamTransportOptions) {}

  /** True once the upstream process has been spawned and is still alive. */
  get connected(): boolean {
    return this.child !== undefined && !this.closed;
  }

  async start(): Promise<void> {
    const child = spawn(this.options.command, [...this.options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.onData(chunk);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.options.onStderr(chunk);
    });

    child.on('error', (error: Error) => {
      this.onerror?.(error);
      this.finish();
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.closing && (code !== 0 || signal !== null)) {
        this.onerror?.(
          new Error(`upstream exited (code ${String(code)}, signal ${String(signal)})`),
        );
      }
      this.finish();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.writeLine(serializeMessage(message));
  }

  /** Relays a raw frame verbatim (JSON-RPC batch arrays). */
  sendRaw(line: string): void {
    this.writeLine(line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.child?.stdin.end();
    this.child?.kill('SIGTERM');
    this.finish();
  }

  private writeLine(line: string): void {
    this.child?.stdin.write(`${line}\n`);
  }

  private onData(chunk: string): void {
    const { lines, rest } = splitLines(this.buffer, chunk);
    this.buffer = rest;
    for (const line of lines) {
      // The SDK dispatches notification handlers as microtasks; yielding
      // between frames keeps progress notifications from being overtaken by a
      // response that arrived in the same chunk.
      this.processing = this.processing.then(() => this.processLine(line));
    }
  }

  private async processLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (Array.isArray(parsed)) {
      this.onBatch?.(line);
      return;
    }
    try {
      const message = deserializeMessage(line);
      if (isJSONRPCNotification(message)) this.onNotification?.(message);
      this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
    await Promise.resolve();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

export interface ClientTransportOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/**
 * Transport facing the MCP client: reads the middleware's stdin, writes its
 * stdout. Batch arrays bypass the SDK protocol classes through `onBatch`.
 */
export class ClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onBatch?: (line: string) => void;
  onNotification?: (notification: JSONRPCNotification) => void;

  private buffer = '';
  private closed = false;
  private processing: Promise<void> = Promise.resolve();

  constructor(private readonly options: ClientTransportOptions = {}) {}

  async start(): Promise<void> {
    const stdin = this.options.stdin ?? process.stdin;
    stdin.setEncoding('utf8');
    stdin.on('data', this.onDataHandler);
    stdin.on('end', this.onEndHandler);
    stdin.resume();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.writeLine(serializeMessage(message));
  }

  /** Relays a raw frame verbatim (JSON-RPC batch arrays). */
  sendRaw(line: string): void {
    this.writeLine(line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const stdin = this.options.stdin ?? process.stdin;
    stdin.off('data', this.onDataHandler);
    stdin.off('end', this.onEndHandler);
    stdin.pause();
    this.finish();
  }

  private readonly onDataHandler = (chunk: string): void => {
    this.onData(chunk);
  };

  private readonly onEndHandler = (): void => {
    this.finish();
  };

  private writeLine(line: string): void {
    const stdout = this.options.stdout ?? process.stdout;
    stdout.write(`${line}\n`);
  }

  private onData(chunk: string): void {
    const { lines, rest } = splitLines(this.buffer, chunk);
    this.buffer = rest;
    for (const line of lines) {
      // The SDK dispatches notification handlers as microtasks; yielding
      // between frames keeps progress notifications from being overtaken by a
      // response that arrived in the same chunk.
      this.processing = this.processing.then(() => this.processLine(line));
    }
  }

  private async processLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (Array.isArray(parsed)) {
      this.onBatch?.(line);
      return;
    }
    try {
      const message = deserializeMessage(line);
      if (isJSONRPCNotification(message)) this.onNotification?.(message);
      this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
    await Promise.resolve();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

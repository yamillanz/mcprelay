import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { StreamableHTTPClientTransport, type Client } from '@modelcontextprotocol/client';
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

interface FrameHandlers {
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onBatch?: (line: string) => void;
  onNotification?: (notification: JSONRPCNotification) => void;
}

/**
 * Line-framing pipeline shared by the upstream and client-facing transports:
 * buffers chunks, parses frames, and dispatches batches, notifications,
 * messages, and errors to the owning transport's handlers.
 */
class FrameDecoder {
  private buffer = '';
  private processing: Promise<void> = Promise.resolve();

  constructor(private readonly handlers: FrameHandlers) {}

  push(chunk: string): void {
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
      this.handlers.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (Array.isArray(parsed)) {
      this.handlers.onBatch?.(line);
      return;
    }
    try {
      const message = deserializeMessage(line);
      if (isJSONRPCNotification(message)) this.handlers.onNotification?.(message);
      this.handlers.onmessage?.(message);
    } catch (error) {
      this.handlers.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
    await Promise.resolve();
  }
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

  private readonly decoder: FrameDecoder;
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private closing = false;

  constructor(private readonly options: UpstreamTransportOptions) {
    this.decoder = new FrameDecoder(this);
  }

  /** True once the upstream process has been spawned and is still alive. */
  get connected(): boolean {
    return this.child !== undefined && !this.closed;
  }

  async start(): Promise<void> {
    const child = this.spawnChild();
    this.forwardUpstreamStderr(child);
    this.watchChildError(child);
    this.watchChildExit(child);
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

  private spawnChild(): ChildProcessWithoutNullStreams {
    const child = spawn(this.options.command, [...this.options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.decoder.push(chunk);
    });
    return child;
  }

  private forwardUpstreamStderr(child: ChildProcessWithoutNullStreams): void {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.options.onStderr(chunk);
    });
  }

  private watchChildError(child: ChildProcessWithoutNullStreams): void {
    child.on('error', (error: Error) => {
      this.onerror?.(error);
      this.finish();
    });
  }

  private watchChildExit(child: ChildProcessWithoutNullStreams): void {
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.closing && (code !== 0 || signal !== null)) {
        this.onerror?.(
          new Error(`upstream exited (code ${String(code)}, signal ${String(signal)})`),
        );
      }
      this.finish();
    });
  }

  private writeLine(line: string): void {
    this.child?.stdin.write(`${line}\n`);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

/** Upstream to wrap: a local stdio process or a remote Streamable HTTP server. */
export type UpstreamTarget =
  | { kind: 'stdio'; command: string; args: readonly string[] }
  | { kind: 'http'; url: string; headers: Record<string, string> };

/** What the bridge needs from an upstream connection, independent of its transport. */
export interface UpstreamLink {
  readonly kind: 'stdio' | 'http';
  readonly connected: boolean;
  connect(client: Client): Promise<void>;
  relayNotifications(relay: (notification: JSONRPCNotification) => void): void;
  setCloseRelay(relay: () => void): void;
  sendBatch(line: string): void;
  setBatchRelay(relay: (line: string) => void): void;
  close(): Promise<void>;
}

export class StdioUpstreamLink implements UpstreamLink {
  readonly kind = 'stdio' as const;
  private readonly transport: UpstreamTransport;

  constructor(options: UpstreamTransportOptions) {
    this.transport = new UpstreamTransport(options);
  }

  get connected(): boolean {
    return this.transport.connected;
  }

  async connect(client: Client): Promise<void> {
    await client.connect(this.transport);
  }

  relayNotifications(relay: (notification: JSONRPCNotification) => void): void {
    this.transport.onNotification = relay;
  }

  setCloseRelay(relay: () => void): void {
    this.transport.onclose = relay;
  }

  sendBatch(line: string): void {
    this.transport.sendRaw(line);
  }

  setBatchRelay(relay: (line: string) => void): void {
    this.transport.onBatch = relay;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

export class HttpUpstreamLink implements UpstreamLink {
  readonly kind = 'http' as const;
  private readonly transport: StreamableHTTPClientTransport;
  private relay: ((notification: JSONRPCNotification) => void) | undefined;
  private started = false;
  private closed = false;

  constructor(options: { url: string; headers: Record<string, string> }) {
    this.transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: options.headers },
    });
  }

  get connected(): boolean {
    return this.started && !this.closed;
  }

  async connect(client: Client): Promise<void> {
    await this.connectTransport(client);
    this.mirrorNotificationsAfterConnect();
  }

  private async connectTransport(client: Client): Promise<void> {
    await client.connect(this.transport);
  }

  private mirrorNotificationsAfterConnect(): void {
    // Wrap after connect: the protocol layer assigns `onmessage` during it.
    const downstream = this.transport.onmessage;
    this.transport.onmessage = (message) => {
      if (isJSONRPCNotification(message)) this.relay?.(message);
      downstream?.(message);
    };
    this.started = true;
  }

  relayNotifications(relay: (notification: JSONRPCNotification) => void): void {
    this.relay = relay;
  }

  setCloseRelay(relay: () => void): void {
    this.transport.onclose = relay;
  }

  /** Batch frames are not supported over HTTP; the bridge answers the client instead. */
  sendBatch(_line: string): void {}

  setBatchRelay(_relay: (line: string) => void): void {}

  async close(): Promise<void> {
    this.closed = true;
    await this.transport.close().catch(() => {});
  }
}

export function createUpstreamLink(
  target: UpstreamTarget,
  onStderr: (chunk: string) => void,
): UpstreamLink {
  return target.kind === 'stdio'
    ? new StdioUpstreamLink({ command: target.command, args: target.args, onStderr })
    : new HttpUpstreamLink({ url: target.url, headers: target.headers });
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

  private readonly decoder: FrameDecoder;
  private closed = false;

  constructor(private readonly options: ClientTransportOptions = {}) {
    this.decoder = new FrameDecoder(this);
  }

  async start(): Promise<void> {
    this.attachStdin();
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
    this.detachStdin();
    this.finish();
  }

  private attachStdin(): void {
    const stdin = this.options.stdin ?? process.stdin;
    stdin.setEncoding('utf8');
    stdin.on('data', this.onDataHandler);
    stdin.on('end', this.onEndHandler);
    stdin.resume();
  }

  private detachStdin(): void {
    const stdin = this.options.stdin ?? process.stdin;
    stdin.off('data', this.onDataHandler);
    stdin.off('end', this.onEndHandler);
    stdin.pause();
  }

  private readonly onDataHandler = (chunk: string): void => {
    this.decoder.push(chunk);
  };

  private readonly onEndHandler = (): void => {
    this.finish();
  };

  private writeLine(line: string): void {
    const stdout = this.options.stdout ?? process.stdout;
    stdout.write(`${line}\n`);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

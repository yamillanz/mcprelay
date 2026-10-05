import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';

import { ClientTransport, UpstreamTransport } from '../src/proxy/transports.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clientHarness(): {
  stdin: PassThrough;
  transport: ClientTransport;
  written: string[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => written.push(chunk));
  const transport = new ClientTransport({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  return { stdin, transport, written };
}

function upstreamHarness(code: string): { transport: UpstreamTransport; stderr: string[] } {
  const stderr: string[] = [];
  const transport = new UpstreamTransport({
    command: process.execPath,
    args: ['-e', code],
    onStderr: (chunk) => stderr.push(chunk),
  });
  return { transport, stderr };
}

function messageCode(frame: string): string {
  return `process.stdout.write(${JSON.stringify(`${frame}\n`)}); setInterval(() => {}, 1000);`;
}

describe('ClientTransport framing', () => {
  it('delivers a frame split across chunks and ignores blank lines', async () => {
    const { stdin, transport } = clientHarness();
    const seen = deferred<JSONRPCMessage>();
    transport.onmessage = (message) => seen.resolve(message);
    await transport.start();

    stdin.write('{"jsonrpc":"2.0","id":1,"met');
    stdin.write('hod":"ping"}\n\n');

    await expect(seen.promise).resolves.toMatchObject({ id: 1, method: 'ping' });
    await transport.close();
  });

  it('reports invalid JSON and keeps processing later frames', async () => {
    const { stdin, transport } = clientHarness();
    const errors: Error[] = [];
    const seen = deferred<JSONRPCMessage>();
    transport.onerror = (error) => errors.push(error);
    transport.onmessage = (message) => seen.resolve(message);
    await transport.start();

    stdin.write('not json\n');
    stdin.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');

    await seen.promise;
    expect(errors).toHaveLength(1);
    await transport.close();
  });

  it('surfaces batch lines verbatim through onBatch', async () => {
    const { stdin, transport } = clientHarness();
    const batch = deferred<string>();
    transport.onBatch = (line) => batch.resolve(line);
    await transport.start();

    const raw = '[{"jsonrpc":"2.0","id":1,"result":{}}]';
    stdin.write(`${raw}\n`);

    await expect(batch.promise).resolves.toBe(raw);
    await transport.close();
  });

  it('dispatches notifications before the message', async () => {
    const { stdin, transport } = clientHarness();
    const order: string[] = [];
    const seen = deferred<void>();
    transport.onNotification = () => order.push('notification');
    transport.onmessage = () => {
      order.push('message');
      seen.resolve();
    };
    await transport.start();

    stdin.write('{"jsonrpc":"2.0","method":"notifications/progress"}\n');

    await seen.promise;
    expect(order).toEqual(['notification', 'message']);
    await transport.close();
  });

  it('closes exactly once and detaches stdin', async () => {
    const { stdin, transport } = clientHarness();
    let closes = 0;
    transport.onclose = () => {
      closes += 1;
    };
    await transport.start();

    await transport.close();
    await transport.close();
    expect(closes).toBe(1);

    let messages = 0;
    transport.onmessage = () => {
      messages += 1;
    };
    stdin.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
    await tick();
    expect(messages).toBe(0);
  });

  it('writes sent messages to the injected stdout', async () => {
    const { transport, written } = clientHarness();
    await transport.start();

    const message: JSONRPCMessage = { jsonrpc: '2.0', id: 9, method: 'ping' };
    await transport.send(message);
    await tick();

    expect(written.join('')).toBe('{"jsonrpc":"2.0","id":9,"method":"ping"}\n\n');
    await transport.close();
  });
});

describe('UpstreamTransport framing', () => {
  it('delivers a message frame from the child stdout', async () => {
    const { transport } = upstreamHarness(
      messageCode('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'),
    );
    const seen = deferred<JSONRPCMessage>();
    transport.onmessage = (message) => seen.resolve(message);
    await transport.start();

    await expect(seen.promise).resolves.toMatchObject({ id: 1, result: { ok: true } });
    await transport.close();
  });

  it('reassembles a frame split across chunks', async () => {
    const first = '{"jsonrpc":"2.0","id":1,"res';
    const second = 'ult":{"ok":true}}\n';
    const { transport } = upstreamHarness(
      `process.stdout.write(${JSON.stringify(first)}); setTimeout(() => process.stdout.write(${JSON.stringify(second)}), 30); setInterval(() => {}, 1000);`,
    );
    const seen = deferred<JSONRPCMessage>();
    transport.onmessage = (message) => seen.resolve(message);
    await transport.start();

    await expect(seen.promise).resolves.toMatchObject({ id: 1, result: { ok: true } });
    await transport.close();
  });

  it('surfaces batch lines verbatim through onBatch', async () => {
    const raw = '[{"jsonrpc":"2.0","id":1,"result":{}}]';
    const { transport } = upstreamHarness(messageCode(raw));
    const batch = deferred<string>();
    transport.onBatch = (line) => batch.resolve(line);
    await transport.start();

    await expect(batch.promise).resolves.toBe(raw);
    await transport.close();
  });

  it('reports invalid frames and keeps processing later ones', async () => {
    const { transport } = upstreamHarness(
      `process.stdout.write("not json\\n"); process.stdout.write(${JSON.stringify('{"jsonrpc":"2.0","id":2,"result":{}}\n')}); setInterval(() => {}, 1000);`,
    );
    const errors: Error[] = [];
    const seen = deferred<JSONRPCMessage>();
    transport.onerror = (error) => errors.push(error);
    transport.onmessage = (message) => seen.resolve(message);
    await transport.start();

    await seen.promise;
    expect(errors).toHaveLength(1);
    await transport.close();
  });

  it('forwards child stderr through onStderr', async () => {
    const { transport, stderr } = upstreamHarness(
      'process.stderr.write("upstream says hi\\n"); setInterval(() => {}, 1000);',
    );
    await transport.start();
    await tick(50);

    expect(stderr.join('')).toContain('upstream says hi');
    await transport.close();
  });

  it('reports a non-zero exit and closes', async () => {
    const { transport } = upstreamHarness('process.exit(3);');
    const errors: Error[] = [];
    const closed = deferred<void>();
    transport.onerror = (error) => errors.push(error);
    transport.onclose = () => closed.resolve();
    await transport.start();

    await closed.promise;
    expect(errors.map((error) => error.message)).toEqual(['upstream exited (code 3, signal null)']);
  });

  it('suppresses the exit error after close', async () => {
    const { transport } = upstreamHarness('setInterval(() => {}, 1000);');
    const errors: Error[] = [];
    const closed = deferred<void>();
    transport.onerror = (error) => errors.push(error);
    transport.onclose = () => closed.resolve();
    await transport.start();

    await transport.close();
    await closed.promise;
    await tick(100);
    expect(errors).toEqual([]);
  });

  it('writes sent messages to the child stdin', async () => {
    const { transport } = upstreamHarness(
      'process.stdin.on("data", (chunk) => process.stdout.write(chunk));',
    );
    const seen = deferred<JSONRPCMessage>();
    transport.onmessage = (message) => seen.resolve(message);
    await transport.start();

    const message: JSONRPCMessage = { jsonrpc: '2.0', id: 7, method: 'ping' };
    await transport.send(message);

    await expect(seen.promise).resolves.toMatchObject({ id: 7, method: 'ping' });
    await transport.close();
  });
});

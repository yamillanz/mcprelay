import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, type RawSession } from './helpers/raw-client.js';

const ECHO_SERVER = fileURLToPath(
  new URL('../build/examples/echo-server/index.js', import.meta.url),
);
const NODE = process.execPath;

const sessions: RawSession[] = [];

function session(extraArgs: string[] = []): RawSession {
  const raw = startRaw(NODE, [ECHO_SERVER, ...extraArgs]);
  sessions.push(raw);
  return raw;
}

async function initialize(raw: RawSession): Promise<Record<string, unknown>> {
  raw.send(requestFrame(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }));
  const response = (await raw.nextMessage()) as { result: Record<string, unknown> };
  raw.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return response.result;
}

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
});

describe('hermetic echo server', () => {
  it('completes a legacy initialize handshake', async () => {
    const raw = session();
    const result = await initialize(raw);

    expect(result.protocolVersion).toBe('2025-11-25');
    expect(result.serverInfo).toMatchObject({ name: 'echo-server' });
    expect(result.capabilities).toBeTypeOf('object');
  });

  it('lists tools and echoes a tools/call', async () => {
    const raw = session();
    await initialize(raw);

    raw.send(requestFrame(2, 'tools/list'));
    const list = (await raw.nextMessage()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((tool) => tool.name)).toContain('echo');

    raw.send(requestFrame(3, 'tools/call', { name: 'echo', arguments: { hello: 'world' } }));
    const call = (await raw.nextMessage()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(call.result.isError).toBeUndefined();
    expect(JSON.parse(call.result.content[0]!.text)).toEqual({ hello: 'world' });
  });

  it('answers the passthrough matrix methods', async () => {
    const raw = session();
    await initialize(raw);

    const cases: Array<[string, unknown, (result: Record<string, unknown>) => void]> = [
      ['resources/list', undefined, (r) => expect(r.resources).toBeInstanceOf(Array)],
      ['resources/read', { uri: 'echo://one' }, (r) => expect(r.contents).toBeInstanceOf(Array)],
      [
        'resources/templates/list',
        undefined,
        (r) => expect(r.resourceTemplates).toBeInstanceOf(Array),
      ],
      ['resources/subscribe', { uri: 'echo://one' }, (r) => expect(r).toEqual({})],
      ['resources/unsubscribe', { uri: 'echo://one' }, (r) => expect(r).toEqual({})],
      ['prompts/list', undefined, (r) => expect(r.prompts).toBeInstanceOf(Array)],
      ['prompts/get', { name: 'echo' }, (r) => expect(r.messages).toBeInstanceOf(Array)],
      [
        'completion/complete',
        { ref: { type: 'ref/prompt', name: 'echo' }, argument: { name: 'x', value: '' } },
        (r) => expect(r.completion).toBeTypeOf('object'),
      ],
      ['logging/setLevel', { level: 'debug' }, (r) => expect(r).toEqual({})],
      ['ping', undefined, (r) => expect(r).toEqual({})],
    ];

    let id = 10;
    for (const [method, params, assert] of cases) {
      raw.send(requestFrame(id++, method, params));
      const response = (await raw.nextMessage()) as { result: Record<string, unknown> };
      assert(response.result);
    }
  });

  it('echoes unknown and custom methods', async () => {
    const raw = session();
    await initialize(raw);

    raw.send(requestFrame(20, 'x/echo', { a: 1, nested: { b: 2 } }));
    const response = (await raw.nextMessage()) as { result: { received: unknown } };
    expect(response.result.received).toEqual({ a: 1, nested: { b: 2 } });
  });

  it('answers a JSON-RPC batch frame with a batch response', async () => {
    const raw = session();
    await initialize(raw);

    raw.sendLine(
      JSON.stringify([
        requestFrame(30, 'ping'),
        requestFrame(31, 'tools/list'),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ]),
    );

    const batch = (await raw.nextMessage()) as Array<{ id: number }>;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.map((entry) => entry.id)).toEqual([30, 31]);
  });

  it('sends a server-to-client request and returns the client response', async () => {
    const raw = session();
    await initialize(raw);

    raw.send(requestFrame(40, 'tools/call', { name: 'ask-client', arguments: {} }));
    const serverRequest = (await raw.nextMessage()) as {
      method: string;
      id: number;
      params: { messages: Array<{ role: string }> };
    };
    expect(serverRequest.method).toBe('sampling/createMessage');
    expect(serverRequest.params.messages).toBeInstanceOf(Array);

    raw.send({
      jsonrpc: '2.0',
      id: serverRequest.id,
      result: {
        role: 'assistant',
        content: { type: 'text', text: 'sampled' },
        model: 'echo-model',
      },
    });

    const call = (await raw.nextMessage()) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]!.text).toBe('sampled');
  });

  it('emits progress notifications for an in-flight call', async () => {
    const raw = session();
    await initialize(raw);

    raw.send({
      ...(requestFrame(50, 'tools/call', { name: 'progress', arguments: { steps: 2 } }) as object),
      params: { name: 'progress', arguments: { steps: 2 }, _meta: { progressToken: 'tok-1' } },
    });

    const first = (await raw.nextMessage()) as {
      method: string;
      params: { progressToken: string };
    };
    const second = (await raw.nextMessage()) as {
      method: string;
      params: { progressToken: string };
    };
    expect(first.method).toBe('notifications/progress');
    expect(first.params.progressToken).toBe('tok-1');
    expect(second.method).toBe('notifications/progress');

    const call = (await raw.nextMessage()) as { id: number };
    expect(call.id).toBe(50);
  });

  it('writes to stderr without polluting stdout', async () => {
    const raw = session();
    await initialize(raw);

    raw.send(requestFrame(60, 'x/stderr', { marker: 'stderr-marker' }));
    const response = (await raw.nextMessage()) as { id: number };
    expect(response.id).toBe(60);
    expect(raw.stderr()).toContain('stderr-marker');
  });

  it('exits when the crash tool is called', async () => {
    const raw = session();
    await initialize(raw);

    raw.send(requestFrame(70, 'tools/call', { name: 'crash', arguments: { delay_ms: 20 } }));
    const code = await raw.waitForExit();
    expect(code).not.toBe(0);
  });

  it('speaks the modern era through server/discover', async () => {
    const raw = session(['--modern']);
    raw.send(requestFrame(1, 'server/discover', {}));
    const response = (await raw.nextMessage()) as {
      result: { supportedVersions: string[]; capabilities: Record<string, unknown> };
    };
    expect(response.result.supportedVersions).toContain('2026-07-28');
    expect(response.result.capabilities).toBeTypeOf('object');

    raw.send(requestFrame(2, 'x/era'));
    const era = (await raw.nextMessage()) as { result: { era: string } };
    expect(era.result.era).toBe('modern');
  });
});

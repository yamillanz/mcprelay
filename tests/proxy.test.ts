import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { requestFrame, startRaw, waitForStderr, type RawSession } from './helpers/raw-client.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const ECHO = fileURLToPath(new URL('../build/examples/echo-server/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];

function spawnRaw(command: string, args: string[]): RawSession {
  const raw = startRaw(command, args);
  sessions.push(raw);
  return raw;
}

function proxy(echoArgs: string[] = []): RawSession {
  return spawnRaw(NODE, [CLI, 'run', '--', NODE, ECHO, ...echoArgs]);
}

function direct(echoArgs: string[] = []): RawSession {
  return spawnRaw(NODE, [ECHO, ...echoArgs]);
}

async function handshake(
  raw: RawSession,
  options: { id?: number; protocolVersion?: string } = {},
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  raw.send(
    requestFrame(options.id ?? 1, 'initialize', {
      protocolVersion: options.protocolVersion ?? '2025-11-25',
      capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
      clientInfo: { name: 'raw-test-client', version: '0.0.0' },
    }),
  );
  const response = (await raw.nextMessage()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
  raw.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return response;
}

async function callTool(
  raw: RawSession,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
  meta?: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const params: Record<string, unknown> = { name, arguments: args };
  if (meta) params._meta = meta;
  raw.send(requestFrame(id, 'tools/call', params));
  return (await raw.nextMessage()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
});

describe('FR-P1 — wrap any stdio server', () => {
  it('runs a full session semantically equal to a direct session', async () => {
    const throughProxy = proxy();
    const throughDirect = direct();

    const proxyInit = await handshake(throughProxy);
    const directInit = await handshake(throughDirect);
    expect(proxyInit.result).toEqual(directInit.result);

    throughProxy.send(requestFrame(2, 'tools/list'));
    throughDirect.send(requestFrame(2, 'tools/list'));
    expect(await throughProxy.nextMessage()).toEqual(await throughDirect.nextMessage());

    const proxyCall = await callTool(throughProxy, 3, 'echo', { hello: 'world' });
    const directCall = await callTool(throughDirect, 3, 'echo', { hello: 'world' });
    expect(proxyCall).toEqual(directCall);
  });

  it('accepts the mcprelay -- shorthand', async () => {
    const raw = spawnRaw(NODE, [CLI, '--', NODE, ECHO]);
    const init = await handshake(raw);
    expect(init.result?.serverInfo).toMatchObject({ name: 'echo-server' });

    raw.send(requestFrame(2, 'ping'));
    const pong = (await raw.nextMessage()) as { result?: Record<string, unknown> };
    expect(pong.result).toEqual({});
  });

  it('passes options after -- to the server command', async () => {
    const raw = proxy(['--http', 'x']);
    const init = await handshake(raw);
    expect(init.result?.serverInfo).toMatchObject({ name: 'echo-server' });
  });

  it('exits 2 with a hint when no server command is given', async () => {
    const raw = spawnRaw(NODE, [CLI, 'run']);
    const code = await raw.waitForExit();
    expect(code).toBe(2);
    expect(raw.stderr()).toContain('run');
  });
});

describe('FR-P2 — passthrough matrix', () => {
  it('relays client→server requests unchanged', async () => {
    const raw = proxy();
    await handshake(raw);

    const cases: Array<[string, unknown, (result: Record<string, unknown>) => void]> = [
      ['tools/list', undefined, (r) => expect(r.tools).toBeInstanceOf(Array)],
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

  it('relays client→server notifications upstream', async () => {
    const raw = proxy();
    await handshake(raw);

    raw.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 999, reason: 'test' },
    });
    raw.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'p', progress: 1 },
    });
    raw.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });

    raw.send(requestFrame(20, 'x/notifications'));
    const response = (await raw.nextMessage()) as {
      result: { notifications: Array<{ method: string }> };
    };
    const methods = response.result.notifications.map((entry) => entry.method);
    expect(methods).toContain('notifications/cancelled');
    expect(methods).toContain('notifications/progress');
    expect(methods).toContain('notifications/roots/list_changed');
  });

  it('relays server→client requests and their responses', async () => {
    const raw = proxy();
    await handshake(raw);

    const sampling = await (async () => {
      raw.send(requestFrame(30, 'tools/call', { name: 'ask-client', arguments: {} }));
      const serverRequest = (await raw.nextMessage()) as { method: string; id: number };
      expect(serverRequest.method).toBe('sampling/createMessage');
      raw.send({
        jsonrpc: '2.0',
        id: serverRequest.id,
        result: { role: 'assistant', content: { type: 'text', text: 'sampled' }, model: 'test' },
      });
      return (await raw.nextMessage()) as { result: { content: Array<{ text: string }> } };
    })();
    expect(sampling.result.content[0]!.text).toBe('sampled');

    const elicitation = await (async () => {
      raw.send(requestFrame(31, 'tools/call', { name: 'ask-elicitation', arguments: {} }));
      const serverRequest = (await raw.nextMessage()) as { method: string; id: number };
      expect(serverRequest.method).toBe('elicitation/create');
      raw.send({
        jsonrpc: '2.0',
        id: serverRequest.id,
        result: { action: 'accept', content: { value: 'ok' } },
      });
      return (await raw.nextMessage()) as { result: { content: Array<{ text: string }> } };
    })();
    expect(JSON.parse(elicitation.result.content[0]!.text)).toMatchObject({ action: 'accept' });

    const roots = await (async () => {
      raw.send(requestFrame(32, 'tools/call', { name: 'ask-roots', arguments: {} }));
      const serverRequest = (await raw.nextMessage()) as { method: string; id: number };
      expect(serverRequest.method).toBe('roots/list');
      raw.send({
        jsonrpc: '2.0',
        id: serverRequest.id,
        result: { roots: [{ uri: 'file:///tmp', name: 'tmp' }] },
      });
      return (await raw.nextMessage()) as { result: { content: Array<{ text: string }> } };
    })();
    expect(JSON.parse(roots.result.content[0]!.text)).toMatchObject({
      roots: [{ uri: 'file:///tmp' }],
    });
  });

  it('relays progress notifications for an in-flight call', async () => {
    const raw = proxy();
    await handshake(raw);

    raw.send({
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: { name: 'progress', arguments: { steps: 2 }, _meta: { progressToken: 'tok-1' } },
    });

    const first = (await raw.nextMessage()) as {
      method: string;
      params: { progressToken: string };
    };
    const second = (await raw.nextMessage()) as { method: string };
    const result = (await raw.nextMessage()) as {
      id: number;
      result: { content: Array<{ text: string }> };
    };
    expect(first.method).toBe('notifications/progress');
    expect(first.params.progressToken).toBe('tok-1');
    expect(second.method).toBe('notifications/progress');
    expect(result.id).toBe(40);
    expect(result.result.content[0]!.text).toBe('done');
  });

  it('relays unknown and custom methods unchanged', async () => {
    const raw = proxy();
    await handshake(raw);

    raw.send(requestFrame(50, 'x/echo', { a: 1, nested: { b: 2 } }));
    const response = (await raw.nextMessage()) as { result: { received: unknown } };
    expect(response.result.received).toEqual({ a: 1, nested: { b: 2 } });
  });

  it('relays upstream→client custom notifications', async () => {
    const raw = proxy();
    await handshake(raw);

    raw.send(requestFrame(60, 'x/notify'));
    const notification = (await raw.nextMessage()) as { method: string; params: { from: string } };
    expect(notification.method).toBe('notifications/x/custom');
    expect(notification.params.from).toBe('echo-server');
    const response = (await raw.nextMessage()) as { id: number };
    expect(response.id).toBe(60);
  });

  it('relays JSON-RPC batch frames in both directions', async () => {
    const raw = proxy();
    await handshake(raw);

    raw.sendLine(
      JSON.stringify([
        requestFrame(70, 'ping'),
        requestFrame(71, 'tools/list'),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ]),
    );

    const batch = (await raw.nextMessage()) as Array<{ id: number; result: unknown }>;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.map((entry) => entry.id)).toEqual([70, 71]);
  });

  it('negotiates initialize capabilities from the upstream session', async () => {
    const raw = proxy();
    const response = await handshake(raw);
    expect(response.result?.capabilities).toMatchObject({
      tools: expect.any(Object),
      resources: expect.any(Object),
      prompts: expect.any(Object),
    });
    expect(response.result?.serverInfo).toMatchObject({ name: 'echo-server' });
  });

  it('does not add middleware-specific fields to passthrough messages', async () => {
    const raw = proxy();
    await handshake(raw);

    raw.send(requestFrame(80, 'x/echo', { only: 'this' }));
    const response = (await raw.nextMessage()) as { result: { received: unknown } };
    expect(response.result.received).toEqual({ only: 'this' });
  });
});

describe('FR-P3 — tools/call interception', () => {
  it('forwards exactly one upstream call and relays the result', async () => {
    const raw = proxy();
    await handshake(raw);

    const call = await callTool(raw, 90, 'echo', { value: 42 });
    expect(JSON.parse((call.result!.content as Array<{ text: string }>)[0]!.text)).toEqual({
      value: 42,
    });

    raw.send(requestFrame(91, 'x/stats'));
    const stats = (await raw.nextMessage()) as { result: { toolCalls: number } };
    expect(stats.result.toolCalls).toBe(1);
  });

  it('relays an isError result unchanged', async () => {
    const raw = proxy();
    await handshake(raw);

    const call = await callTool(raw, 92, 'boom');
    expect(call.result?.isError).toBe(true);
  });

  it('relays an upstream JSON-RPC error to the client', async () => {
    const raw = proxy();
    await handshake(raw);

    const call = await callTool(raw, 93, 'rpc-error');
    expect(call.error).toMatchObject({ code: -32000, message: 'upstream tool failure' });
  });
});

describe('FR-P5 — correlation', () => {
  it('injects a unique correlation id and preserves OTel context', async () => {
    const raw = proxy();
    await handshake(raw);

    const first = await callTool(
      raw,
      100,
      'echo-meta',
      { value: 1 },
      { traceparent: '00-abc-def-01', tracestate: 'vendor=1', baggage: 'k=v', custom: 'keep' },
    );
    const firstMeta = JSON.parse((first.result!.content as Array<{ text: string }>)[0]!.text) as {
      meta: Record<string, unknown>;
    };
    const namespace = firstMeta.meta.mcprelay as { correlation_id?: string };
    expect(namespace.correlation_id).toBeTypeOf('string');
    expect(firstMeta.meta.traceparent).toBe('00-abc-def-01');
    expect(firstMeta.meta.tracestate).toBe('vendor=1');
    expect(firstMeta.meta.baggage).toBe('k=v');
    expect(firstMeta.meta.custom).toBe('keep');

    const second = await callTool(raw, 101, 'echo-meta', { value: 2 });
    const secondMeta = JSON.parse((second.result!.content as Array<{ text: string }>)[0]!.text) as {
      meta: { mcprelay: { correlation_id: string } };
    };
    expect(secondMeta.meta.mcprelay.correlation_id).not.toBe(namespace.correlation_id);
  });
});

describe('FR-P4 — process hygiene', () => {
  it('forwards upstream stderr to stderr and keeps stdout protocol-pure', async () => {
    const raw = proxy();
    await handshake(raw);

    raw.send(requestFrame(110, 'x/stderr', { marker: 'proxy-stderr-marker' }));
    const response = (await raw.nextMessage()) as { id: number; result: unknown };
    expect(response.id).toBe(110);
    await waitForStderr(raw, 'proxy-stderr-marker');
  });

  it('surfaces an upstream crash as a clean error and exits 3', async () => {
    const raw = proxy();
    await handshake(raw);

    raw.send(requestFrame(120, 'tools/call', { name: 'crash', arguments: { delay_ms: 20 } }));
    const response = (await raw.nextMessage(8000)) as { id: number; error?: { code: number } };
    expect(response.id).toBe(120);
    expect(response.error).toBeTypeOf('object');

    const code = await raw.waitForExit(8000);
    expect(code).toBe(3);
  });
});

describe('FR-P6 — revision termination', () => {
  it('serves a legacy client against a modern upstream (independent negotiation)', async () => {
    const raw = proxy(['--modern']);
    const init = await handshake(raw, { protocolVersion: '2025-11-25' });
    expect(init.result?.protocolVersion).toBe('2025-11-25');

    const call = await callTool(raw, 2, 'echo', { era: 'independent' });
    expect(call.error).toBeUndefined();

    raw.send(requestFrame(3, 'x/era'));
    const era = (await raw.nextMessage()) as { result: { era: string } };
    expect(era.result.era).toBe('modern');
  });

  it('prefers 2026-07-28 when both sides support it', async () => {
    const client = new Client(
      { name: 'era-test-client', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StdioClientTransport({
      command: NODE,
      args: [CLI, 'run', '--', NODE, ECHO, '--modern'],
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      const result = await client.callTool({ name: 'echo', arguments: { modern: true } });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('answers an unsupported revision without crashing the session', async () => {
    const raw = proxy();
    raw.send(
      requestFrame(1, 'initialize', {
        protocolVersion: '1999-01-01',
        capabilities: {},
        clientInfo: { name: 'raw-test-client', version: '0.0.0' },
      }),
    );
    const response = (await raw.nextMessage()) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
    expect(response.error ?? response.result).toBeDefined();

    raw.send(requestFrame(2, 'ping'));
    const pong = (await raw.nextMessage()) as { id: number };
    expect(pong.id).toBe(2);
  });
});

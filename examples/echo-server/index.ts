#!/usr/bin/env node
/**
 * Hermetic echo MCP server — the deterministic upstream for mcprelay tests.
 *
 * Raw newline-delimited JSON-RPC on stdio (not SDK-based) so the full FR-P2
 * passthrough matrix is controllable: batch frames, unknown methods,
 * server→client requests, progress, stderr output, and a crash switch.
 *
 * Flags:
 *   --modern   speak the 2026-07-28 era (`server/discover` instead of `initialize`)
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Frame {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string; data?: Json };
}

type ResponseFrame = Frame & { id: string | number };

const CAPABILITIES: Json = {
  tools: {},
  resources: { subscribe: true },
  prompts: {},
  logging: {},
  completions: {},
};

const TOOLS: Json = [
  {
    name: 'echo',
    description: 'Echoes the call arguments',
    inputSchema: { type: 'object', additionalProperties: true },
  },
  { name: 'boom', description: 'Returns an isError result', inputSchema: { type: 'object' } },
  { name: 'rpc-error', description: 'Returns a JSON-RPC error', inputSchema: { type: 'object' } },
  {
    name: 'ask-client',
    description: 'Requests sampling from the client',
    inputSchema: { type: 'object' },
  },
  {
    name: 'ask-elicitation',
    description: 'Requests elicitation from the client',
    inputSchema: { type: 'object' },
  },
  {
    name: 'ask-roots',
    description: 'Requests roots from the client',
    inputSchema: { type: 'object' },
  },
  {
    name: 'echo-meta',
    description: 'Echoes arguments and request _meta',
    inputSchema: { type: 'object' },
  },
  {
    name: 'progress',
    description: 'Emits progress notifications',
    inputSchema: { type: 'object' },
  },
  { name: 'sleep', description: 'Waits before answering', inputSchema: { type: 'object' } },
  { name: 'crash', description: 'Exits the process mid-call', inputSchema: { type: 'object' } },
];

const modernMode = process.argv.includes('--modern');
let era: 'legacy' | 'modern' = modernMode ? 'modern' : 'legacy';
let nextServerRequestId = 1000;
let toolCallCount = 0;
let inputBuffer = '';
const receivedNotifications: Frame[] = [];
const pendingServerRequests = new Map<number, (response: Frame) => void>();

function asRecord(value: Json | undefined): Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function write(frame: Frame | Frame[]): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function ok(id: string | number, value: Json): ResponseFrame {
  const result = modernMode ? { ...asRecord(value), resultType: 'complete' } : value;
  return { jsonrpc: '2.0', id, result };
}

function errorFrame(
  id: string | number | null,
  code: number,
  message: string,
  data?: Json,
): ResponseFrame {
  return {
    jsonrpc: '2.0',
    id: id as string | number,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function requestClient(method: string, params: Json): Promise<Frame> {
  const id = nextServerRequestId++;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    write({ jsonrpc: '2.0', id, method, params });
  });
}

async function callTool(params: Json, id: string | number): Promise<ResponseFrame> {
  const record = asRecord(params);
  const name = typeof record.name === 'string' ? record.name : '';
  const args = asRecord(record.arguments);
  const meta = asRecord(record._meta);
  toolCallCount += 1;

  switch (name) {
    case 'echo':
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(args) }] });
    case 'echo-meta':
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify({ arguments: args, meta }) }],
      });
    case 'boom':
      return ok(id, { content: [{ type: 'text', text: 'boom' }], isError: true });
    case 'rpc-error':
      return errorFrame(id, -32000, 'upstream tool failure');
    case 'ask-client': {
      const answer = await requestClient('sampling/createMessage', {
        messages: [{ role: 'user', content: { type: 'text', text: 'ask' } }],
        maxTokens: 16,
      });
      if (answer.error || answer.result === undefined) {
        return ok(id, { content: [{ type: 'text', text: 'no sampling answer' }], isError: true });
      }
      const content = asRecord(asRecord(answer.result).content);
      return ok(id, { content: [{ type: 'text', text: String(content.text ?? '') }] });
    }
    case 'ask-elicitation': {
      const answer = await requestClient('elicitation/create', {
        message: 'provide a value',
        requestedSchema: { type: 'object', properties: { value: { type: 'string' } } },
      });
      if (answer.error || answer.result === undefined) {
        return ok(id, {
          content: [{ type: 'text', text: 'no elicitation answer' }],
          isError: true,
        });
      }
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(answer.result) }] });
    }
    case 'ask-roots': {
      const answer = await requestClient('roots/list', {});
      if (answer.error || answer.result === undefined) {
        return ok(id, { content: [{ type: 'text', text: 'no roots answer' }], isError: true });
      }
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(answer.result) }] });
    }
    case 'progress': {
      const steps = typeof args.steps === 'number' ? args.steps : 1;
      for (let step = 1; step <= steps; step += 1) {
        write({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: meta.progressToken ?? 'none', progress: step, total: steps },
        });
      }
      return ok(id, { content: [{ type: 'text', text: 'done' }] });
    }
    case 'sleep': {
      const ms = typeof args.ms === 'number' ? args.ms : 10;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ok(id, { content: [{ type: 'text', text: 'slept' }] });
    }
    case 'crash': {
      const delay = typeof args.delay_ms === 'number' ? args.delay_ms : 0;
      setTimeout(() => {
        process.exit(1);
      }, delay);
      return new Promise<ResponseFrame>(() => {});
    }
    default:
      return ok(id, { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true });
  }
}

async function handleRequest(frame: Frame): Promise<ResponseFrame> {
  const id = frame.id as string | number;
  const params = frame.params ?? null;

  switch (frame.method) {
    case 'initialize':
      era = 'legacy';
      return ok(id, {
        protocolVersion: '2025-11-25',
        capabilities: CAPABILITIES,
        serverInfo: { name: 'echo-server', version: '0.0.0' },
        instructions: 'hermetic echo server',
      });
    case 'server/discover':
      if (!modernMode) {
        return errorFrame(id, -32601, 'Method not found: server/discover');
      }
      era = 'modern';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          ttlMs: 0,
          cacheScope: 'private',
          supportedVersions: ['2026-07-28'],
          capabilities: CAPABILITIES,
          instructions: 'hermetic echo server',
        },
      };
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call':
      return callTool(params, id);
    case 'resources/list':
      return ok(id, { resources: [{ uri: 'echo://one', name: 'one' }] });
    case 'resources/read': {
      const uri =
        typeof asRecord(params).uri === 'string' ? String(asRecord(params).uri) : 'echo://one';
      return ok(id, { contents: [{ uri, text: 'echo' }] });
    }
    case 'resources/templates/list':
      return ok(id, { resourceTemplates: [{ uriTemplate: 'echo://{id}', name: 'echo' }] });
    case 'resources/subscribe':
    case 'resources/unsubscribe':
      return ok(id, {});
    case 'prompts/list':
      return ok(id, { prompts: [{ name: 'echo' }] });
    case 'prompts/get':
      return ok(id, { messages: [{ role: 'user', content: { type: 'text', text: 'echo' } }] });
    case 'completion/complete':
      return ok(id, { completion: { values: ['echo'], total: 1, hasMore: false } });
    case 'logging/setLevel':
      return ok(id, {});
    case 'ping':
      return ok(id, {});
    case 'x/echo':
      return ok(id, { received: params });
    case 'x/era':
      return ok(id, { era });
    case 'x/notifications':
      return ok(id, {
        notifications: receivedNotifications.map((entry) => ({
          method: entry.method ?? '',
          params: entry.params ?? null,
        })),
      });
    case 'x/stats':
      return ok(id, { toolCalls: toolCallCount });
    case 'x/notify':
      write({ jsonrpc: '2.0', method: 'notifications/x/custom', params: { from: 'echo-server' } });
      return ok(id, {});
    case 'x/stderr': {
      const marker = asRecord(params).marker;
      process.stderr.write(`${typeof marker === 'string' ? marker : 'stderr'}\n`);
      return ok(id, {});
    }
    default:
      return errorFrame(id, -32601, `Method not found: ${frame.method ?? ''}`);
  }
}

async function handleFrame(frame: unknown): Promise<void> {
  if (Array.isArray(frame)) {
    const responses = await Promise.all(
      frame
        .filter((entry): entry is Frame => entry !== null && typeof entry === 'object')
        .filter((entry) => entry.method !== undefined && entry.id !== undefined)
        .map((entry) => handleRequest(entry)),
    );
    if (responses.length > 0) write(responses);
    return;
  }
  if (frame === null || typeof frame !== 'object') return;
  const message = frame as Frame;
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const resolve = pendingServerRequests.get(Number(message.id));
    if (resolve) {
      pendingServerRequests.delete(Number(message.id));
      resolve(message);
    }
    return;
  }
  if (message.method !== undefined && message.id !== undefined) {
    write(await handleRequest(message));
    return;
  }
  if (message.method !== undefined) {
    receivedNotifications.push(message);
  }
}

function drain(): void {
  let index: number;
  while ((index = inputBuffer.indexOf('\n')) >= 0) {
    const line = inputBuffer.slice(0, index).trim();
    inputBuffer = inputBuffer.slice(index + 1);
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      write(errorFrame(null, -32700, 'Parse error'));
      continue;
    }
    void handleFrame(parsed);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  inputBuffer += chunk;
  drain();
});
process.stdin.on('end', () => {
  process.exit(0);
});

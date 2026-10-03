#!/usr/bin/env node
/**
 * Hermetic Streamable HTTP echo MCP server — the deterministic HTTP upstream
 * for mcprelay tests. Built on the SDK server transport (the same machinery
 * real servers use), served over `node:http`.
 *
 * Binds an ephemeral port by default and prints the bound URL on stdout:
 *   http-echo-server listening on http://127.0.0.1:<port>/mcp
 *
 * Tools: echo, boom (isError), rpc-error (JSON-RPC error), sleep (timeout),
 * http-error (the HTTP layer answers 500 after the request arrived).
 *
 * Custom method `x/stats` reports `{ toolCalls, lastHeaders }` for tests.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  ProtocolError,
  Server,
  createMcpHandler,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/server';

const TOOLS: ListToolsResult['tools'] = [
  {
    name: 'echo',
    description: 'Echoes the call arguments',
    inputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'boom',
    description: 'Returns an isError result',
    inputSchema: { type: 'object' },
  },
  {
    name: 'rpc-error',
    description: 'Returns a JSON-RPC error',
    inputSchema: { type: 'object' },
  },
  {
    name: 'sleep',
    description: 'Waits before answering',
    inputSchema: { type: 'object' },
  },
  {
    name: 'http-error',
    description: 'The HTTP layer answers 500',
    inputSchema: { type: 'object' },
  },
];

let toolCalls = 0;
let lastHeaders: Record<string, string | string[] | undefined> = {};

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function createFixtureServer(): Server {
  const server = new Server(
    { name: 'http-echo-server', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler('tools/list', () => ({ tools: TOOLS }));

  server.setRequestHandler('tools/call', async (request) => {
    toolCalls += 1;
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'echo':
        return textResult(args);
      case 'boom':
        return { content: [{ type: 'text', text: 'boom' }], isError: true };
      case 'rpc-error':
        throw new ProtocolError(-32000, 'upstream tool failure');
      case 'sleep': {
        const ms = typeof args.ms === 'number' ? args.ms : 100;
        await new Promise((resolve) => setTimeout(resolve, ms));
        return textResult('done');
      }
      default:
        throw new ProtocolError(-32602, `tool '${name}' not found`);
    }
  });

  server.fallbackRequestHandler = async (request) => {
    if (request.method === 'x/stats') return { toolCalls, lastHeaders };
    throw new ProtocolError(-32601, `Method not found: ${request.method}`);
  };

  return server;
}

const handler = createMcpHandler(() => createFixtureServer());

async function nodeRequestToFetch(request: IncomingMessage): Promise<Request> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  return new Request(url, {
    method: request.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

/** Streams the web Response body to the node response (SSE-safe). */
async function writeFetchResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, key) => target.setHeader(key, value));
  if (response.body === null) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    target.write(Buffer.from(value));
  }
  target.end();
}

/** True for the forced-500 tool: the request arrived, the HTTP layer fails it. */
async function isHttpErrorCall(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const body = await request.clone().text();
  try {
    const parsed = JSON.parse(body) as { method?: string; params?: { name?: string } };
    return parsed.method === 'tools/call' && parsed.params?.name === 'http-error';
  } catch {
    return false;
  }
}

const httpServer = createServer((request, response) => {
  void (async () => {
    try {
      lastHeaders = { ...request.headers };
      const fetchRequest = await nodeRequestToFetch(request);
      if (await isHttpErrorCall(fetchRequest)) {
        response.statusCode = 500;
        response.end('forced http error');
        return;
      }
      const fetchResponse = await handler.fetch(fetchRequest);
      await writeFetchResponse(fetchResponse, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  })();
});

function requestedPort(): number {
  const index = process.argv.indexOf('--port');
  if (index >= 0) {
    const port = Number(process.argv[index + 1]);
    if (Number.isInteger(port) && port >= 0) return port;
  }
  return 0;
}

httpServer.listen(requestedPort(), '127.0.0.1', () => {
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.stdout.write(`http-echo-server listening on http://127.0.0.1:${port}/mcp\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handler.close().finally(() => {
      httpServer.close(() => process.exit(0));
    });
  });
}

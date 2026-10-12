import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { requestFrame, startRaw, type RawSession } from './helpers/raw-client.js';

const NODE = process.execPath;
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../examples', import.meta.url));

interface Recipe {
  name: string;
  server: (workspace: string) => string[];
}

/** Public MCP servers, unpinned on purpose: the recipes document `npx -y <pkg>`. */
const RECIPES: Recipe[] = [
  {
    name: 'filesystem',
    server: (workspace) => ['npx', '-y', '@modelcontextprotocol/server-filesystem', workspace],
  },
  { name: 'memory', server: () => ['npx', '-y', '@modelcontextprotocol/server-memory'] },
  { name: 'everything', server: () => ['npx', '-y', '@modelcontextprotocol/server-everything'] },
];

const sessions: RawSession[] = [];

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
});

/** Reads frames until the response with `id` arrives; answers server→client requests. */
async function nextResponse(
  raw: RawSession,
  id: number,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  for (;;) {
    const frame = (await raw.nextMessage(60_000)) as {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (frame.method !== undefined && frame.id !== undefined) {
      const result = frame.method === 'roots/list' ? { roots: [] } : {};
      raw.send({ jsonrpc: '2.0', id: frame.id, result });
      continue;
    }
    if (frame.id === id) return frame;
  }
}

async function handshake(raw: RawSession): Promise<void> {
  raw.send(
    requestFrame(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'examples-test', version: '0.0.0' },
    }),
  );
  await nextResponse(raw, 1);
  raw.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function listTools(raw: RawSession): Promise<unknown[]> {
  raw.send(requestFrame(2, 'tools/list'));
  const response = await nextResponse(raw, 2);
  return (response.result as { tools: unknown[] }).tools;
}

describe('examples — public MCP server recipes (release gate)', () => {
  it('ships three documented recipes, each with a config and a README', () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(3);
    for (const recipe of RECIPES) {
      expect(
        existsSync(join(EXAMPLES, recipe.name, 'mcprelay.config.yaml')),
        `${recipe.name}: mcprelay.config.yaml missing`,
      ).toBe(true);
      expect(
        existsSync(join(EXAMPLES, recipe.name, 'README.md')),
        `${recipe.name}: README missing`,
      ).toBe(true);
    }
  });

  for (const recipe of RECIPES) {
    it(`wraps the ${recipe.name} server and lists its tools`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `mcprelay-${recipe.name}-`));
      mkdirSync(join(dir, 'workspace'), { recursive: true });
      const raw = startRaw(
        NODE,
        [
          CLI,
          'run',
          '--config',
          join(EXAMPLES, recipe.name, 'mcprelay.config.yaml'),
          '--',
          ...recipe.server(join(dir, 'workspace')),
        ],
        { cwd: dir },
      );
      sessions.push(raw);

      try {
        await handshake(raw);
        const tools = await listTools(raw);
        expect(tools.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 90_000);
  }
});

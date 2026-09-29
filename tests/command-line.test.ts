import { describe, expect, it } from 'vitest';

import { parseCommandLine, quoteCommandLine } from '../src/replay/command-line.js';

describe('command line round-trip', () => {
  it('quotes and parses simple commands', () => {
    const line = quoteCommandLine('npx', ['@modelcontextprotocol/server-filesystem', '.']);
    expect(parseCommandLine(line)).toEqual({
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '.'],
    });
  });

  it('preserves arguments with spaces and quotes', () => {
    const line = quoteCommandLine('node', [
      '/path with spaces/server.js',
      "--name=O'Brien",
      'plain',
    ]);
    expect(parseCommandLine(line)).toEqual({
      command: 'node',
      args: ['/path with spaces/server.js', "--name=O'Brien", 'plain'],
    });
  });

  it('handles a command with no arguments', () => {
    expect(parseCommandLine(quoteCommandLine('server', []))).toEqual({
      command: 'server',
      args: [],
    });
  });

  it('rejects unbalanced quotes', () => {
    expect(() => parseCommandLine("node 'unclosed")).toThrowError(/quote/i);
  });
});

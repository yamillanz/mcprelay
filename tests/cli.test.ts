import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { EXIT_OK, EXIT_USAGE, runCli, type CliIO } from '../src/cli/run.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

function capture(): { io: CliIO; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

describe('mcprelay version', () => {
  it('prints the package version for `version`', async () => {
    const { io, stdout, stderr } = capture();

    const code = await runCli(['version'], io);

    expect(code).toBe(EXIT_OK);
    expect(stdout()).toBe(`${pkg.version}\n`);
    expect(stderr()).toBe('');
  });

  it.each(['--version', '-v'])('prints the package version for `%s`', async (flag) => {
    const { io, stdout } = capture();

    const code = await runCli([flag], io);

    expect(code).toBe(EXIT_OK);
    expect(stdout()).toBe(`${pkg.version}\n`);
  });
});

describe('mcprelay help', () => {
  it.each([[[]], [['--help']], [['-h']], [['help']]])('prints usage for %j', async (argv) => {
    const { io, stdout, stderr } = capture();

    const code = await runCli(argv, io);

    expect(code).toBe(EXIT_OK);
    expect(stdout()).toContain('Usage:');
    expect(stdout()).toContain('mcprelay');
    expect(stdout()).toContain('version');
    expect(stderr()).toBe('');
  });
});

describe('mcprelay usage errors', () => {
  it('rejects an unknown command with exit code 2 and a hint on stderr', async () => {
    const { io, stdout, stderr } = capture();

    const code = await runCli(['frobnicate'], io);

    expect(code).toBe(EXIT_USAGE);
    expect(stdout()).toBe('');
    expect(stderr()).toContain('frobnicate');
    expect(stderr()).toContain('--help');
  });

  it('rejects an unknown option with exit code 2', async () => {
    const { io, stderr } = capture();

    const code = await runCli(['--no-such-flag'], io);

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain('--no-such-flag');
  });
});

describe('mcprelay run transport forms', () => {
  it('rejects --http combined with -- as a usage error', async () => {
    const { io, stderr } = capture();
    const code = await runCli(
      ['run', '--http', 'http://127.0.0.1:1/mcp', '--', 'node', 'server.js'],
      io,
    );
    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain('not both');
  });

  it('rejects a missing --http value', async () => {
    const { io, stderr } = capture();
    const code = await runCli(['run', '--http'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain("Missing value for '--http'");
  });

  it('rejects an invalid --http URL', async () => {
    const { io, stderr } = capture();
    const code = await runCli(['run', '--http', 'not a url'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain('Invalid URL');
  });

  it('still requires a target when neither form is given', async () => {
    const { io, stderr } = capture();
    const code = await runCli(['run'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain('--http');
  });
});

describe('mcprelay run parser characterization', () => {
  it.each([['--config'], ['--timeout-ms'], ['--max-attempts']])(
    'rejects a missing value for `%s`',
    async (flag) => {
      const { io, stderr } = capture();

      const code = await runCli(['run', flag], io);

      expect(code).toBe(EXIT_USAGE);
      expect(stderr()).toContain(`Missing value for '${flag}'.`);
    },
  );

  it.each([
    ['--timeout-ms', 'abc'],
    ['--timeout-ms', '0'],
    ['--timeout-ms', '-1'],
    ['--timeout-ms', '1.5'],
    ['--max-attempts', 'abc'],
    ['--max-attempts', '0'],
    ['--max-attempts', '-1'],
    ['--max-attempts', '1.5'],
  ])('rejects an invalid value for `%s`: %s', async (flag, value) => {
    const { io, stderr } = capture();

    const code = await runCli(['run', flag, value], io);

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain(`Invalid value for '${flag}': ${value}`);
  });

  it('rejects an unknown option', async () => {
    const { io, stderr } = capture();

    const code = await runCli(['run', '--bogus'], io);

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain("Unknown option '--bogus'.");
  });

  it('rejects `--` without a server command', async () => {
    const { io, stderr } = capture();

    const code = await runCli(['run', '--'], io);

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain('Usage: mcprelay run');
  });

  it('treats options after `--` as server arguments', async () => {
    const { io, stderr } = capture();

    const code = await runCli(
      ['run', '--config', '/nonexistent.yaml', '--', 'node', 'server.js', '--http', 'x'],
      io,
    );

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain('config file not found');
    expect(stderr()).not.toContain('Unknown option');
  });

  it('accepts every option before the server command', async () => {
    const { io, stderr } = capture();

    const code = await runCli(
      [
        'run',
        '--config',
        '/nonexistent.yaml',
        '--timeout-ms',
        '100',
        '--max-attempts',
        '2',
        '--policy-dry-run',
        '--',
        'node',
        'server.js',
      ],
      io,
    );

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain('config file not found');
  });

  it('accepts the `--http` form with a config path', async () => {
    const { io, stderr } = capture();

    const code = await runCli(
      ['run', '--http', 'http://127.0.0.1:1/mcp', '--config', '/nonexistent.yaml'],
      io,
    );

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain('config file not found');
  });

  it('routes the shorthand form without the `run` keyword', async () => {
    const { io, stderr } = capture();

    const code = await runCli(['--config', '/nonexistent.yaml', '--', 'node', 'server.js'], io);

    expect(code).toBe(EXIT_USAGE);
    expect(stderr()).toContain('config file not found');
  });
});

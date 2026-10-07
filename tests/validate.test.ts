import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { startRaw, type RawSession } from './helpers/raw-client.js';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const NODE = process.execPath;

const sessions: RawSession[] = [];

function run(args: string[]): RawSession {
  const raw = startRaw(NODE, [CLI, ...args]);
  sessions.push(raw);
  return raw;
}

afterEach(() => {
  for (const raw of sessions.splice(0)) raw.close();
});

describe('mcprelay validate', () => {
  it('exits 0 with a summary when no config file exists', async () => {
    const raw = run(['validate']);
    expect(await raw.nextLine()).toContain('config ok');
    expect(await raw.waitForExit()).toBe(0);
    expect(raw.stderr()).toContain('no policy rules');
  });

  it('accepts a valid config and does not touch the databases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprelay-validate-'));
    const queuePath = join(dir, '.mcprelay', 'queue.db');
    const configPath = join(dir, 'mcprelay.config.yaml');
    writeFileSync(
      configPath,
      `queue:\n  provider: sqlite\n  sqlite:\n    path: ${queuePath}\n`,
      'utf8',
    );

    const raw = run(['validate', '--config', configPath]);
    expect(await raw.waitForExit()).toBe(0);
    expect(existsSync(queuePath)).toBe(false);
  });

  it('reports path and field for a malformed config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprelay-validate-'));
    const configPath = join(dir, 'mcprelay.config.yaml');
    writeFileSync(configPath, 'queue:\n  provider: redis\n', 'utf8');

    const raw = run(['validate', '--config', configPath]);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain(configPath);
    expect(raw.stderr()).toContain('queue.provider');
  });

  it('fails when the explicit config path does not exist', async () => {
    const raw = run(['validate', '--config', '/tmp/does-not-exist-mcprelay.yaml']);
    expect(await raw.waitForExit()).toBe(2);
    expect(raw.stderr()).toContain('/tmp/does-not-exist-mcprelay.yaml');
  });

  it('validates a rabbitmq provider offline, without a broker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcprelay-validate-'));
    const configPath = join(dir, 'mcprelay.config.yaml');
    writeFileSync(
      configPath,
      'queue:\n  provider: rabbitmq\n  rabbitmq:\n    url: amqp://localhost\n',
      'utf8',
    );

    const raw = run(['validate', '--config', configPath]);
    expect(await raw.nextLine()).toContain('config ok');
    expect(await raw.waitForExit()).toBe(0);
  });
});

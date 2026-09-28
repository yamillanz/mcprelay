import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConfigError, defaultConfig, loadConfig, resolveToolPolicy } from '../src/config/config.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcprelay-config-'));
}

function writeConfig(content: string): string {
  const path = join(tempDir(), 'mcprelay.config.yaml');
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('configuration defaults', () => {
  it('provides safe zero-config defaults', () => {
    const config = defaultConfig();
    expect(config.reliability.timeoutMs).toBe(30000);
    expect(config.reliability.retry).toEqual({
      maxAttempts: 3,
      backoff: 'exponential',
      baseMs: 250,
      jitter: true,
    });
    expect(config.reliability.idempotentDefault).toBe(false);
    expect(config.reliability.perTool).toEqual({});
  });

  it('starts with defaults when no file exists', () => {
    const config = loadConfig({ cwd: tempDir() });
    expect(config.reliability.timeoutMs).toBe(30000);
    expect(config.warnings).toEqual([]);
  });
});

describe('configuration file', () => {
  it('applies file values', () => {
    const path = writeConfig(`
reliability:
  timeout_ms: 5000
  retry:
    max_attempts: 2
    base_ms: 100
    jitter: false
`);
    const config = loadConfig({ path });
    expect(config.reliability.timeoutMs).toBe(5000);
    expect(config.reliability.retry.maxAttempts).toBe(2);
    expect(config.reliability.retry.baseMs).toBe(100);
    expect(config.reliability.retry.jitter).toBe(false);
    expect(config.reliability.retry.backoff).toBe('exponential');
  });

  it('applies per-tool overrides and resolves policies', () => {
    const path = writeConfig(`
reliability:
  per_tool:
    slow_tool:
      timeout_ms: 120000
      retry:
        max_attempts: 1
    create_issue:
      idempotent: true
    flaky_search:
      effects: read
`);
    const config = loadConfig({ path });

    expect(resolveToolPolicy(config, 'slow_tool')).toEqual({
      timeoutMs: 120000,
      retry: { maxAttempts: 1, backoff: 'exponential', baseMs: 250, jitter: true },
      idempotent: false,
    });
    expect(resolveToolPolicy(config, 'create_issue')).toMatchObject({
      timeoutMs: 30000,
      idempotent: true,
    });
    expect(resolveToolPolicy(config, 'other_tool')).toMatchObject({
      timeoutMs: 30000,
      idempotent: false,
    });
  });

  it('rejects a malformed known section with an actionable error', () => {
    const path = writeConfig(`
reliability:
  timeout_ms: soon
`);
    expect(() => loadConfig({ path })).toThrowError(ConfigError);
    try {
      loadConfig({ path });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(path);
      expect(message).toContain('reliability.timeout_ms');
    }
  });

  it('rejects unknown keys inside the reliability section', () => {
    const path = writeConfig(`
reliability:
  timeout_ms: 1000
  retry_typo: true
`);
    expect(() => loadConfig({ path })).toThrowError(/reliability\.retry_typo/);
  });

  it('warns about unknown top-level sections and starts anyway', () => {
    const path = writeConfig(`
queue:
  provider: sqlite
reliability:
  timeout_ms: 1000
`);
    const config = loadConfig({ path });
    expect(config.reliability.timeoutMs).toBe(1000);
    expect(config.warnings.join(' ')).toContain('queue');
  });

  it('fails when an explicit config path does not exist', () => {
    expect(() => loadConfig({ path: join(tempDir(), 'missing.yaml') })).toThrowError(ConfigError);
  });
});

describe('CLI overrides', () => {
  it('flags beat file values', () => {
    const path = writeConfig(`
reliability:
  timeout_ms: 5000
  retry:
    max_attempts: 2
`);
    const config = loadConfig({ path, overrides: { timeoutMs: 1234, maxAttempts: 7 } });
    expect(config.reliability.timeoutMs).toBe(1234);
    expect(config.reliability.retry.maxAttempts).toBe(7);
  });
});

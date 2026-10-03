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
    expect(config.warnings.join(' ')).toContain('no policy rules');
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
      captureToolErrors: false,
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
future_section:
  enabled: true
reliability:
  timeout_ms: 1000
`);
    const config = loadConfig({ path });
    expect(config.reliability.timeoutMs).toBe(1000);
    expect(config.warnings.join(' ')).toContain('future_section');
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

describe('queue, store, and redaction sections', () => {
  it('provides safe defaults', () => {
    const config = defaultConfig();
    expect(config.queue).toEqual({ provider: 'sqlite', sqlite: { path: './.mcprelay/queue.db' } });
    expect(config.store).toEqual({
      provider: 'sqlite',
      sqlite: { path: './.mcprelay/history.db' },
    });
    expect(config.redaction.patterns).toContain('api_key');
    expect(config.redaction.patterns).toContain('credential');
  });

  it('applies file overrides', () => {
    const path = writeConfig(`
queue:
  provider: sqlite
  sqlite:
    path: /tmp/custom-queue.db
store:
  provider: sqlite
  sqlite:
    path: /tmp/custom-store.db
redaction:
  patterns: [my_secret, api_key]
`);
    const config = loadConfig({ path });
    expect(config.queue.sqlite.path).toBe('/tmp/custom-queue.db');
    expect(config.store.sqlite.path).toBe('/tmp/custom-store.db');
    expect(config.redaction.patterns).toEqual(['my_secret', 'api_key']);
  });

  it('rejects an unsupported queue provider with path and field', () => {
    const path = writeConfig('queue:\n  provider: redis\n');
    expect(() => loadConfig({ path })).toThrowError(/queue\.provider/);
  });

  it('rejects unknown keys inside queue', () => {
    const path = writeConfig('queue:\n  nope: true\n');
    expect(() => loadConfig({ path })).toThrowError(/queue\.nope/);
  });

  it('accepts capture_tool_errors and resolves it into the tool policy', () => {
    const path = writeConfig(`
reliability:
  per_tool:
    flaky:
      capture_tool_errors: true
`);
    const config = loadConfig({ path });
    expect(resolveToolPolicy(config, 'flaky').captureToolErrors).toBe(true);
    expect(resolveToolPolicy(config, 'echo').captureToolErrors).toBe(false);
  });
});

describe('policy section', () => {
  it('provides an allow-all default and warns when no rules are configured', () => {
    const config = loadConfig({ cwd: tempDir() });
    expect(config.policy.default).toBe('allow');
    expect(config.policy.rules).toEqual([]);
    expect(config.warnings.join(' ')).toMatch(/no policy rules/);
  });

  it('parses rules in order with compiled matchers', () => {
    const path = writeConfig(`
policy:
  default: deny
  rules:
    - tool: fs/read_file
      args:
        path:
          prefix: /projects
      action: allow
    - tool: "fs/delete_*"
      action: deny
`);
    const config = loadConfig({ path });
    expect(config.policy.default).toBe('deny');
    expect(config.policy.rules).toHaveLength(2);
    expect(config.policy.rules[0]?.tool).toBe('fs/read_file');
    expect(config.policy.rules[0]?.specificity).toBe(3);
    expect(config.policy.rules[1]?.toolRegex.test('fs/delete_all')).toBe(true);
    expect(config.warnings).toEqual([]);
  });

  it('rejects a malformed rule with path and field', () => {
    const path = writeConfig(`
policy:
  rules:
    - tool: read_file
      args:
        path:
          regex: "(a+)+$"
      action: allow
`);
    expect(() => loadConfig({ path })).toThrowError(ConfigError);
    try {
      loadConfig({ path });
    } catch (error) {
      expect((error as Error).message).toContain('policy.rules[0].args.path.regex');
    }
  });

  it('rejects unknown keys inside policy', () => {
    const path = writeConfig('policy:\n  rules: []\n  mode: strict\n');
    expect(() => loadConfig({ path })).toThrowError(/policy\.mode/);
  });

  it('accepts the dry-run override', () => {
    expect(loadConfig({ cwd: tempDir(), overrides: { policyDryRun: true } }).policyDryRun).toBe(
      true,
    );
    expect(defaultConfig().policyDryRun).toBe(false);
  });
});

describe('upstream HTTP section', () => {
  it('parses configured headers', () => {
    const path = writeConfig(
      'upstream:\n  http:\n    headers:\n      x-test-header: configured-value\n',
    );
    const config = loadConfig({ path });
    expect(config.upstream.http.headers).toEqual({ 'x-test-header': 'configured-value' });
  });

  it('defaults to no headers', () => {
    expect(defaultConfig().upstream).toEqual({ http: { headers: {} } });
  });

  it('rejects malformed headers with path and field', () => {
    const nonString = writeConfig('upstream:\n  http:\n    headers:\n      x-test-header: 42\n');
    expect(() => loadConfig({ path: nonString })).toThrowError(
      /upstream\.http\.headers\.x-test-header/,
    );

    const notMapping = writeConfig('upstream:\n  http:\n    headers: nope\n');
    expect(() => loadConfig({ path: notMapping })).toThrowError(/upstream\.http\.headers/);
  });

  it('rejects unknown keys inside upstream', () => {
    const path = writeConfig('upstream:\n  socks: {}\n');
    expect(() => loadConfig({ path })).toThrowError(/upstream\.socks/);
  });
});

describe('replay dedup window', () => {
  it('defaults to 24 hours', () => {
    expect(defaultConfig().reliability.replay.dedupWindowMs).toBe(24 * 60 * 60 * 1000);
  });

  it('parses duration strings', () => {
    const path = writeConfig('reliability:\n  replay:\n    dedup_window: 30m\n');
    expect(loadConfig({ path }).reliability.replay.dedupWindowMs).toBe(30 * 60 * 1000);
  });

  it('rejects an invalid duration with path and field', () => {
    const path = writeConfig('reliability:\n  replay:\n    dedup_window: soon\n');
    expect(() => loadConfig({ path })).toThrowError(/reliability\.replay\.dedup_window/);
  });

  it('rejects unknown keys inside replay', () => {
    const path = writeConfig('reliability:\n  replay:\n    window: 1h\n');
    expect(() => loadConfig({ path })).toThrowError(/reliability\.replay\.window/);
  });
});

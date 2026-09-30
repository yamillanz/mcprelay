import { describe, expect, it } from 'vitest';

import { PolicyError, evaluateCall, parsePolicyConfig } from '../src/policy/policy.js';

const LABEL = 'policy';

function parse(section: unknown) {
  return parsePolicyConfig(section, LABEL);
}

describe('policy parsing', () => {
  it('parses the default action and rules in file order', () => {
    const policy = parse({
      default: 'deny',
      rules: [
        { tool: 'read_file', action: 'allow' },
        { tool: 'fs/delete_*', action: 'deny' },
      ],
    });
    expect(policy.default).toBe('deny');
    expect(policy.rules.map((rule) => rule.tool)).toEqual(['read_file', 'fs/delete_*']);
    expect(policy.rules[1]?.action).toBe('deny');
  });

  it('defaults the action to allow when the section omits it', () => {
    expect(parse({ rules: [] }).default).toBe('allow');
  });

  it('accepts a caller and argument matchers', () => {
    const policy = parse({
      rules: [
        {
          tool: 'deploy',
          caller: 'ci-bot',
          args: { 'config.timeout': { min: 1, max: 30 } },
          action: 'allow',
        },
      ],
    });
    expect(policy.rules[0]?.caller).toBe('ci-bot');
    expect(policy.rules[0]?.args).toHaveLength(1);
    expect(policy.rules[0]?.args[0]?.path).toBe('config.timeout');
  });

  it('rejects unknown keys with the config path', () => {
    expect(() => parse({ defualt: 'deny' })).toThrowError(/policy\.defualt/);
    expect(() => parse({ rules: [{ tool: 'x', action: 'allow', when: {} }] })).toThrowError(
      /policy\.rules\[0\]\.when/,
    );
  });

  it('rejects an invalid default action', () => {
    expect(() => parse({ default: 'maybe' })).toThrowError(/policy\.default/);
  });

  it('rejects malformed rules with the rule index', () => {
    expect(() => parse({ rules: {} })).toThrowError(/policy\.rules/);
    expect(() => parse({ rules: ['nope'] })).toThrowError(/policy\.rules\[0\]/);
    expect(() => parse({ rules: [{ action: 'allow' }] })).toThrowError(/policy\.rules\[0\]\.tool/);
    expect(() => parse({ rules: [{ tool: 'x' }] })).toThrowError(/policy\.rules\[0\]\.action/);
    expect(() => parse({ rules: [{ tool: 'x', action: 'ask' }] })).toThrowError(
      /policy\.rules\[0\]\.action/,
    );
    expect(() => parse({ rules: [{ tool: 'x', caller: 5, action: 'allow' }] })).toThrowError(
      /policy\.rules\[0\]\.caller/,
    );
    expect(() => parse({ rules: [{ tool: 'x', args: 'nope', action: 'allow' }] })).toThrowError(
      /policy\.rules\[0\]\.args/,
    );
    expect(() =>
      parse({ rules: [{ tool: 'x', args: { path: { prefix: '/ok' } }, action: 'allow' }] }),
    ).not.toThrow();
  });

  it('rejects a bad matcher with the full path', () => {
    expect(() =>
      parse({ rules: [{ tool: 'x', args: { path: { bogus: 1 } }, action: 'allow' }] }),
    ).toThrowError(/policy\.rules\[0\]\.args\.path\.bogus/);
  });

  it('exposes PolicyError for callers to wrap', () => {
    expect(() => parse({ default: 'maybe' })).toThrowError(PolicyError);
  });
});

describe('precedence (FR-Y1)', () => {
  it('exact tool match beats a glob', () => {
    const policy = parse({
      default: 'allow',
      rules: [
        { tool: 'fs/*', action: 'deny' },
        { tool: 'fs/read_file', action: 'allow' },
      ],
    });
    expect(evaluateCall(policy, { tool: 'fs/read_file', arguments: {} }).action).toBe('allow');
    expect(evaluateCall(policy, { tool: 'fs/write_file', arguments: {} }).action).toBe('deny');
  });

  it('a later more specific allow overrides an earlier broad deny', () => {
    const policy = parse({
      default: 'allow',
      rules: [
        { tool: 'write_*', action: 'deny' },
        { tool: 'write_log', args: { path: { prefix: '/var/log' } }, action: 'allow' },
      ],
    });
    expect(
      evaluateCall(policy, { tool: 'write_log', arguments: { path: '/var/log/a' } }).action,
    ).toBe('allow');
    expect(evaluateCall(policy, { tool: 'write_log', arguments: { path: '/etc/a' } }).action).toBe(
      'deny',
    );
  });

  it('a caller-specific rule beats a caller-less rule of equal tool specificity', () => {
    const policy = parse({
      default: 'allow',
      rules: [
        { tool: 'deploy', action: 'deny' },
        { tool: 'deploy', caller: 'ci-bot', action: 'allow' },
      ],
    });
    expect(evaluateCall(policy, { tool: 'deploy', arguments: {}, caller: 'ci-bot' }).action).toBe(
      'allow',
    );
    expect(evaluateCall(policy, { tool: 'deploy', arguments: {}, caller: 'local' }).action).toBe(
      'deny',
    );
  });

  it('more argument matchers beat fewer', () => {
    const policy = parse({
      default: 'allow',
      rules: [
        { tool: 'search', args: { query: { prefix: 'public' } }, action: 'deny' },
        {
          tool: 'search',
          args: { query: { prefix: 'public' }, limit: { max: 10 } },
          action: 'allow',
        },
      ],
    });
    expect(
      evaluateCall(policy, { tool: 'search', arguments: { query: 'public docs', limit: 5 } })
        .action,
    ).toBe('allow');
    expect(
      evaluateCall(policy, { tool: 'search', arguments: { query: 'public docs', limit: 50 } })
        .action,
    ).toBe('deny');
  });

  it('breaks ties by file order, every time', () => {
    const policy = parse({
      default: 'deny',
      rules: [
        { tool: 'echo', action: 'allow' },
        { tool: 'echo', action: 'deny' },
      ],
    });
    for (let round = 0; round < 3; round += 1) {
      expect(evaluateCall(policy, { tool: 'echo', arguments: {} }).action).toBe('allow');
    }
  });

  it('reports the matched rule number and reason', () => {
    const policy = parse({
      default: 'allow',
      rules: [
        { tool: 'a', action: 'allow' },
        { tool: 'b', action: 'deny' },
      ],
    });
    const decision = evaluateCall(policy, { tool: 'b', arguments: {} });
    expect(decision.rule).toBe(2);
    expect(decision.reason).toContain('#2');
  });
});

describe('argument rules (FR-Y2)', () => {
  it('requires every matcher on every path', () => {
    const policy = parse({
      default: 'deny',
      rules: [
        {
          tool: 'read_file',
          args: { path: { prefix: '/projects' }, encoding: { in: ['utf8'] } },
          action: 'allow',
        },
      ],
    });
    expect(
      evaluateCall(policy, {
        tool: 'read_file',
        arguments: { path: '/projects/a', encoding: 'utf8' },
      }).action,
    ).toBe('allow');
    expect(
      evaluateCall(policy, {
        tool: 'read_file',
        arguments: { path: '/projects/a', encoding: 'hex' },
      }).action,
    ).toBe('deny');
  });

  it('a missing argument path never matches', () => {
    const policy = parse({
      default: 'deny',
      rules: [{ tool: 'read_file', args: { path: { prefix: '/projects' } }, action: 'allow' }],
    });
    expect(evaluateCall(policy, { tool: 'read_file', arguments: {} }).action).toBe('deny');
    expect(evaluateCall(policy, { tool: 'read_file', arguments: undefined }).action).toBe('deny');
  });

  it('falls through to the next matching rule when args do not match', () => {
    const policy = parse({
      default: 'deny',
      rules: [
        { tool: 'read_file', args: { path: { prefix: '/projects' } }, action: 'allow' },
        { tool: 'read_file', action: 'deny' },
      ],
    });
    expect(evaluateCall(policy, { tool: 'read_file', arguments: { path: '/tmp/a' } }).action).toBe(
      'deny',
    );
  });
});

describe('default action (FR-Y1)', () => {
  it('applies when no rule matches', () => {
    const allowPolicy = parse({ default: 'allow', rules: [] });
    const denyPolicy = parse({ default: 'deny', rules: [] });
    expect(evaluateCall(allowPolicy, { tool: 'anything', arguments: {} }).action).toBe('allow');
    expect(evaluateCall(denyPolicy, { tool: 'anything', arguments: {} }).action).toBe('deny');
    expect(evaluateCall(allowPolicy, { tool: 'anything', arguments: {} }).rule).toBeNull();
  });
});

describe('caller identity', () => {
  it('defaults to local when the call does not name a caller', () => {
    const policy = parse({
      default: 'allow',
      rules: [{ tool: 'deploy', caller: 'ci-bot', action: 'deny' }],
    });
    expect(evaluateCall(policy, { tool: 'deploy', arguments: {} }).action).toBe('allow');
  });
});

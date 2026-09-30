import { describe, expect, it } from 'vitest';

import {
  MAX_MATCH_INPUT_LENGTH,
  MAX_PATTERN_LENGTH,
  PolicyError,
  compilePathMatchers,
  getPath,
  globToRegex,
  matcherMatches,
  type Matcher,
} from '../src/policy/matchers.js';

function compile(spec: Record<string, unknown>, label = 'policy.rules[0].args.path'): Matcher[] {
  return compilePathMatchers(spec, label);
}

function matchOne(spec: Record<string, unknown>, value: unknown): boolean {
  const matchers = compile(spec);
  return matchers.every((matcher) => matcherMatches(matcher, value));
}

describe('tool glob patterns', () => {
  it('matches exact names', () => {
    expect(globToRegex('write_file').test('write_file')).toBe(true);
    expect(globToRegex('write_file').test('write_files')).toBe(false);
  });

  it('matches * and ? wildcards', () => {
    const pattern = globToRegex('fs/delete_*');
    expect(pattern.test('fs/delete_all')).toBe(true);
    expect(pattern.test('fs/delete')).toBe(false);
    expect(pattern.test('fs/read_file')).toBe(false);

    const single = globToRegex('read_?ile');
    expect(single.test('read_file')).toBe(true);
    expect(single.test('read_ffile')).toBe(false);
  });

  it('is anchored and treats regex metacharacters literally', () => {
    expect(globToRegex('a.b').test('a.b')).toBe(true);
    expect(globToRegex('a.b').test('axb')).toBe(false);
    expect(globToRegex('a+b').test('a+b')).toBe(true);
    expect(globToRegex('tool').test('prefix-tool-suffix')).toBe(false);
  });
});

describe('argument matchers', () => {
  it('equals compares deeply', () => {
    expect(matchOne({ equals: { a: [1, 2], b: 'x' } }, { a: [1, 2], b: 'x' })).toBe(true);
    expect(matchOne({ equals: { a: [1, 2] } }, { a: [2, 1] })).toBe(false);
    expect(matchOne({ equals: 3 }, 3)).toBe(true);
  });

  it('in matches any listed value deeply', () => {
    expect(matchOne({ in: ['GET', 'HEAD'] }, 'GET')).toBe(true);
    expect(matchOne({ in: ['GET', 'HEAD'] }, 'POST')).toBe(false);
    expect(matchOne({ in: [{ level: 1 }] }, { level: 1 })).toBe(true);
  });

  it('prefix requires a string that starts with the value', () => {
    expect(matchOne({ prefix: '/projects' }, '/projects/a.txt')).toBe(true);
    expect(matchOne({ prefix: '/projects' }, '/etc/passwd')).toBe(false);
    expect(matchOne({ prefix: '/projects' }, 42)).toBe(false);
  });

  it('regex tests strings with a bounded pattern', () => {
    expect(matchOne({ regex: '^https://api\\.' }, 'https://api.example.com')).toBe(true);
    expect(matchOne({ regex: '^https://api\\.' }, 'http://api.example.com')).toBe(false);
    expect(matchOne({ regex: '^a' }, 12)).toBe(false);
  });

  it('max_length bounds strings and arrays', () => {
    expect(matchOne({ max_length: 4 }, 'abcd')).toBe(true);
    expect(matchOne({ max_length: 4 }, 'abcde')).toBe(false);
    expect(matchOne({ max_length: 2 }, [1, 2])).toBe(true);
    expect(matchOne({ max_length: 2 }, [1, 2, 3])).toBe(false);
    expect(matchOne({ max_length: 2 }, 12)).toBe(false);
  });

  it('min and max bound numbers', () => {
    expect(matchOne({ min: 1, max: 30 }, 30)).toBe(true);
    expect(matchOne({ min: 1, max: 30 }, 0)).toBe(false);
    expect(matchOne({ min: 1, max: 30 }, 31)).toBe(false);
    expect(matchOne({ min: 1 }, '5')).toBe(false);
  });

  it('ANDs multiple matchers on the same path', () => {
    expect(matchOne({ prefix: '/projects', max_length: 10 }, '/projects')).toBe(true);
    expect(matchOne({ prefix: '/projects', max_length: 10 }, '/projects/abcdef')).toBe(false);
  });
});

describe('dot-path access', () => {
  it('walks nested objects and array indexes', () => {
    const root = { config: { timeout: 5 }, items: [{ name: 'a' }] };
    expect(getPath(root, 'config.timeout')).toEqual({ found: true, value: 5 });
    expect(getPath(root, 'items.0.name')).toEqual({ found: true, value: 'a' });
  });

  it('reports missing paths without throwing', () => {
    expect(getPath({ a: 1 }, 'b').found).toBe(false);
    expect(getPath({ a: 1 }, 'a.b').found).toBe(false);
    expect(getPath(undefined, 'a').found).toBe(false);
    expect(getPath({ items: [] }, 'items.3').found).toBe(false);
  });
});

describe('policy hygiene (FR-Y6)', () => {
  it('rejects nested-quantifier patterns with the rule path', () => {
    expect(() => compile({ regex: '(a+)+$' })).toThrowError(PolicyError);
    expect(() => compile({ regex: '(a+)+$' })).toThrowError(/policy\.rules\[0\]\.args\.path/);
    expect(() => compile({ regex: '(a*)*' })).toThrowError(/nested quantifier/i);
  });

  it('rejects ambiguous quantified alternations', () => {
    expect(() => compile({ regex: '(a|a)+$' })).toThrowError(/alternation/i);
  });

  it('accepts safe patterns', () => {
    expect(() => compile({ regex: '^(GET|HEAD)$' })).not.toThrow();
    expect(() => compile({ regex: '^/projects/[a-z0-9/._-]+$' })).not.toThrow();
  });

  it('rejects oversized patterns', () => {
    const long = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
    expect(() => compile({ regex: long })).toThrowError(/policy\.rules\[0\]\.args\.path/);
  });

  it('rejects invalid regex syntax with the rule path', () => {
    expect(() => compile({ regex: '(' })).toThrowError(/policy\.rules\[0\]\.args\.path/);
  });

  it('caps the matched input length', () => {
    const long = `/projects/${'a'.repeat(MAX_MATCH_INPUT_LENGTH)}`;
    expect(matchOne({ prefix: '/projects' }, long)).toBe(false);
    expect(matchOne({ regex: '^/projects' }, long)).toBe(false);
  });
});

describe('matcher shape validation', () => {
  it('rejects unknown matchers, wrong types, and empty specs with path and field', () => {
    expect(() => compile({ bogus: 1 })).toThrowError(/policy\.rules\[0\]\.args\.path\.bogus/);
    expect(() => compile({ prefix: 5 })).toThrowError(/policy\.rules\[0\]\.args\.path\.prefix/);
    expect(() => compile({ in: [] })).toThrowError(/policy\.rules\[0\]\.args\.path\.in/);
    expect(() => compile({ min: 'x' })).toThrowError(/policy\.rules\[0\]\.args\.path\.min/);
    expect(() => compile({})).toThrowError(/policy\.rules\[0\]\.args\.path/);
    expect(() => compilePathMatchers('nope', 'policy.rules[0].args.path')).toThrowError(
      /policy\.rules\[0\]\.args\.path/,
    );
  });
});

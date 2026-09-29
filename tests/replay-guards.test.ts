import { describe, expect, it } from 'vitest';

import { applyOverrides, containsRedactedMarkers, dedupVerdict } from '../src/replay/guards.js';
import { extractIdempotencyKey } from '../src/pipeline/idempotency.js';
import type { ExecutionRecord } from '../src/queue/failure-record.js';

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    key: 'key-1',
    toolName: 'create_issue',
    argumentsHash: 'h'.repeat(64),
    executedAt: '2026-09-29T10:00:00.000Z',
    source: 'live',
    ...overrides,
  };
}

describe('idempotency key extraction', () => {
  it('reads _meta.idempotencyKey first', () => {
    expect(extractIdempotencyKey({ _meta: { idempotencyKey: 'abc' }, arguments: {} })).toBe('abc');
    expect(extractIdempotencyKey({ _meta: { idempotencyKey: 42 }, arguments: {} })).toBe('42');
  });

  it('falls back to argument fields', () => {
    expect(extractIdempotencyKey({ arguments: { idempotency_key: 'k1' } })).toBe('k1');
    expect(extractIdempotencyKey({ arguments: { idempotencyKey: 'k2' } })).toBe('k2');
  });

  it('returns undefined when no key exists', () => {
    expect(extractIdempotencyKey({ arguments: { path: '/a' } })).toBeUndefined();
  });
});

describe('redacted markers', () => {
  it('finds markers at any depth', () => {
    expect(containsRedactedMarkers({ a: '[REDACTED]' })).toBe(true);
    expect(containsRedactedMarkers({ a: { b: ['x', '[REDACTED]'] } })).toBe(true);
    expect(containsRedactedMarkers({ a: 'safe' })).toBe(false);
  });
});

describe('overrides', () => {
  it('replaces only the named top-level keys', () => {
    const args = { api_key: '[REDACTED]', safe: 'keep', nested: { token: '[REDACTED]' } };
    const result = applyOverrides(args, { api_key: 'real-secret' }) as Record<string, unknown>;
    expect(result.api_key).toBe('real-secret');
    expect(result.safe).toBe('keep');
    expect((result.nested as Record<string, unknown>).token).toBe('[REDACTED]');
  });
});

describe('dedup verdict', () => {
  const now = new Date('2026-09-29T12:00:00.000Z');

  it('flags a duplicate key within the window', () => {
    const verdict = dedupVerdict({
      key: 'key-1',
      argumentsHash: 'h'.repeat(64),
      windowMs: 24 * 60 * 60 * 1000,
      now,
      lastByKey: execution(),
      lastByHash: null,
    });
    expect(verdict.duplicate).toBe(true);
    expect(verdict.matchedBy).toBe('key');
    expect(verdict.previous?.key).toBe('key-1');
  });

  it('does not flag outside the window', () => {
    const verdict = dedupVerdict({
      key: 'key-1',
      argumentsHash: 'h'.repeat(64),
      windowMs: 60 * 60 * 1000,
      now,
      lastByKey: execution(),
      lastByHash: null,
    });
    expect(verdict.duplicate).toBe(false);
  });

  it('falls back to the arguments hash without a key', () => {
    const verdict = dedupVerdict({
      argumentsHash: 'h'.repeat(64),
      windowMs: 24 * 60 * 60 * 1000,
      now,
      lastByKey: null,
      lastByHash: execution({ key: 'other' }),
    });
    expect(verdict.duplicate).toBe(true);
    expect(verdict.matchedBy).toBe('hash');
  });

  it('reports no duplicate when nothing matches', () => {
    const verdict = dedupVerdict({
      argumentsHash: 'h'.repeat(64),
      windowMs: 24 * 60 * 60 * 1000,
      now,
      lastByKey: null,
      lastByHash: null,
    });
    expect(verdict).toEqual({ duplicate: false, matchedBy: null });
  });
});

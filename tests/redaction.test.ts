import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REDACTION_PATTERNS,
  REDACTED,
  canonicalJson,
  hashArguments,
  redactMessage,
  redactValue,
} from '../src/redaction/redact.js';
import { failureClassFromD4, newFailureRecordId } from '../src/queue/failure-record.js';

describe('redactValue', () => {
  it('redacts the default sensitive keys at the top level', () => {
    const redacted = redactValue(
      {
        api_key: 'sk-123',
        token: 'tok',
        password: 'pw',
        authorization: 'Bearer x',
        secret: 's',
        credential: 'c',
        safe: 'keep',
      },
      DEFAULT_REDACTION_PATTERNS,
    ) as Record<string, unknown>;

    for (const key of ['api_key', 'token', 'password', 'authorization', 'secret', 'credential']) {
      expect(redacted[key]).toBe(REDACTED);
    }
    expect(redacted.safe).toBe('keep');
  });

  it('redacts nested keys and array elements', () => {
    const redacted = redactValue(
      {
        outer: { inner: { api_key: 'sk-1' } },
        list: [{ token: 't1' }, { safe: 'ok' }],
      },
      DEFAULT_REDACTION_PATTERNS,
    ) as { outer: { inner: { api_key: string } }; list: Array<Record<string, unknown>> };

    expect(redacted.outer.inner.api_key).toBe(REDACTED);
    expect(redacted.list[0]?.token).toBe(REDACTED);
    expect(redacted.list[1]?.safe).toBe('ok');
  });

  it('supports custom patterns case-insensitively', () => {
    const redacted = redactValue({ MY_CUSTOM_KEY: 'x', other: 'y' }, ['custom_key']) as Record<
      string,
      unknown
    >;
    expect(redacted.MY_CUSTOM_KEY).toBe(REDACTED);
    expect(redacted.other).toBe('y');
  });

  it('survives cycles without hanging', () => {
    const value: Record<string, unknown> = { safe: 'ok' };
    value.self = value;
    const redacted = redactValue(value, DEFAULT_REDACTION_PATTERNS) as Record<string, unknown>;
    expect(redacted.safe).toBe('ok');
  });
});

describe('redactMessage', () => {
  it('masks key=value and key: value secrets', () => {
    expect(
      redactMessage('failed with token=abc123 and api_key: xyz', DEFAULT_REDACTION_PATTERNS),
    ).toBe(`failed with token=${REDACTED} and api_key=${REDACTED}`);
  });

  it('leaves messages without secrets untouched', () => {
    expect(redactMessage('upstream tool failure', DEFAULT_REDACTION_PATTERNS)).toBe(
      'upstream tool failure',
    );
  });
});

describe('canonical hash', () => {
  it('canonicalizes key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('hashes equal arguments equally regardless of key order', () => {
    expect(hashArguments({ a: 1, b: { d: 2, c: 3 } })).toBe(
      hashArguments({ b: { c: 3, d: 2 }, a: 1 }),
    );
  });

  it('produces a 64-char hex digest that differs for different arguments', () => {
    const hash = hashArguments({ path: '/a' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(hashArguments({ path: '/b' }));
  });
});

describe('failure record helpers', () => {
  it('generates sortable unique ULIDs', () => {
    const first = newFailureRecordId();
    const second = newFailureRecordId();
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first < second).toBe(true);
    expect(first).not.toBe(second);
  });

  it('maps D4 classes to record classes', () => {
    expect(failureClassFromD4('transport_pre_execution')).toBe('transport');
    expect(failureClassFromD4('transport_post_execution')).toBe('transport');
    expect(failureClassFromD4('timeout')).toBe('timeout');
    expect(failureClassFromD4('upstream_error')).toBe('upstream_error');
    expect(failureClassFromD4('non_retryable')).toBe('non_retryable');
    expect(failureClassFromD4('tool_error')).toBe('tool_error');
    expect(failureClassFromD4('ok')).toBeUndefined();
    expect(failureClassFromD4('cancelled')).toBeUndefined();
    expect(failureClassFromD4('input_required')).toBeUndefined();
  });
});

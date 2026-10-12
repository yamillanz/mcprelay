import { describe, expect, it } from 'vitest';

import {
  resolveIdentity,
  stripCredentialFields,
  type IdentitySettings,
} from '../src/identity/identity.js';

function settings(overrides: Partial<IdentitySettings> = {}): IdentitySettings {
  return {
    profile: 'reviewer-bot',
    keys: [{ key: 'sk-agent-a', identity: 'agent-a' }],
    ...overrides,
  };
}

describe('resolveIdentity', () => {
  it('falls back to the profile without a credential', () => {
    expect(resolveIdentity(settings(), {})).toEqual({ ok: true, identity: 'reviewer-bot' });
    expect(resolveIdentity(settings(), undefined)).toEqual({ ok: true, identity: 'reviewer-bot' });
  });

  it('maps a presented bearer key to its identity', () => {
    const meta = { authorization: 'Bearer sk-agent-a' };
    expect(resolveIdentity(settings(), meta)).toEqual({ ok: true, identity: 'agent-a' });
  });

  it('parses the scheme case-insensitively and trims whitespace', () => {
    const meta = { authorization: 'bearer  sk-agent-a ' };
    expect(resolveIdentity(settings(), meta)).toEqual({ ok: true, identity: 'agent-a' });
  });

  it('rejects an unknown key when a key store is configured', () => {
    const meta = { authorization: 'Bearer sk-unknown' };
    expect(resolveIdentity(settings(), meta)).toEqual({
      ok: false,
      reason: 'unrecognized api key',
    });
  });

  it('ignores non-bearer credentials when a key store is configured', () => {
    const meta = { authorization: 'Basic dXNlcjpwYXNz' };
    expect(resolveIdentity(settings(), meta)).toEqual({ ok: true, identity: 'reviewer-bot' });
  });

  it('does not reject when the key store is empty', () => {
    const meta = { authorization: 'Bearer anything' };
    expect(resolveIdentity(settings({ keys: [] }), meta)).toEqual({
      ok: true,
      identity: 'reviewer-bot',
    });
  });

  it('ignores non-string authorization values', () => {
    expect(resolveIdentity(settings(), { authorization: 42 })).toEqual({
      ok: true,
      identity: 'reviewer-bot',
    });
  });
});

describe('stripCredentialFields', () => {
  it('removes the credential field case-insensitively', () => {
    const meta = { authorization: 'Bearer sk-agent-a', Authorization: 'Bearer sk-agent-a' };
    expect(stripCredentialFields(meta)).toEqual({});
  });

  it('preserves every other meta key', () => {
    const meta = {
      authorization: 'Bearer sk-agent-a',
      progressToken: 'tok-1',
      traceparent: '00-abc-def-01',
      mcprelay: { correlation_id: 'corr-1' },
    };
    expect(stripCredentialFields(meta)).toEqual({
      progressToken: 'tok-1',
      traceparent: '00-abc-def-01',
      mcprelay: { correlation_id: 'corr-1' },
    });
  });

  it('returns a copy without mutating the input', () => {
    const meta = { authorization: 'Bearer sk-agent-a', keep: true };
    const stripped = stripCredentialFields(meta);
    expect(meta.authorization).toBe('Bearer sk-agent-a');
    expect(stripped).not.toBe(meta);
  });
});

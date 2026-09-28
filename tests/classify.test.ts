import { describe, expect, it } from 'vitest';
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

import { classifyAttempt, type AttemptOutcome } from '../src/pipeline/classify.js';

const idempotent = { idempotent: true };
const notIdempotent = { idempotent: false };

function errorOutcome(
  error: unknown,
  phase: 'pre_send' | 'post_send' | 'timeout' | 'cancelled',
): AttemptOutcome {
  return { kind: 'error', error, phase };
}

describe('D4 classifier — results', () => {
  it('classifies a plain result as ok', () => {
    expect(classifyAttempt({ kind: 'result', result: { content: [] } }, notIdempotent)).toEqual({
      class: 'ok',
      retry: false,
    });
  });

  it('classifies isError results as tool_error, never retried', () => {
    expect(
      classifyAttempt({ kind: 'result', result: { content: [], isError: true } }, idempotent),
    ).toEqual({ class: 'tool_error', retry: false });
  });

  it('classifies input_required as not-a-failure, never retried', () => {
    expect(
      classifyAttempt({ kind: 'result', result: { resultType: 'input_required' } }, idempotent),
    ).toEqual({ class: 'input_required', retry: false });
  });
});

describe('D4 classifier — transport failures', () => {
  it('retries pre-send transport failures unconditionally', () => {
    expect(
      classifyAttempt(errorOutcome(new Error('spawn failed'), 'pre_send'), notIdempotent),
    ).toEqual({ class: 'transport_pre_execution', retry: true });
  });

  it('gates post-send connection loss on idempotency (ambiguous mid-call crash)', () => {
    const closed = new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed');
    expect(classifyAttempt(errorOutcome(closed, 'post_send'), idempotent)).toEqual({
      class: 'transport_post_execution',
      retry: true,
    });
    expect(classifyAttempt(errorOutcome(closed, 'post_send'), notIdempotent)).toEqual({
      class: 'transport_post_execution',
      retry: false,
    });
  });

  it('treats not-connected and send-failed errors as pre-execution', () => {
    const notConnected = new SdkError(SdkErrorCode.NotConnected, 'Transport is not connected');
    const sendFailed = new SdkError(SdkErrorCode.SendFailed, 'Failed to send message');
    expect(classifyAttempt(errorOutcome(notConnected, 'post_send'), notIdempotent).class).toBe(
      'transport_pre_execution',
    );
    expect(classifyAttempt(errorOutcome(sendFailed, 'post_send'), notIdempotent).class).toBe(
      'transport_pre_execution',
    );
  });
});

describe('D4 classifier — timeout', () => {
  it('retries timeouts only for idempotent tools', () => {
    const timeout = new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out');
    expect(classifyAttempt(errorOutcome(timeout, 'timeout'), idempotent)).toEqual({
      class: 'timeout',
      retry: true,
    });
    expect(classifyAttempt(errorOutcome(timeout, 'timeout'), notIdempotent)).toEqual({
      class: 'timeout',
      retry: false,
    });
  });
});

describe('D4 classifier — upstream error responses', () => {
  it('never retries structural protocol errors, even for idempotent tools', () => {
    for (const code of [-32700, -32600, -32601, -32602]) {
      expect(
        classifyAttempt(errorOutcome(new ProtocolError(code, 'bad'), 'post_send'), idempotent),
      ).toEqual({ class: 'non_retryable', retry: false });
    }
  });

  it('gates transient server errors on idempotency', () => {
    for (const code of [-32603, -32000, -32099]) {
      expect(
        classifyAttempt(
          errorOutcome(new ProtocolError(code, 'server error'), 'post_send'),
          idempotent,
        ),
      ).toEqual({ class: 'upstream_error', retry: true });
      expect(
        classifyAttempt(
          errorOutcome(new ProtocolError(code, 'server error'), 'post_send'),
          notIdempotent,
        ),
      ).toEqual({ class: 'upstream_error', retry: false });
    }
  });
});

describe('D4 classifier — cancellation and unknown errors', () => {
  it('classifies cancellation as terminal, never retried', () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(classifyAttempt(errorOutcome(abort, 'cancelled'), idempotent)).toEqual({
      class: 'cancelled',
      retry: false,
    });
  });

  it('classifies unknown errors as non-retryable', () => {
    expect(
      classifyAttempt(
        errorOutcome(new SdkError(SdkErrorCode.CapabilityNotSupported, 'nope'), 'post_send'),
        idempotent,
      ),
    ).toEqual({ class: 'non_retryable', retry: false });
    expect(classifyAttempt(errorOutcome(new Error('weird'), 'post_send'), idempotent)).toEqual({
      class: 'non_retryable',
      retry: false,
    });
  });
});

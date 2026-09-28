import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

/** D4 failure classes (design D2, ADR-0003). */
export type FailureClass =
  | 'ok'
  | 'transport_pre_execution'
  | 'transport_post_execution'
  | 'timeout'
  | 'upstream_error'
  | 'non_retryable'
  | 'tool_error'
  | 'input_required'
  | 'cancelled';

/** Where an attempt failed; the attempt wrapper decides this from the error. */
export type FailurePhase = 'pre_send' | 'post_send' | 'timeout' | 'cancelled';

export type AttemptOutcome =
  { kind: 'result'; result: unknown } | { kind: 'error'; error: unknown; phase: FailurePhase };

export interface ClassifiedAttempt {
  class: FailureClass;
  retry: boolean;
}

export interface ClassificationPolicy {
  idempotent: boolean;
}

/** Structural JSON-RPC errors where a retry cannot help. */
const NON_RETRYABLE_PROTOCOL_CODES = new Set([-32700, -32600, -32601, -32602]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function numericErrorCode(error: unknown): number | undefined {
  if (error instanceof ProtocolError) return error.code;
  if (isRecord(error) && typeof error.code === 'number') return error.code;
  return undefined;
}

function sdkErrorCode(error: unknown): SdkErrorCode | undefined {
  return error instanceof SdkError ? error.code : undefined;
}

/**
 * Classifies one attempt per the D4 taxonomy and decides whether it may be
 * retried. Pure function: the attempt wrapper owns phase detection.
 */
export function classifyAttempt(
  outcome: AttemptOutcome,
  policy: ClassificationPolicy,
): ClassifiedAttempt {
  if (outcome.kind === 'result') {
    const result = outcome.result;
    if (isRecord(result) && result.isError === true) return { class: 'tool_error', retry: false };
    if (isRecord(result) && result.resultType === 'input_required') {
      return { class: 'input_required', retry: false };
    }
    return { class: 'ok', retry: false };
  }

  if (outcome.phase === 'cancelled') return { class: 'cancelled', retry: false };
  if (outcome.phase === 'timeout') return { class: 'timeout', retry: policy.idempotent };
  if (outcome.phase === 'pre_send') {
    return { class: 'transport_pre_execution', retry: true };
  }

  const code = numericErrorCode(outcome.error);
  if (code !== undefined) {
    return NON_RETRYABLE_PROTOCOL_CODES.has(code)
      ? { class: 'non_retryable', retry: false }
      : { class: 'upstream_error', retry: policy.idempotent };
  }

  const sdkCode = sdkErrorCode(outcome.error);
  if (sdkCode === SdkErrorCode.NotConnected || sdkCode === SdkErrorCode.SendFailed) {
    return { class: 'transport_pre_execution', retry: true };
  }
  if (sdkCode === SdkErrorCode.ConnectionClosed) {
    // Ambiguous mid-call crash: it may have executed; conservative gate.
    return { class: 'transport_post_execution', retry: policy.idempotent };
  }

  return { class: 'non_retryable', retry: false };
}

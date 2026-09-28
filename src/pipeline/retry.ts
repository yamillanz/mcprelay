import type { AttemptOutcome, ClassifiedAttempt } from './classify.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  jitter: boolean;
}

export interface RunWithRetryOptions {
  attempt(attemptNumber: number): Promise<AttemptOutcome>;
  classify(outcome: AttemptOutcome): ClassifiedAttempt;
  policy: RetryPolicy;
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

export interface RetryResult {
  attempts: number;
  outcome: AttemptOutcome;
  classification: ClassifiedAttempt;
}

/** Backoff ceiling; documented in ADR-0003. */
export const BACKOFF_CAP_MS = 30000;

/** Delay before the next attempt after `failedAttempt` (1-based). */
export function backoffDelayMs(
  policy: Pick<RetryPolicy, 'baseMs' | 'jitter'>,
  failedAttempt: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.baseMs * 2 ** (failedAttempt - 1), BACKOFF_CAP_MS);
  if (!policy.jitter) return exponential;
  return Math.floor(random() * (exponential + 1));
}

/**
 * Runs one logical call attempt-by-attempt, stopping when the classification
 * says stop, the call is cancelled, or the attempt bound is reached.
 */
export async function runWithRetry(options: RunWithRetryOptions): Promise<RetryResult> {
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = options.random ?? Math.random;

  let attempts = 0;
  let outcome: AttemptOutcome | undefined;
  let classification: ClassifiedAttempt | undefined;

  while (attempts < options.policy.maxAttempts) {
    attempts += 1;
    outcome = await options.attempt(attempts);
    classification = options.classify(outcome);

    if (!classification.retry) break;
    if (attempts >= options.policy.maxAttempts) break;
    await sleep(backoffDelayMs(options.policy, attempts, random));
  }

  return {
    attempts,
    outcome: outcome as AttemptOutcome,
    classification: classification as ClassifiedAttempt,
  };
}

import type { ExecutionRecord } from '../queue/failure-record.js';
import { REDACTED } from '../redaction/redact.js';

/** True when any value in the graph is a redaction marker. */
export function containsRedactedMarkers(value: unknown): boolean {
  if (value === REDACTED) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => containsRedactedMarkers(entry));
  return Object.values(value as Record<string, unknown>).some((entry) =>
    containsRedactedMarkers(entry),
  );
}

/** Replaces only the named top-level keys. */
export function applyOverrides(
  args: Record<string, unknown>,
  overrides: Record<string, string>,
): Record<string, unknown> {
  return { ...args, ...overrides };
}

export interface DedupVerdict {
  duplicate: boolean;
  matchedBy: 'key' | 'hash' | null;
  previous?: ExecutionRecord;
}

/** Decides whether a previous successful execution blocks this replay. */
export function dedupVerdict(options: {
  key?: string;
  argumentsHash: string;
  windowMs: number;
  now: Date;
  lastByKey: ExecutionRecord | null;
  lastByHash: ExecutionRecord | null;
}): DedupVerdict {
  const withinWindow = (execution: ExecutionRecord | null): execution is ExecutionRecord => {
    if (execution === null) return false;
    const executedAt = Date.parse(execution.executedAt);
    return Number.isFinite(executedAt) && options.now.getTime() - executedAt <= options.windowMs;
  };

  if (options.key !== undefined && withinWindow(options.lastByKey)) {
    return { duplicate: true, matchedBy: 'key', previous: options.lastByKey };
  }
  if (options.key === undefined && withinWindow(options.lastByHash)) {
    return { duplicate: true, matchedBy: 'hash', previous: options.lastByHash };
  }
  return { duplicate: false, matchedBy: null };
}

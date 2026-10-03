import { monotonicFactory } from 'ulid';

import type { FailureClass } from '../pipeline/classify.js';

/** Replay lifecycle of a captured record (Appendix A). */
export type ReplayStatus = 'pending' | 'replayed' | 'discarded';

/** Upstream transport a record was captured against. */
export type ServerTransport = 'stdio' | 'http';

/** Persisted failure classes (Appendix A; mapped from the D4 taxonomy). */
export type RecordFailureClass =
  'transport' | 'timeout' | 'upstream_error' | 'non_retryable' | 'tool_error';

export interface FailureRecord {
  id: string;
  correlation_id: string;
  captured_at: string;
  caller: { type: 'stdio' | 'http'; identity: string };
  server: { name: string; command: string; transport: ServerTransport };
  tool: { name: string; arguments_hash: string; arguments: unknown };
  failure: { class: RecordFailureClass; message: string; attempts: number };
  replay: { status: ReplayStatus; attempts: unknown[]; last_outcome: unknown | null };
}

export interface FailureFilter {
  status?: ReplayStatus;
  tool?: string;
  correlationId?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ReplayOutcome {
  status: Extract<ReplayStatus, 'replayed' | 'discarded'>;
  attempts?: unknown[];
  lastOutcome?: unknown;
}

export interface HealthStatus {
  ok: boolean;
  provider: string;
  path?: string;
}

const monotonicUlid = monotonicFactory();

/** Monotonic ULID: unique and lexicographically increasing within a millisecond. */
export function newFailureRecordId(): string {
  return monotonicUlid();
}

/** Maps a D4 classification to the persisted class; undefined = never captured. */
export function failureClassFromD4(d4: FailureClass): RecordFailureClass | undefined {
  switch (d4) {
    case 'transport_pre_execution':
    case 'transport_post_execution':
      return 'transport';
    case 'timeout':
      return 'timeout';
    case 'upstream_error':
      return 'upstream_error';
    case 'non_retryable':
      return 'non_retryable';
    case 'tool_error':
      return 'tool_error';
    default:
      return undefined;
  }
}

/** Idempotency index entry: one successful execution per key (latest wins). */
export interface ExecutionEntry {
  key: string;
  toolName: string;
  argumentsHash: string;
  executedAt: string;
  source: 'live' | 'replay';
}

export type ExecutionRecord = ExecutionEntry;

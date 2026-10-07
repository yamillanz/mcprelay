import type {
  ExecutionEntry,
  ExecutionRecord,
  FailureFilter,
  FailureRecord,
  HealthStatus,
  ReplayOutcome,
} from './failure-record.js';

export class AlreadyResolvedError extends Error {
  constructor(id: string) {
    super(`failure record '${id}' is not pending (already resolved)`);
    this.name = 'AlreadyResolvedError';
  }
}

export class RecordNotFoundError extends Error {
  constructor(id: string) {
    super(`failure record '${id}' not found`);
    this.name = 'RecordNotFoundError';
  }
}

export class AlreadyClaimedError extends Error {
  constructor(id: string) {
    super(`failure record '${id}' is already claimed by another replay`);
    this.name = 'AlreadyClaimedError';
  }
}

/** Idempotency index over the queue database (used by replay dedup). */
export interface IdempotencyIndex {
  recordExecution(entry: ExecutionEntry): Promise<void>;
  lastExecution(key: string): Promise<ExecutionRecord | null>;
  lastExecutionByHash(argumentsHash: string): Promise<ExecutionRecord | null>;
}

/** DLQ + replay substrate (PRD §6.2). */
export interface QueueProvider {
  enqueue(record: FailureRecord): Promise<string>;
  list(filter?: FailureFilter): Promise<FailureRecord[]>;
  get(id: string): Promise<FailureRecord | null>;
  resolve(id: string, outcome: ReplayOutcome): Promise<void>;
  claim(id: string, leaseMs: number): Promise<void>;
  release(id: string): Promise<void>;
  purge(filter?: FailureFilter): Promise<number>;
  health(): Promise<HealthStatus>;
}

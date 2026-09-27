export type CallDecision = 'allowed' | 'denied' | 'failed' | 'cancelled';

export interface CallLogEntry {
  timestamp: string;
  correlation_id: string;
  trace?: {
    traceparent?: string;
    tracestate?: string;
    baggage?: string;
  };
  caller: { type: 'stdio'; identity: string };
  server: string;
  tool: string;
  decision: CallDecision;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
  attempt: number;
  error?: { message: string; code?: number };
}

/** Writes one structured JSON line per intercepted call (FR-O1) to the sink. */
export class CallLogger {
  constructor(private readonly sink: (line: string) => void) {}

  log(entry: CallLogEntry): void {
    this.sink(`${JSON.stringify(entry)}\n`);
  }
}

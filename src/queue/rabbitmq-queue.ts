import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';

import type {
  ExecutionEntry,
  ExecutionRecord,
  FailureFilter,
  FailureRecord,
  HealthStatus,
  ReplayOutcome,
} from './failure-record.js';
import type { IdempotencyIndex, QueueProvider } from './port.js';
import { SqliteQueueProvider } from './sqlite-queue.js';

export const RABBIT_ROUTING_KEY = 'mcp.failure';

export interface RabbitMqQueueOptions {
  url: string;
  exchange: string;
  queue: string;
  mirrorPath: string;
  onWarning?: (message: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * RabbitMQ DLQ: the broker holds the durable, immutable capture (persistent
 * confirmed publish), while the local SQLite index at `mirrorPath` serves the
 * query half of the port (list/get/claim/resolve/purge/idempotency) with the
 * same semantics as the SQLite adapter.
 */
export class RabbitMqQueueProvider implements QueueProvider, IdempotencyIndex {
  private readonly index: SqliteQueueProvider;
  private readonly options: RabbitMqQueueOptions;
  private connection: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;

  constructor(options: RabbitMqQueueOptions) {
    this.options = options;
    this.index = new SqliteQueueProvider({ path: options.mirrorPath });
  }

  async enqueue(record: FailureRecord): Promise<string> {
    await this.index.enqueue(record);
    try {
      const channel = await this.ensureChannel();
      channel.publish(
        this.options.exchange,
        RABBIT_ROUTING_KEY,
        Buffer.from(JSON.stringify(record)),
        { persistent: true, contentType: 'application/json', messageId: record.id },
      );
      await channel.waitForConfirms();
    } catch (error) {
      this.warn(
        `rabbitmq publish failed for '${record.id}': ${errorMessage(error)}; record is replayable locally`,
      );
    }
    return record.id;
  }

  async list(filter: FailureFilter = {}): Promise<FailureRecord[]> {
    return this.index.list(filter);
  }

  async get(id: string): Promise<FailureRecord | null> {
    return this.index.get(id);
  }

  async resolve(id: string, outcome: ReplayOutcome): Promise<void> {
    return this.index.resolve(id, outcome);
  }

  async claim(id: string, leaseMs: number): Promise<void> {
    return this.index.claim(id, leaseMs);
  }

  async release(id: string): Promise<void> {
    return this.index.release(id);
  }

  async purge(filter: FailureFilter = {}): Promise<number> {
    return this.index.purge(filter);
  }

  async recordExecution(entry: ExecutionEntry): Promise<void> {
    return this.index.recordExecution(entry);
  }

  async lastExecution(key: string): Promise<ExecutionRecord | null> {
    return this.index.lastExecution(key);
  }

  async lastExecutionByHash(argumentsHash: string): Promise<ExecutionRecord | null> {
    return this.index.lastExecutionByHash(argumentsHash);
  }

  async health(): Promise<HealthStatus> {
    const indexHealth = await this.index.health();
    let brokerOk: boolean;
    try {
      const channel = await this.ensureChannel();
      await channel.checkQueue(this.options.queue);
      brokerOk = true;
    } catch {
      brokerOk = false;
    }
    return { ok: brokerOk && indexHealth.ok, provider: 'rabbitmq', queue: this.options.queue };
  }

  async close(): Promise<void> {
    this.index.close();
    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    if (channel !== undefined) await channel.close().catch(() => {});
    if (connection !== undefined) await connection.close().catch(() => {});
  }

  private async ensureChannel(): Promise<ConfirmChannel> {
    if (this.channel !== undefined) return this.channel;
    const connection = await connect(this.options.url, { timeout: 5000 });
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(this.options.exchange, 'direct', { durable: true });
    await channel.assertQueue(this.options.queue, { durable: true });
    await channel.bindQueue(this.options.queue, this.options.exchange, RABBIT_ROUTING_KEY);
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.channel = undefined;
      }
    });
    connection.on('error', () => {});
    channel.on('close', () => {
      if (this.channel === channel) this.channel = undefined;
    });
    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  private warn(message: string): void {
    if (this.options.onWarning !== undefined) this.options.onWarning(message);
    else process.stderr.write(`mcprelay: warning: ${message}\n`);
  }
}

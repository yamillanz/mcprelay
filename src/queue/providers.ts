import type { McprelayConfig } from '../config/config.js';
import { SqliteStore, type Store } from '../store/sqlite-store.js';
import type { IdempotencyIndex, QueueProvider } from './port.js';
import { RabbitMqQueueProvider } from './rabbitmq-queue.js';
import { SqliteQueueProvider } from './sqlite-queue.js';

type QueueAdapter = QueueProvider &
  IdempotencyIndex & {
    close(): void | Promise<void>;
  };

export interface Persistence {
  getQueue(): QueueProvider & IdempotencyIndex;
  getStore(): Store;
  close(): Promise<void>;
}

/** Lazily opens the configured providers; no files are created until first use. */
export function createPersistence(config: McprelayConfig): Persistence {
  let queue: QueueAdapter | undefined;
  let store: SqliteStore | undefined;
  return {
    getQueue() {
      queue ??=
        config.queue.provider === 'rabbitmq'
          ? new RabbitMqQueueProvider({
              url: config.queue.rabbitmq.url,
              exchange: config.queue.rabbitmq.exchange,
              queue: config.queue.rabbitmq.queue,
              mirrorPath: config.queue.sqlite.path,
            })
          : new SqliteQueueProvider({ path: config.queue.sqlite.path });
      return queue;
    },
    getStore() {
      store ??= new SqliteStore({
        path: config.store.sqlite.path,
        retentionDays: config.store.retentionDays,
      });
      return store;
    },
    async close() {
      await queue?.close();
      store?.close();
    },
  };
}

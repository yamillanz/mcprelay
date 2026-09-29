import type { McprelayConfig } from '../config/config.js';
import { SqliteStore, type Store } from '../store/sqlite-store.js';
import { SqliteQueueProvider, type QueueProvider } from './sqlite-queue.js';

export interface Persistence {
  getQueue(): QueueProvider;
  getStore(): Store;
  close(): void;
}

/** Lazily opens the configured providers; no files are created until first use. */
export function createPersistence(config: McprelayConfig): Persistence {
  let queue: SqliteQueueProvider | undefined;
  let store: SqliteStore | undefined;
  return {
    getQueue() {
      queue ??= new SqliteQueueProvider({ path: config.queue.sqlite.path });
      return queue;
    },
    getStore() {
      store ??= new SqliteStore({ path: config.store.sqlite.path });
      return store;
    },
    close() {
      queue?.close();
      store?.close();
    },
  };
}

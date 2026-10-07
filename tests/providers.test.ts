import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultConfig, type McprelayConfig } from '../src/config/config.js';
import { createPersistence } from '../src/queue/providers.js';
import { RabbitMqQueueProvider } from '../src/queue/rabbitmq-queue.js';
import { SqliteQueueProvider } from '../src/queue/sqlite-queue.js';
import { SqliteStore } from '../src/store/sqlite-store.js';

function configWith(provider: 'sqlite' | 'rabbitmq'): McprelayConfig {
  const dir = mkdtempSync(join(tmpdir(), 'mcprelay-providers-'));
  const config = defaultConfig();
  config.queue.provider = provider;
  config.queue.sqlite.path = join(dir, 'queue.db');
  config.store.sqlite.path = join(dir, 'history.db');
  return config;
}

describe('createPersistence provider selection', () => {
  it('defaults to the SQLite adapter', async () => {
    const persistence = createPersistence(configWith('sqlite'));

    expect(persistence.getQueue()).toBeInstanceOf(SqliteQueueProvider);

    await persistence.close();
  });

  it('selects the RabbitMQ adapter without needing a broker at construction', async () => {
    const config = configWith('rabbitmq');
    config.queue.rabbitmq.url = 'amqp://127.0.0.1:1';
    const persistence = createPersistence(config);

    expect(persistence.getQueue()).toBeInstanceOf(RabbitMqQueueProvider);

    await persistence.close();
  });

  it('selects the store the same way', async () => {
    const persistence = createPersistence(configWith('sqlite'));

    expect(persistence.getStore()).toBeInstanceOf(SqliteStore);

    await persistence.close();
  });

  it('returns the same adapter instance on repeated calls', async () => {
    const persistence = createPersistence(configWith('sqlite'));

    expect(persistence.getQueue()).toBe(persistence.getQueue());

    await persistence.close();
  });
});

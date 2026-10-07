import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import amqp from 'amqplib';
import { afterEach, describe, expect, it } from 'vitest';

import { newFailureRecordId, type FailureRecord } from '../src/queue/failure-record.js';
import { RabbitMqQueueProvider } from '../src/queue/rabbitmq-queue.js';

const RABBIT_URL = process.env.MCPRELAY_RABBITMQ_URL;
const brokerDescribe = RABBIT_URL === undefined ? describe.skip : describe;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function uniqueName(): string {
  return `mcp.broker.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;
}

function makeAdapter(
  options: { url?: string; queueName?: string; onWarning?: (message: string) => void } = {},
): {
  provider: RabbitMqQueueProvider;
  queueName: string;
  exchange: string;
  mirrorPath: string;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'mcprelay-broker-'));
  const queueName = options.queueName ?? uniqueName();
  const exchange = `${queueName}.x`;
  const provider = new RabbitMqQueueProvider({
    url: options.url ?? RABBIT_URL ?? 'amqp://localhost',
    exchange,
    queue: queueName,
    mirrorPath: join(dir, 'queue.db'),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });
  cleanups.push(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
    if (RABBIT_URL === undefined) return;
    const connection = await amqp.connect(RABBIT_URL);
    try {
      const channel = await connection.createChannel();
      await channel.deleteQueue(queueName).catch(() => {});
      await channel.deleteExchange(exchange).catch(() => {});
      await channel.close();
    } finally {
      await connection.close();
    }
  });
  return { provider, queueName, exchange, mirrorPath: join(dir, 'queue.db'), dir };
}

function record(): FailureRecord {
  return {
    id: newFailureRecordId(),
    correlation_id: 'corr-broker',
    captured_at: new Date().toISOString(),
    caller: { type: 'stdio', identity: 'broker-test' },
    server: { name: 'echo', command: 'node echo.js', transport: 'stdio' },
    tool: { name: 'echo', arguments_hash: 'hash-1', arguments: { value: 1 } },
    failure: { class: 'timeout', message: 'timed out', attempts: 3 },
    replay: { status: 'pending', attempts: [], last_outcome: null },
  };
}

brokerDescribe('RabbitMQ adapter (real broker)', () => {
  it('publishes a persistent confirmed message for every capture', async () => {
    const { provider, queueName } = makeAdapter();
    const target = record();

    await provider.enqueue(target);

    const connection = await amqp.connect(RABBIT_URL as string);
    try {
      const channel = await connection.createChannel();
      const status = await channel.checkQueue(queueName);
      expect(status.messageCount).toBe(1);

      const message = await channel.get(queueName, { noAck: true });
      expect(message).not.toBe(false);
      if (message === false) return;
      expect(message.properties.deliveryMode).toBe(2);
      expect(JSON.parse(message.content.toString('utf8'))).toEqual(target);
      await channel.close();
    } finally {
      await connection.close();
    }
  });

  it('warns on broker publish failure and keeps the record replayable', async () => {
    const warnings: string[] = [];
    const { provider } = makeAdapter({
      url: 'amqp://127.0.0.1:1',
      onWarning: (message) => warnings.push(message),
    });
    const target = record();

    await expect(provider.enqueue(target)).resolves.toBe(target.id);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(target.id);
    expect((await provider.list()).map((entry) => entry.id)).toEqual([target.id]);
    expect((await provider.health()).ok).toBe(false);
  });

  it('reports health without echoing the URL or credentials', async () => {
    const { provider, queueName } = makeAdapter({
      url: (RABBIT_URL as string).replace('amqp://', 'amqp://guest:guest@'),
    });

    const health = await provider.health();

    expect(health.ok).toBe(true);
    expect(health.provider).toBe('rabbitmq');
    expect(health.queue).toBe(queueName);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain('amqp');
    expect(serialized).not.toContain('guest');
  });

  it('surfaces an unreachable broker through health and warnings', async () => {
    const warnings: string[] = [];
    const { provider } = makeAdapter({
      url: 'amqp://127.0.0.1:1',
      onWarning: (message) => warnings.push(message),
    });

    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.provider).toBe('rabbitmq');

    await provider.enqueue(record());
    expect(warnings[0]).toMatch(/publish failed/i);
  });
});

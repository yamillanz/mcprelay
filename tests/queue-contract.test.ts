import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import amqp from 'amqplib';
import { describe, expect, it } from 'vitest';

import { newFailureRecordId, type FailureRecord } from '../src/queue/failure-record.js';
import { RabbitMqQueueProvider } from '../src/queue/rabbitmq-queue.js';
import {
  AlreadyClaimedError,
  AlreadyResolvedError,
  RecordNotFoundError,
  type IdempotencyIndex,
  type QueueProvider,
} from '../src/queue/port.js';
import { SqliteQueueProvider } from '../src/queue/sqlite-queue.js';

const RABBIT_URL = process.env.MCPRELAY_RABBITMQ_URL;

type ContractQueue = QueueProvider & IdempotencyIndex;

interface OpenOptions {
  mirrorPath?: string;
  queueName?: string;
}

interface OpenQueue {
  queue: ContractQueue;
  close(): Promise<void>;
}

interface AdapterHarness {
  name: string;
  open(options?: OpenOptions): OpenQueue;
}

function uniqueName(): string {
  return `mcp.contract.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;
}

async function deleteBrokerObjects(exchange: string, queue: string): Promise<void> {
  if (RABBIT_URL === undefined) return;
  const connection = await amqp.connect(RABBIT_URL);
  try {
    const channel = await connection.createChannel();
    await channel.deleteQueue(queue).catch(() => {});
    await channel.deleteExchange(exchange).catch(() => {});
    await channel.close();
  } finally {
    await connection.close();
  }
}

function sqliteHarness(): AdapterHarness {
  return {
    name: 'sqlite',
    open(options = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'mcprelay-contract-'));
      const path = options.mirrorPath ?? join(dir, 'queue.db');
      const provider = new SqliteQueueProvider({ path });
      return {
        queue: provider,
        async close() {
          provider.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  };
}

function rabbitmqHarness(): AdapterHarness {
  return {
    name: 'rabbitmq',
    open(options = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'mcprelay-contract-'));
      const mirrorPath = options.mirrorPath ?? join(dir, 'queue.db');
      const queueName = options.queueName ?? uniqueName();
      const exchange = `${queueName}.x`;
      const provider = new RabbitMqQueueProvider({
        url: RABBIT_URL ?? 'amqp://localhost',
        exchange,
        queue: queueName,
        mirrorPath,
        onWarning: () => {},
      });
      return {
        queue: provider,
        async close() {
          await provider.close();
          rmSync(dir, { recursive: true, force: true });
          await deleteBrokerObjects(exchange, queueName);
        },
      };
    },
  };
}

function record(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    id: newFailureRecordId(),
    correlation_id: 'corr-1',
    captured_at: new Date().toISOString(),
    caller: { type: 'stdio', identity: 'contract-test' },
    server: { name: 'echo', command: 'node echo.js', transport: 'stdio' },
    tool: { name: 'echo', arguments_hash: 'hash-1', arguments: { value: 1 } },
    failure: { class: 'timeout', message: 'timed out', attempts: 3 },
    replay: { status: 'pending', attempts: [], last_outcome: null },
    ...overrides,
  };
}

function contractScenarios(harness: AdapterHarness): void {
  describe(`${harness.name} adapter contract`, () => {
    it('enqueue, get, and list with filters', async () => {
      const { queue, close } = harness.open();
      try {
        const older = record({
          correlation_id: 'c-older',
          tool: { name: 'alpha', arguments_hash: 'h-alpha', arguments: {} },
        });
        const newer = record({
          correlation_id: 'c-newer',
          tool: { name: 'beta', arguments_hash: 'h-beta', arguments: {} },
        });
        await queue.enqueue(older);
        await queue.enqueue(newer);

        expect(await queue.get(older.id)).toMatchObject({
          id: older.id,
          tool: { name: 'alpha' },
        });
        expect(await queue.get('01MISSING')).toBeNull();

        expect((await queue.list({ tool: 'alpha' })).map((entry) => entry.id)).toEqual([older.id]);
        expect((await queue.list({ correlationId: 'c-newer' })).map((entry) => entry.id)).toEqual([
          newer.id,
        ]);
        expect(await queue.list({ status: 'pending' })).toHaveLength(2);
        expect(await queue.list({ status: 'replayed' })).toEqual([]);
        expect(await queue.list({ since: '2999-01-01T00:00:00.000Z' })).toEqual([]);
        expect(await queue.list({ until: '2000-01-01T00:00:00.000Z' })).toEqual([]);
        expect(await queue.list({ limit: 1 })).toHaveLength(1);
      } finally {
        await close();
      }
    });

    it('resolve is atomic: exactly one caller wins', async () => {
      const { queue, close } = harness.open();
      try {
        const target = record();
        await queue.enqueue(target);
        const outcome = { status: 'replayed' as const, attempts: [], lastOutcome: { ok: true } };

        const results = await Promise.allSettled([
          queue.resolve(target.id, outcome),
          queue.resolve(target.id, outcome),
        ]);

        expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((entry) => entry.status === 'rejected');
        expect(rejected && (rejected as PromiseRejectedResult).reason).toBeInstanceOf(
          AlreadyResolvedError,
        );
        await expect(queue.resolve('01MISSING', outcome)).rejects.toBeInstanceOf(
          RecordNotFoundError,
        );
      } finally {
        await close();
      }
    });

    it('claim is atomic and release returns the record to pending', async () => {
      const { queue, close } = harness.open();
      try {
        const target = record();
        await queue.enqueue(target);

        const results = await Promise.allSettled([
          queue.claim(target.id, 60_000),
          queue.claim(target.id, 60_000),
        ]);
        expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((entry) => entry.status === 'rejected');
        expect(rejected && (rejected as PromiseRejectedResult).reason).toBeInstanceOf(
          AlreadyClaimedError,
        );

        await queue.release(target.id);
        await expect(queue.claim(target.id, 60_000)).resolves.toBeUndefined();
        await expect(queue.claim('01MISSING', 60_000)).rejects.toBeInstanceOf(RecordNotFoundError);
      } finally {
        await close();
      }
    });

    it('purge removes matching records', async () => {
      const { queue, close } = harness.open();
      try {
        const alpha = record({ tool: { name: 'alpha', arguments_hash: 'h1', arguments: {} } });
        const beta = record({ tool: { name: 'beta', arguments_hash: 'h2', arguments: {} } });
        await queue.enqueue(alpha);
        await queue.enqueue(beta);

        expect(await queue.purge({ tool: 'alpha' })).toBe(1);
        expect(await queue.get(alpha.id)).toBeNull();
        expect(await queue.list()).toHaveLength(1);
      } finally {
        await close();
      }
    });

    it('idempotency index round-trip', async () => {
      const { queue, close } = harness.open();
      try {
        const executedAt = new Date().toISOString();
        await queue.recordExecution({
          key: 'key-1',
          toolName: 'echo',
          argumentsHash: 'hash-1',
          executedAt,
          source: 'live',
        });

        expect(await queue.lastExecution('key-1')).toMatchObject({
          key: 'key-1',
          toolName: 'echo',
          argumentsHash: 'hash-1',
          executedAt,
        });
        expect(await queue.lastExecutionByHash('hash-1')).toMatchObject({ key: 'key-1' });
        expect(await queue.lastExecution('missing')).toBeNull();
      } finally {
        await close();
      }
    });

    it('health reports the provider', async () => {
      const { queue, close } = harness.open();
      try {
        const health = await queue.health();
        expect(health.ok).toBe(true);
        expect(health.provider).toBe(harness.name);
      } finally {
        await close();
      }
    });

    it('records survive reopening the adapter', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcprelay-contract-'));
      const options = { mirrorPath: join(dir, 'queue.db'), queueName: uniqueName() };
      const first = harness.open(options);
      const target = record();
      try {
        await first.queue.enqueue(target);
      } finally {
        await first.close();
      }

      const second = harness.open(options);
      try {
        expect(await second.queue.get(target.id)).toMatchObject({ id: target.id });
      } finally {
        await second.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

contractScenarios(sqliteHarness());

if (RABBIT_URL === undefined) {
  describe.skip('rabbitmq adapter contract (set MCPRELAY_RABBITMQ_URL to run)', () => {
    it('skipped without a broker', () => {});
  });
} else {
  contractScenarios(rabbitmqHarness());
}

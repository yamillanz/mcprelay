import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import amqp from 'amqplib';

const CLI = process.env.MCPRELAY_CLI ?? '/app/dist/cli/index.js';
const ECHO = process.env.MCPRELAY_ECHO ?? '/app/build/examples/echo-server/index.js';
const BROKER = process.env.MCPRELAY_RABBITMQ_URL ?? 'amqp://localhost';
const DIR = process.env.MCPRELAY_DEMO_DIR ?? '/data';
const EXCHANGE = 'mcp.dlx';
const QUEUE = 'mcp.dlq';

function log(line) {
  process.stdout.write(`${line}\n`);
}

function writeConfig(name, sleepTimeoutMs) {
  const path = join(DIR, name);
  writeFileSync(
    path,
    `queue:
  provider: rabbitmq
  rabbitmq:
    url: ${BROKER}
    exchange: ${EXCHANGE}
    queue: ${QUEUE}
  sqlite:
    path: ${join(DIR, 'queue.db')}
store:
  provider: sqlite
  sqlite:
    path: ${join(DIR, 'history.db')}
reliability:
  timeout_ms: 30000
  retry:
    max_attempts: 1
  per_tool:
    sleep:
      timeout_ms: ${sleepTimeoutMs}
`,
    'utf8',
  );
  return path;
}

function startMiddleware(configPath) {
  const child = spawn(
    process.execPath,
    [CLI, 'run', '--config', configPath, '--', process.execPath, ECHO],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let buffer = '';
  let stderrText = '';
  const queued = [];
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrText += chunk;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(JSON.parse(line));
      else queued.push(line);
    }
  });
  const next = () => {
    const line = queued.shift();
    if (line !== undefined) return Promise.resolve(JSON.parse(line));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), 30000);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  };
  const nextResponse = async () => {
    for (;;) {
      const frame = await next();
      if (frame.method !== undefined && frame.id !== undefined) {
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: frame.method === 'roots/list' ? { roots: [] } : {},
          })}\n`,
        );
        continue;
      }
      return frame;
    }
  };
  return {
    child,
    stderr: () => stderrText,
    async initialize() {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'rabbitmq-demo', version: '1.0.0' },
          },
        })}\n`,
      );
      const response = await nextResponse();
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      return response;
    },
    async callTool(id, name, args) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        })}\n`,
      );
      return nextResponse();
    },
    close() {
      child.kill('SIGKILL');
    },
  };
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  for (const entry of readdirSync(DIR)) {
    rmSync(join(DIR, entry), { recursive: true, force: true });
  }
  const captureConfig = writeConfig('mcprelay.config.yaml', 50);
  const replayConfig = writeConfig('replay.config.yaml', 5000);
  log(`demo: broker ${BROKER}, queue ${QUEUE}`);

  const session = startMiddleware(captureConfig);
  try {
    const init = await session.initialize();
    log(`step 1: middleware up (upstream: ${init.result?.serverInfo?.name ?? 'unknown'})`);

    const failed = await session.callTool(2, 'sleep', { ms: 200 });
    if (failed.error === undefined) throw new Error('the call was expected to time out');
    log(`step 2: call failed (${failed.error.message}) and was captured`);
  } finally {
    session.close();
  }

  const connection = await amqp.connect(BROKER);
  const channel = await connection.createChannel();
  const status = await channel.checkQueue(QUEUE);
  await channel.close();
  await connection.close();
  if (status.messageCount < 1) throw new Error(`no capture visible in ${QUEUE}`);
  log(`step 3: ${QUEUE} holds ${status.messageCount} capture(s)`);

  const listed = await runCli(['replay', 'list', '--config', captureConfig, '--json']);
  if (listed.code !== 0) throw new Error(`replay list failed: ${listed.stderr.trim()}`);
  const records = JSON.parse(listed.stdout);
  const pending = records.find((record) => record.replay.status === 'pending');
  if (pending === undefined) throw new Error('no pending record to replay');
  log(`step 4: pending record ${pending.id}`);

  const replay = await runCli(['replay', 'run', pending.id, '--config', replayConfig]);
  if (replay.code !== 0 || !replay.stdout.includes('replay ok')) {
    throw new Error(`replay failed: ${replay.stderr.trim() || replay.stdout.trim()}`);
  }
  log(`step 5: ${replay.stdout.trim()}`);
  log('demo: OK');
}

main().catch((error) => {
  log(`demo: FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

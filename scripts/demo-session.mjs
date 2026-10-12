/**
 * Raw JSON-RPC session plumbing for the demo scripts (and only them): plain
 * `.mjs` because scripts/ has no build step. The patterns mirror
 * `tests/helpers/raw-client.ts`, deliberately kept separate across the .mjs/TS
 * boundary.
 */
import { spawn } from 'node:child_process';

const NODE = process.execPath;
const FRAME_TIMEOUT_MS = 30_000;
const LOG_SETTLE_MS = 25;
const LOG_TIMEOUT_MS = 3_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Splits complete lines out of the stdout buffer and resolves waiters FIFO. */
function drainLines(state) {
  let index;
  while ((index = state.buffer.indexOf('\n')) >= 0) {
    const line = state.buffer.slice(0, index).trim();
    state.buffer = state.buffer.slice(index + 1);
    if (line.length === 0) continue;
    const waiter = state.waiters.shift();
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      waiter.resolve(JSON.parse(line));
    } else {
      state.frames.push(line);
    }
  }
}

function takeFrame(state) {
  const line = state.frames.shift();
  if (line !== undefined) return Promise.resolve(JSON.parse(line));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(reject, FRAME_TIMEOUT_MS, new Error('timed out waiting for a frame'));
    state.waiters.push({ resolve, timer });
  });
}

/** Next non-request frame, answering server→client requests on the way. */
async function nextResponse(state) {
  for (;;) {
    const frame = await takeFrame(state);
    if (frame.method !== undefined && frame.id !== undefined) {
      const result = frame.method === 'roots/list' ? { roots: [] } : {};
      state.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`);
      continue;
    }
    return frame;
  }
}

function logLines(state) {
  return state.stderrText.split('\n').filter((line) => line.startsWith('{'));
}

/**
 * Log lines arrive on a separate pipe from responses; wait until the count is
 * above `before` and stops changing, so one response yields all its lines.
 */
async function collectLogLines(state, before) {
  const deadline = Date.now() + LOG_TIMEOUT_MS;
  let seen = logLines(state).length;
  while (Date.now() < deadline) {
    await sleep(LOG_SETTLE_MS);
    const current = logLines(state).length;
    if (current > before && current === seen) return logLines(state).slice(before);
    seen = current;
  }
  return logLines(state).slice(before);
}

/** Starts `mcprelay run` wrapping `server` and returns a demo session handle. */
export function spawnSession({ cli, configPath, cliArgs = [], server }) {
  const child = spawn(NODE, [cli, 'run', '--config', configPath, ...cliArgs, '--', ...server], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = {
    buffer: '',
    stderrText: '',
    frames: [],
    waiters: [],
    stdin: child.stdin,
    nextId: 10,
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.buffer += chunk;
    drainLines(state);
  });
  child.stderr.on('data', (chunk) => {
    state.stderrText += chunk;
  });
  const send = (frame) => state.stdin.write(`${JSON.stringify(frame)}\n`);
  return {
    async handshake() {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'mcprelay-demo', version: '0.0.0' },
        },
      });
      await nextResponse(state);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    /** One tools/call; returns its response plus the log lines it produced. */
    async call(name, args) {
      const before = logLines(state).length;
      send({
        jsonrpc: '2.0',
        id: state.nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      const response = await nextResponse(state);
      const logs = await collectLogLines(state, before);
      return { response, logs };
    },
    close: () => child.kill('SIGKILL'),
  };
}

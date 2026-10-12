#!/usr/bin/env node
/**
 * §1 60-second demo runner (PRD §1) — the GIF's source of truth.
 *
 * Beats: call → dry-run policy probe → enforced deny → failing write → DLQ →
 * inspect → dry-run replay → fix → replay → visible side effect → report.
 * Runs against the REAL filesystem MCP server in a temp workspace; every
 * output in the transcript is real (log lines are condensed from the actual
 * JSON entries). The CLI command shown is `mcprelay`; this script runs the
 * local build at dist/cli/index.js. Ends with `demo: OK` and exit 0 only when
 * the replay succeeded AND the file is on disk.
 *
 * Prerequisites: `npm run build` and network for the filesystem server
 * (npx -y @modelcontextprotocol/server-filesystem).
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnSession } from './demo-session.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist/cli/index.js');
const NODE = process.execPath;
const SERVER = ['npx', '-y', '@modelcontextprotocol/server-filesystem'];
const PROMPT = '$';
const ERROR_MESSAGE_MAX = 48;

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function condensedLog(jsonLine) {
  const entry = JSON.parse(jsonLine);
  const parts = [`tool=${entry.tool}`, `decision=${entry.decision}`];
  if (entry.caller?.identity !== undefined && entry.caller.identity !== 'local') {
    parts.push(`caller=${entry.caller.identity}`);
  }
  if (entry.error?.message !== undefined) {
    const { message } = entry.error;
    const shown =
      message.length > ERROR_MESSAGE_MAX ? `${message.slice(0, ERROR_MESSAGE_MAX - 1)}…` : message;
    parts.push(`error="${shown}"`);
  }
  parts.push(`latency=${entry.latency_ms}ms`);
  return `[log] ${parts.join(' ')}`;
}

function describeResponse(response) {
  if (response.error !== undefined)
    return `error ${response.error.code}: ${response.error.message}`;
  if (response.result?.isError === true) return `isError: ${response.result.content?.[0]?.text}`;
  return response.result?.content?.[0]?.text ?? 'ok';
}

function execCli(args) {
  return spawnSync(NODE, [CLI, ...args], { encoding: 'utf8' });
}

function runCli(args) {
  say(`${PROMPT} mcprelay ${args.join(' ')}`);
  const result = execCli(args);
  for (const line of result.stdout.trim().split('\n')) say(`  ${line}`);
  if (result.status !== 0 && result.stderr.trim() !== '') say(`  ${result.stderr.trim()}`);
  return result;
}

async function doCall(session, name, args) {
  say(`${PROMPT} call ${name} ${JSON.stringify(args)}`);
  const { response, logs } = await session.call(name, args);
  for (const logLine of logs) say(`  ${condensedLog(logLine)}`);
  say(`  ${describeResponse(response)}`);
  return response;
}

/** Temp workspace + config: the read-only `reports/` dir is the demo's failure. */
function setupWorkspace() {
  const tmp = mkdtempSync(join(tmpdir(), 'demo-'));
  const workspace = join(tmp, 'workspace');
  const protectedDir = join(workspace, 'protected');
  const reportsDir = join(workspace, 'reports');
  mkdirSync(protectedDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(workspace, 'hello.txt'), 'hello from mcprelay\n');
  chmodSync(reportsDir, 0o555);
  const configPath = join(tmp, 'mcprelay.config.yaml');
  writeFileSync(
    // gate-exemption: embedded single-run config fixture (declarative data), not logic.
    configPath,
    `queue:
  provider: sqlite
  sqlite:
    path: ${join(tmp, 'queue.db')}
store:
  provider: sqlite
  sqlite:
    path: ${join(tmp, 'history.db')}
policy:
  default: allow
  rules:
    - tool: write_file
      args:
        path:
          prefix: ${protectedDir}
      action: deny
reliability:
  timeout_ms: 30000
  per_tool:
    write_file:
      capture_tool_errors: true
`,
  );
  return { tmp, workspace, protectedDir, reportsDir, configPath };
}

async function runProbe(paths) {
  say('  (dry-run first: the policy reports, nothing is enforced)');
  const probe = spawnSession({
    cli: CLI,
    configPath: paths.configPath,
    cliArgs: ['--policy-dry-run'],
    server: [...SERVER, paths.workspace],
  });
  try {
    await probe.handshake();
    await doCall(probe, 'write_file', {
      path: join(paths.protectedDir, 'secret.txt'),
      content: 'nope',
    });
  } finally {
    probe.close();
  }
  say('  → the write went through (dry-run enforces nothing); removing it again');
  rmSync(join(paths.protectedDir, 'secret.txt'), { force: true });
}

async function runMainSession(paths) {
  say('(now enforced)');
  const session = spawnSession({
    cli: CLI,
    configPath: paths.configPath,
    server: [...SERVER, paths.workspace],
  });
  try {
    await session.handshake();
    await doCall(session, 'read_file', { path: join(paths.workspace, 'hello.txt') });
    await doCall(session, 'write_file', {
      path: join(paths.protectedDir, 'secret.txt'),
      content: 'nope',
    });
    await doCall(session, 'write_file', {
      path: join(paths.reportsDir, 'report.txt'),
      content: 'quarterly report\n',
    });
  } finally {
    session.close();
  }
  say('  → captured: the failed call is in the dead-letter queue');
}

async function runReplayFlow(paths) {
  runCli(['replay', 'list', '--config', paths.configPath]);
  say('');
  const list = execCli(['replay', 'list', '--config', paths.configPath, '--json']);
  const record = JSON.parse(list.stdout.trim())[0];
  runCli(['replay', 'inspect', record.id, '--config', paths.configPath]);
  say('');
  runCli(['replay', 'run', record.id, '--config', paths.configPath, '--dry-run']);
  say('');
  say(`${PROMPT} chmod +w reports   # the fix: the directory was read-only`);
  chmodSync(paths.reportsDir, 0o755);
  const replay = runCli(['replay', 'run', record.id, '--config', paths.configPath]);
  say('');
  say(`${PROMPT} ls reports`);
  for (const entry of readdirSync(paths.reportsDir)) say(`  ${entry}   ← the side effect landed`);
  say('');
  runCli(['report', '--config', paths.configPath]);
  say('');
  const landed = replay.status === 0 && existsSync(join(paths.reportsDir, 'report.txt'));
  say(
    landed
      ? 'demo: OK — fail → capture → replay → the file is there.'
      : 'demo: FAILED — the side effect did not land.',
  );
  if (!landed) process.exitCode = 1;
}

const paths = setupWorkspace();
try {
  say('mcprelay — the 60-second demo (PRD §1)');
  say('');
  say(
    `${PROMPT} mcprelay run --config mcprelay.config.yaml -- npx @modelcontextprotocol/server-filesystem ./workspace`,
  );
  await runProbe(paths);
  say('');
  await runMainSession(paths);
  say('');
  await runReplayFlow(paths);
} finally {
  rmSync(paths.tmp, { recursive: true, force: true });
}

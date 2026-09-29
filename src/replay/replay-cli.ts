import { loadConfig } from '../config/config.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import type { FailureFilter, FailureRecord, ReplayStatus } from '../queue/failure-record.js';
import { SqliteQueueProvider } from '../queue/sqlite-queue.js';
import { runReplayRecord, type ReplayRunOptions } from './replay-run.js';

export interface ReplayIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const REPLAY_USAGE =
  'Usage: mcprelay replay <list|inspect|run> [options]\n' +
  '  list:    [--config <path>] [--json] [--status <s>] [--tool <name>] [--correlation-id <id>] [--since <iso>] [--until <iso>] [--limit <n>]\n' +
  '  inspect: <id> [--config <path>] [--json]\n' +
  '  run:     <id> [--dry-run] [--force] [--set key=value]… [--config <path>] [--json]';

const REPLAY_STATUSES: readonly ReplayStatus[] = ['pending', 'replayed', 'discarded'];

interface ReplayOptions {
  configPath?: string;
  json: boolean;
  id?: string;
  filter: FailureFilter;
}

type ParsedReplay = { ok: true; options: ReplayOptions } | { ok: false; message: string };

function parseReplayTokens(subcommand: string, tokens: readonly string[]): ParsedReplay {
  const options: ReplayOptions = { json: false, filter: {} };
  let index = 0;

  const value = (): string | undefined => tokens[index + 1];

  while (index < tokens.length) {
    const token = tokens[index] as string;
    switch (token) {
      case '--config': {
        const configPath = value();
        if (configPath === undefined)
          return { ok: false, message: "Missing value for '--config'." };
        options.configPath = configPath;
        index += 2;
        break;
      }
      case '--json':
        options.json = true;
        index += 1;
        break;
      case '--tool':
      case '--correlation-id':
      case '--since':
      case '--until': {
        const entry = value();
        if (entry === undefined) return { ok: false, message: `Missing value for '${token}'.` };
        if (token === '--tool') options.filter.tool = entry;
        if (token === '--correlation-id') options.filter.correlationId = entry;
        if (token === '--since') options.filter.since = entry;
        if (token === '--until') options.filter.until = entry;
        index += 2;
        break;
      }
      case '--status': {
        const status = value();
        if (status === undefined) return { ok: false, message: "Missing value for '--status'." };
        if (!REPLAY_STATUSES.includes(status as ReplayStatus)) {
          return { ok: false, message: `Invalid status '${status}'.` };
        }
        options.filter.status = status as ReplayStatus;
        index += 2;
        break;
      }
      case '--limit': {
        const raw = value();
        const limit = raw === undefined ? Number.NaN : Number(raw);
        if (!Number.isInteger(limit) || limit < 1) {
          return { ok: false, message: `Invalid value for '--limit': ${String(raw)}` };
        }
        options.filter.limit = limit;
        index += 2;
        break;
      }
      default: {
        if (subcommand === 'inspect' && options.id === undefined && !token.startsWith('-')) {
          options.id = token;
          index += 1;
          break;
        }
        return { ok: false, message: `Unknown option '${token}'.` };
      }
    }
  }

  if (subcommand === 'inspect' && options.id === undefined) {
    return { ok: false, message: 'Missing record id. Usage: mcprelay replay inspect <id>' };
  }
  return { ok: true, options };
}

function formatRecordLine(record: FailureRecord): string {
  return [
    record.id,
    record.captured_at,
    record.tool.name,
    record.failure.class,
    `attempts=${record.failure.attempts}`,
    record.replay.status,
    record.correlation_id,
  ].join('\t');
}

function formatRecordDetail(record: FailureRecord): string {
  return [
    `id:              ${record.id}`,
    `correlation_id:  ${record.correlation_id}`,
    `captured_at:     ${record.captured_at}`,
    `server:          ${record.server.name} (${record.server.command})`,
    `tool:            ${record.tool.name}`,
    `arguments_hash:  ${record.tool.arguments_hash}`,
    `arguments:       ${JSON.stringify(record.tool.arguments)}`,
    `failure.class:   ${record.failure.class}`,
    `failure.message: ${record.failure.message}`,
    `failure.attempts:${record.failure.attempts}`,
    `replay.status:   ${record.replay.status}`,
    `replay.outcome:  ${JSON.stringify(record.replay.last_outcome)}`,
    '',
  ].join('\n');
}

type ParsedRun = { ok: true; options: ReplayRunOptions } | { ok: false; message: string };

function parseRunTokens(tokens: readonly string[]): ParsedRun {
  const options: ReplayRunOptions = {
    id: '',
    dryRun: false,
    force: false,
    overrides: {},
    json: false,
  };
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index] as string;
    switch (token) {
      case '--config': {
        const value = tokens[index + 1];
        if (value === undefined) return { ok: false, message: "Missing value for '--config'." };
        options.configPath = value;
        index += 2;
        break;
      }
      case '--set': {
        const value = tokens[index + 1];
        if (value === undefined) return { ok: false, message: "Missing value for '--set'." };
        const separator = value.indexOf('=');
        if (separator <= 0)
          return { ok: false, message: `Invalid --set '${value}'; expected key=value.` };
        options.overrides[value.slice(0, separator)] = value.slice(separator + 1);
        index += 2;
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        index += 1;
        break;
      case '--force':
        options.force = true;
        index += 1;
        break;
      case '--json':
        options.json = true;
        index += 1;
        break;
      default: {
        if (!token.startsWith('-') && options.id === '') {
          options.id = token;
          index += 1;
          break;
        }
        return { ok: false, message: `Unknown option '${token}'.` };
      }
    }
  }

  if (options.id === '') {
    return { ok: false, message: 'Missing record id. Usage: mcprelay replay run <id>' };
  }
  return { ok: true, options };
}

function usageError(io: ReplayIO, message: string): number {
  io.stderr(`${message}\n${REPLAY_USAGE}\n`);
  return EXIT_USAGE;
}

function openQueue(path: string, io: ReplayIO): SqliteQueueProvider | undefined {
  try {
    return new SqliteQueueProvider({ path });
  } catch (error) {
    io.stderr(
      `mcprelay: cannot open queue database at '${path}': ${error instanceof Error ? error.message : String(error)}\n` +
        "mcprelay: if better-sqlite3's native binary is missing, run `npm rebuild better-sqlite3 --ignore-scripts=false`\n",
    );
    return undefined;
  }
}

/** `mcprelay replay list|inspect`: reads the same queue DB the middleware writes. */
export async function runReplay(tokens: readonly string[], io: ReplayIO): Promise<number> {
  const subcommand = tokens[0];
  if (subcommand === 'run') {
    const parsed = parseRunTokens(tokens.slice(1));
    if (!parsed.ok) return usageError(io, parsed.message);
    return runReplayRecord(parsed.options, io);
  }
  if (subcommand !== 'list' && subcommand !== 'inspect') {
    return usageError(
      io,
      subcommand === undefined
        ? 'Missing replay subcommand.'
        : `Unknown replay subcommand '${subcommand}'.`,
    );
  }

  const parsed = parseReplayTokens(subcommand, tokens.slice(1));
  if (!parsed.ok) return usageError(io, parsed.message);
  const { configPath, json, id, filter } = parsed.options;

  let queuePath: string;
  try {
    const config = loadConfig(configPath === undefined ? {} : { path: configPath });
    for (const warning of config.warnings) io.stderr(`mcprelay: warning: ${warning}\n`);
    queuePath = config.queue.sqlite.path;
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }

  const provider = openQueue(queuePath, io);
  if (provider === undefined) return EXIT_FAILURE;
  try {
    if (subcommand === 'list') {
      const records = await provider.list(filter);
      if (json) {
        io.stdout(`${JSON.stringify(records)}\n`);
      } else {
        for (const record of records) io.stdout(`${formatRecordLine(record)}\n`);
      }
      return EXIT_OK;
    }

    const record = await provider.get(id as string);
    if (record === null) {
      io.stderr(`mcprelay: failure record '${String(id)}' not found\n`);
      return EXIT_FAILURE;
    }
    io.stdout(json ? `${JSON.stringify(record)}\n` : formatRecordDetail(record));
    return EXIT_OK;
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  } finally {
    provider.close();
  }
}

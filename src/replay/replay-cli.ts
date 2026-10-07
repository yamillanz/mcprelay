import { loadConfig, type McprelayConfig } from '../config/config.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import type { FailureFilter, FailureRecord, ReplayStatus } from '../queue/failure-record.js';
import { createPersistence, type Persistence } from '../queue/providers.js';
import { runReplayBatch, runReplayRecord, type ReplayRunOptions } from './replay-run.js';

export interface ReplayIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const REPLAY_USAGE =
  'Usage: mcprelay replay <list|inspect|run> [options]\n' +
  '  list:    [--config <path>] [--json] [--status <s>] [--tool <name>] [--correlation-id <id>] [--since <iso>] [--until <iso>] [--limit <n>]\n' +
  '  inspect: <id> [--config <path>] [--json]\n' +
  '  run:     <id> | --all [--tool <name>] [--correlation-id <id>] [--since <iso>] [--until <iso>] [--limit <n>] [--dry-run] [--force] [--set key=value]… [--config <path>] [--json]';

const REPLAY_STATUSES: readonly ReplayStatus[] = ['pending', 'replayed', 'discarded'];

/** One parser step: the next token index, or a precise usage error. */
type Step = { ok: true; next: number } | { ok: false; message: string };

interface OptionValue {
  ok: true;
  value: string;
  next: number;
}

/** Reads the value that follows a flag; missing values share one error. */
function readOptionValue(
  tokens: readonly string[],
  index: number,
  flag: string,
): OptionValue | { ok: false; message: string } {
  const value = tokens[index + 1];
  if (value === undefined) return { ok: false, message: `Missing value for '${flag}'.` };
  return { ok: true, value, next: index + 2 };
}

interface ReplayOptions {
  configPath?: string;
  json: boolean;
  id?: string;
  filter: FailureFilter;
}

type ParsedReplay = { ok: true; options: ReplayOptions } | { ok: false; message: string };

function consumeConfigPath(
  tokens: readonly string[],
  index: number,
  target: { configPath?: string },
): Step {
  const read = readOptionValue(tokens, index, '--config');
  if (!read.ok) return read;
  target.configPath = read.value;
  return { ok: true, next: read.next };
}

function consumeJsonFlag(index: number, options: { json: boolean }): Step {
  options.json = true;
  return { ok: true, next: index + 1 };
}

function consumeFilterOption(
  tokens: readonly string[],
  index: number,
  token: string,
  target: { filter: FailureFilter },
): Step {
  const read = readOptionValue(tokens, index, token);
  if (!read.ok) return read;
  if (token === '--tool') target.filter.tool = read.value;
  if (token === '--correlation-id') target.filter.correlationId = read.value;
  if (token === '--since') target.filter.since = read.value;
  if (token === '--until') target.filter.until = read.value;
  return { ok: true, next: read.next };
}

function consumeStatus(tokens: readonly string[], index: number, options: ReplayOptions): Step {
  const read = readOptionValue(tokens, index, '--status');
  if (!read.ok) return read;
  if (!REPLAY_STATUSES.includes(read.value as ReplayStatus)) {
    return { ok: false, message: `Invalid status '${read.value}'.` };
  }
  options.filter.status = read.value as ReplayStatus;
  return { ok: true, next: read.next };
}

/** `--limit` reports the invalid value, not the shared missing-value error. */
function consumeLimit(
  tokens: readonly string[],
  index: number,
  target: { filter: FailureFilter },
): Step {
  const read = readOptionValue(tokens, index, '--limit');
  const raw = read.ok ? read.value : undefined;
  const limit = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, message: `Invalid value for '--limit': ${String(raw)}` };
  }
  target.filter.limit = limit;
  return { ok: true, next: index + 2 };
}

/** Consumes the positional record id for `inspect`; other default tokens are unknown options. */
function consumeInspectId(
  subcommand: string,
  token: string,
  index: number,
  options: ReplayOptions,
): Step {
  if (subcommand === 'inspect' && options.id === undefined && !token.startsWith('-')) {
    options.id = token;
    return { ok: true, next: index + 1 };
  }
  return { ok: false, message: `Unknown option '${token}'.` };
}

function consumeReplayToken(
  subcommand: string,
  tokens: readonly string[],
  index: number,
  token: string,
  options: ReplayOptions,
): Step {
  switch (token) {
    case '--config':
      return consumeConfigPath(tokens, index, options);
    case '--json':
      return consumeJsonFlag(index, options);
    case '--tool':
    case '--correlation-id':
    case '--since':
    case '--until':
      return consumeFilterOption(tokens, index, token, options);
    case '--status':
      return consumeStatus(tokens, index, options);
    case '--limit':
      return consumeLimit(tokens, index, options);
    default:
      return consumeInspectId(subcommand, token, index, options);
  }
}

function parseReplayTokens(subcommand: string, tokens: readonly string[]): ParsedReplay {
  const options: ReplayOptions = { json: false, filter: {} };
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index] as string;
    const step = consumeReplayToken(subcommand, tokens, index, token, options);
    if (!step.ok) return { ok: false, message: step.message };
    index = step.next;
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

function consumeSetOverride(
  tokens: readonly string[],
  index: number,
  options: ReplayRunOptions,
): Step {
  const read = readOptionValue(tokens, index, '--set');
  if (!read.ok) return read;
  const separator = read.value.indexOf('=');
  if (separator <= 0) {
    return { ok: false, message: `Invalid --set '${read.value}'; expected key=value.` };
  }
  options.overrides[read.value.slice(0, separator)] = read.value.slice(separator + 1);
  return { ok: true, next: read.next };
}

function consumeBooleanFlag(token: string, index: number, options: ReplayRunOptions): Step {
  if (token === '--all') options.all = true;
  if (token === '--dry-run') options.dryRun = true;
  if (token === '--force') options.force = true;
  if (token === '--json') options.json = true;
  return { ok: true, next: index + 1 };
}

/** Consumes the positional record id; other default tokens are unknown options. */
function consumeRunId(token: string, index: number, options: ReplayRunOptions): Step {
  if (!token.startsWith('-') && options.id === '') {
    options.id = token;
    return { ok: true, next: index + 1 };
  }
  return { ok: false, message: `Unknown option '${token}'.` };
}

function consumeRunToken(
  tokens: readonly string[],
  index: number,
  token: string,
  options: ReplayRunOptions,
): Step {
  switch (token) {
    case '--config':
      return consumeConfigPath(tokens, index, options);
    case '--set':
      return consumeSetOverride(tokens, index, options);
    case '--tool':
    case '--correlation-id':
    case '--since':
    case '--until':
      return consumeFilterOption(tokens, index, token, options);
    case '--limit':
      return consumeLimit(tokens, index, options);
    case '--all':
    case '--dry-run':
    case '--force':
    case '--json':
      return consumeBooleanFlag(token, index, options);
    default:
      return consumeRunId(token, index, options);
  }
}

function parseRunTokens(tokens: readonly string[]): ParsedRun {
  const options: ReplayRunOptions = {
    id: '',
    all: false,
    filter: {},
    dryRun: false,
    force: false,
    overrides: {},
    json: false,
  };
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index] as string;
    const step = consumeRunToken(tokens, index, token, options);
    if (!step.ok) return { ok: false, message: step.message };
    index = step.next;
  }

  if (options.all) {
    if (options.id !== '') {
      return { ok: false, message: "Use either <id> or '--all', not both." };
    }
    if (Object.keys(options.overrides).length > 0) {
      return {
        ok: false,
        message: "'--set' is not supported with '--all'; replay records individually.",
      };
    }
    return { ok: true, options };
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

function openQueue(config: McprelayConfig, io: ReplayIO): Persistence | undefined {
  try {
    const persistence = createPersistence(config);
    persistence.getQueue();
    return persistence;
  } catch (error) {
    io.stderr(
      `mcprelay: cannot open the queue provider: ${error instanceof Error ? error.message : String(error)}\n` +
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
    return parsed.options.all
      ? runReplayBatch(parsed.options, io)
      : runReplayRecord(parsed.options, io);
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

  let config: McprelayConfig;
  try {
    config = loadConfig(configPath === undefined ? {} : { path: configPath });
    for (const warning of config.warnings) io.stderr(`mcprelay: warning: ${warning}\n`);
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }

  const persistence = openQueue(config, io);
  if (persistence === undefined) return EXIT_FAILURE;
  const provider = persistence.getQueue();
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
    await persistence.close();
  }
}

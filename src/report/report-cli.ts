import { loadConfig, type McprelayConfig } from '../config/config.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { createPersistence, type Persistence } from '../queue/providers.js';
import type { StoreMetrics } from '../store/sqlite-store.js';

export interface ReportIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const REPORT_USAGE =
  'Usage: mcprelay report [--since <iso>] [--until <iso>] [--tool <name>] [--caller <identity>] [--json] [--config <path>]';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One parser step: the next token index, or a precise usage error. */
type Step = { ok: true; next: number } | { ok: false; message: string };

interface OptionValue {
  ok: true;
  value: string;
  next: number;
}

function readOptionValue(
  tokens: readonly string[],
  index: number,
  flag: string,
): OptionValue | { ok: false; message: string } {
  const value = tokens[index + 1];
  if (value === undefined) return { ok: false, message: `Missing value for '${flag}'.` };
  return { ok: true, value, next: index + 2 };
}

interface ReportOptions {
  since: string;
  until: string;
  tool?: string;
  caller?: string;
  json: boolean;
  configPath?: string;
}

type ParsedReport = { ok: true; options: ReportOptions } | { ok: false; message: string };

function consumeConfigPath(tokens: readonly string[], index: number, options: ReportOptions): Step {
  const read = readOptionValue(tokens, index, '--config');
  if (!read.ok) return read;
  options.configPath = read.value;
  return { ok: true, next: read.next };
}

function consumeTimeBound(
  tokens: readonly string[],
  index: number,
  token: string,
  options: ReportOptions,
): Step {
  const read = readOptionValue(tokens, index, token);
  if (!read.ok) return read;
  if (Number.isNaN(Date.parse(read.value))) {
    return {
      ok: false,
      message: `Invalid ${token} '${read.value}'; expected an ISO-8601 timestamp.`,
    };
  }
  if (token === '--since') options.since = read.value;
  else options.until = read.value;
  return { ok: true, next: read.next };
}

function consumeFilter(
  tokens: readonly string[],
  index: number,
  token: string,
  options: ReportOptions,
): Step {
  const read = readOptionValue(tokens, index, token);
  if (!read.ok) return read;
  if (token === '--tool') options.tool = read.value;
  else options.caller = read.value;
  return { ok: true, next: read.next };
}

function consumeReportToken(
  tokens: readonly string[],
  index: number,
  token: string,
  options: ReportOptions,
): Step {
  switch (token) {
    case '--config':
      return consumeConfigPath(tokens, index, options);
    case '--since':
    case '--until':
      return consumeTimeBound(tokens, index, token, options);
    case '--tool':
    case '--caller':
      return consumeFilter(tokens, index, token, options);
    case '--json':
      options.json = true;
      return { ok: true, next: index + 1 };
    default:
      return { ok: false, message: `Unknown option '${token}'.` };
  }
}

function parseReportTokens(tokens: readonly string[]): ParsedReport {
  const now = Date.now();
  const options: ReportOptions = {
    since: new Date(now - MS_PER_DAY).toISOString(),
    until: new Date(now).toISOString(),
    json: false,
  };
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index] as string;
    const step = consumeReportToken(tokens, index, token, options);
    if (!step.ok) return { ok: false, message: step.message };
    index = step.next;
  }
  return { ok: true, options };
}

function usageError(io: ReportIO, message: string): number {
  io.stderr(`${message}\n${REPORT_USAGE}\n`);
  return EXIT_USAGE;
}

function totalsOf(metrics: StoreMetrics): {
  calls: number;
  errors: number;
  error_rate: number;
} {
  const calls = metrics.tools.reduce((sum, row) => sum + row.calls, 0);
  const errors = metrics.tools.reduce((sum, row) => sum + row.errors, 0);
  return { calls, errors, error_rate: calls === 0 ? 0 : errors / calls };
}

function renderMetricsTable(io: ReportIO, options: ReportOptions, metrics: StoreMetrics): void {
  const totals = totalsOf(metrics);
  io.stdout(`window: ${options.since} .. ${options.until}\n`);
  io.stdout(
    `calls ${totals.calls} · allowed ${metrics.decisions.allowed} · denied ${metrics.decisions.denied} · ` +
      `failed ${metrics.decisions.failed} · cancelled ${metrics.decisions.cancelled} · replayed ${metrics.replayed}\n`,
  );

  const header = [
    'CALLER',
    'TOOL',
    'CALLS',
    'ERRORS',
    'ERR%',
    'P50',
    'P95',
    'AVG_REQ_B',
    'AVG_RESP_B',
  ];
  const rows = metrics.tools.map((row) => [
    row.caller,
    row.tool,
    String(row.calls),
    String(row.errors),
    `${(row.error_rate * 100).toFixed(1)}%`,
    `${row.latency_p50_ms}ms`,
    `${row.latency_p95_ms}ms`,
    String(row.avg_request_bytes),
    String(row.avg_response_bytes),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] as string).length)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] as number))
      .join('  ')
      .trimEnd();
  io.stdout(`${render(header)}\n`);
  for (const row of rows) io.stdout(`${render(row)}\n`);
}

function renderMetricsJson(options: ReportOptions, metrics: StoreMetrics): string {
  const totals = totalsOf(metrics);
  return `${JSON.stringify({
    since: options.since,
    until: options.until,
    totals: {
      calls: totals.calls,
      errors: totals.errors,
      error_rate: totals.error_rate,
      ...metrics.decisions,
      replayed: metrics.replayed,
    },
    tools: metrics.tools,
  })}\n`;
}

/** `mcprelay report`: per caller+tool metrics for a time range (FR-O3). */
export async function runReport(tokens: readonly string[], io: ReportIO): Promise<number> {
  const parsed = parseReportTokens(tokens);
  if (!parsed.ok) return usageError(io, parsed.message);
  const options = parsed.options;

  let config: McprelayConfig;
  try {
    config = loadConfig(options.configPath === undefined ? {} : { path: options.configPath });
    for (const warning of config.warnings) io.stderr(`mcprelay: warning: ${warning}\n`);
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }

  let persistence: Persistence;
  try {
    persistence = createPersistence(config);
    persistence.getStore();
  } catch (error) {
    io.stderr(
      `mcprelay: cannot open the store provider: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_FAILURE;
  }

  try {
    const metrics = await persistence.getStore().metrics({
      since: options.since,
      until: options.until,
      ...(options.tool === undefined ? {} : { tool: options.tool }),
      ...(options.caller === undefined ? {} : { caller: options.caller }),
    });
    if (options.json) io.stdout(renderMetricsJson(options, metrics));
    else renderMetricsTable(io, options, metrics);
    return EXIT_OK;
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  } finally {
    await persistence.close();
  }
}

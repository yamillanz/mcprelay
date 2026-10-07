import { Client } from '@modelcontextprotocol/client';

import { loadConfig, resolveToolPolicy, type McprelayConfig } from '../config/config.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { extractIdempotencyKey } from '../pipeline/idempotency.js';
import type { FailureFilter, FailureRecord } from '../queue/failure-record.js';
import { RecordNotFoundError, type IdempotencyIndex, type QueueProvider } from '../queue/port.js';
import { createPersistence } from '../queue/providers.js';
import { HttpUpstreamLink, StdioUpstreamLink, type UpstreamLink } from '../proxy/transports.js';
import { redactDeep } from '../redaction/redact.js';
import type { Store } from '../store/sqlite-store.js';
import { packageVersion } from '../version.js';
import { parseCommandLine } from './command-line.js';
import { applyOverrides, dedupVerdict, type DedupVerdict } from './guards.js';

export interface ReplayRunIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface ReplayRunOptions {
  id: string;
  all: boolean;
  filter: FailureFilter;
  dryRun: boolean;
  force: boolean;
  overrides: Record<string, string>;
  configPath?: string;
  json: boolean;
}

/** The replay's own (redacted) result or error — the only place its outcome lives. */
interface RunOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

type ReplayAttempt =
  { kind: 'unreachable'; message: string } | { kind: 'executed'; outcome: RunOutcome };

type Queue = QueueProvider & IdempotencyIndex;

interface Providers {
  queue: Queue;
  store: Store;
  close(): Promise<void>;
}

interface CallIdentity {
  key?: string;
  argumentsHash: string;
}

const CLAIM_LEASE_MS = 5 * 60 * 1000;

function redactedMarkerKeys(value: unknown, prefix = ''): string[] {
  if (value === '[REDACTED]') return [prefix === '' ? '(root)' : prefix];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => redactedMarkerKeys(entry, `${prefix}[${index}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    redactedMarkerKeys(entry, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function loadReplayConfig(options: ReplayRunOptions, io: ReplayRunIO): McprelayConfig | undefined {
  try {
    const config = loadConfig(options.configPath === undefined ? {} : { path: options.configPath });
    for (const warning of config.warnings) io.stderr(`mcprelay: warning: ${warning}\n`);
    return config;
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

function openProviders(config: McprelayConfig, io: ReplayRunIO): Providers | undefined {
  try {
    const persistence = createPersistence(config);
    const queue = persistence.getQueue();
    const store = persistence.getStore();
    return { queue, store, close: () => persistence.close() };
  } catch (error) {
    io.stderr(
      `mcprelay: cannot open the queue/store: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

async function fetchRecord(
  queue: Queue,
  id: string,
  io: ReplayRunIO,
): Promise<FailureRecord | undefined> {
  const record = await queue.get(id);
  if (record === null) io.stderr(`mcprelay: failure record '${id}' not found\n`);
  return record ?? undefined;
}

function resolveArguments(
  record: FailureRecord,
  overrides: Record<string, string>,
): { replayArguments: Record<string, unknown>; remainingMarkers: string[] } {
  const storedArguments = (record.tool.arguments ?? {}) as Record<string, unknown>;
  const replayArguments = applyOverrides(storedArguments, overrides);
  return { replayArguments, remainingMarkers: redactedMarkerKeys(replayArguments) };
}

async function computeDedupVerdict(
  queue: Queue,
  config: McprelayConfig,
  record: FailureRecord,
  key: string | undefined,
): Promise<DedupVerdict> {
  return dedupVerdict({
    ...(key === undefined ? {} : { key }),
    argumentsHash: record.tool.arguments_hash,
    windowMs: config.reliability.replay.dedupWindowMs,
    now: new Date(),
    lastByKey: key === undefined ? null : await queue.lastExecution(key),
    lastByHash:
      key === undefined ? await queue.lastExecutionByHash(record.tool.arguments_hash) : null,
  });
}

/** Returns an exit code when the run must be refused, undefined when it may proceed. */
function guardRun(deps: {
  remainingMarkers: string[];
  verdict: DedupVerdict;
  force: boolean;
  io: ReplayRunIO;
}): number | undefined {
  if (deps.remainingMarkers.length > 0) {
    deps.io.stderr(
      `mcprelay: stored arguments contain redacted values (${deps.remainingMarkers.join(', ')}); ` +
        `supply them with --set key=value before replaying\n`,
    );
    return EXIT_FAILURE;
  }
  if (deps.verdict.duplicate && !deps.force) {
    deps.io.stderr(
      `mcprelay: duplicate side-effect risk: '${deps.verdict.previous?.key}' was successfully executed at ` +
        `${deps.verdict.previous?.executedAt} (${deps.verdict.matchedBy}); use --force to replay anyway\n`,
    );
    return EXIT_FAILURE;
  }
  return undefined;
}

async function claimOrReport(
  queue: Queue,
  record: FailureRecord,
  io: ReplayRunIO,
): Promise<boolean> {
  try {
    await queue.claim(record.id, CLAIM_LEASE_MS);
    return true;
  } catch (error) {
    io.stderr(
      `mcprelay: cannot claim '${record.id}': ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}

/** Reconnects over the record's transport: stdio command, or HTTP endpoint + config headers. */
async function connectStoredServer(
  record: FailureRecord,
  config: McprelayConfig,
): Promise<{ client: Client; link: UpstreamLink }> {
  const link: UpstreamLink =
    record.server.transport === 'http'
      ? new HttpUpstreamLink({
          url: record.server.command,
          headers: config.upstream.http.headers,
        })
      : new StdioUpstreamLink({
          ...parseCommandLine(record.server.command),
          onStderr: (chunk) => {
            process.stderr.write(chunk);
          },
        });
  const client = new Client(
    { name: 'mcprelay-replay', version: packageVersion() },
    {
      versionNegotiation: { mode: 'auto' },
      capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
    },
  );
  await link.connect(client);
  return { client, link };
}

async function closeUpstream(upstream: { client: Client; link: UpstreamLink }): Promise<void> {
  await upstream.link.close().catch(() => {});
  await upstream.client.close().catch(() => {});
}

async function listToolNames(client: Client): Promise<string[]> {
  const result = (await client.listTools()) as { tools: Array<{ name: string }> };
  return result.tools.map((tool) => tool.name);
}

/** Connects and executes once; touches no queue state (the caller decides release/resolve). */
async function attemptReplay(
  config: McprelayConfig,
  record: FailureRecord,
  replayArguments: Record<string, unknown>,
): Promise<ReplayAttempt> {
  let upstream: { client: Client; link: UpstreamLink };
  try {
    upstream = await connectStoredServer(record, config);
  } catch (error) {
    return {
      kind: 'unreachable',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const policy = resolveToolPolicy(config, record.tool.name);
    const result = (await upstream.client.callTool(
      { name: record.tool.name, arguments: replayArguments },
      { timeout: policy.timeoutMs },
    )) as Record<string, unknown>;
    const isError = result.isError === true;
    return {
      kind: 'executed',
      outcome: isError
        ? {
            ok: false,
            error: 'tool reported isError',
            result: redactDeep(result, config.redaction.patterns),
          }
        : { ok: true, result: redactDeep(result, config.redaction.patterns) },
    };
  } catch (error) {
    return {
      kind: 'executed',
      outcome: {
        ok: false,
        error: redactDeep(
          error instanceof Error ? error.message : String(error),
          config.redaction.patterns,
        ) as string,
      },
    };
  } finally {
    await closeUpstream(upstream);
  }
}

/** Unreachable → release (stays pending); executed → resolve + audit + idempotency index. */
async function persistOutcome(
  providers: Providers,
  record: FailureRecord,
  attempt: ReplayAttempt,
  identity: CallIdentity,
): Promise<void> {
  if (attempt.kind === 'unreachable') {
    await providers.queue.release(record.id);
    return;
  }

  const attemptEntry = { at: new Date().toISOString(), source: 'replay' as const };
  await providers.queue.resolve(record.id, {
    status: 'replayed',
    attempts: [...record.replay.attempts, attemptEntry],
    lastOutcome: attempt.outcome,
  });
  await providers.store.audit({
    kind: 'replayed',
    correlationId: record.correlation_id,
    failureId: record.id,
    toolName: record.tool.name,
    detail: attempt.outcome,
  });

  if (attempt.outcome.ok && identity.key !== undefined) {
    await providers.queue.recordExecution({
      key: identity.key,
      toolName: record.tool.name,
      argumentsHash: identity.argumentsHash,
      executedAt: attemptEntry.at,
      source: 'replay',
    });
  }
}

function reportOutcome(
  io: ReplayRunIO,
  record: FailureRecord,
  attempt: ReplayAttempt,
  json: boolean,
): number {
  if (attempt.kind === 'unreachable') {
    io.stderr(
      `mcprelay: replay could not reach the tool (${attempt.message}); record left pending\n`,
    );
    return EXIT_FAILURE;
  }
  if (json) io.stdout(`${JSON.stringify({ id: record.id, outcome: attempt.outcome })}\n`);
  if (attempt.outcome.ok) {
    io.stdout(`replay ok: ${record.id}\n`);
    return EXIT_OK;
  }
  io.stderr(`replay failed: ${record.id}: ${attempt.outcome.error ?? 'unknown error'}\n`);
  return EXIT_FAILURE;
}

function reportDryRunSummary(io: ReplayRunIO, record: FailureRecord): void {
  io.stdout(`record:      ${record.id}\n`);
  io.stdout(`tool:        ${record.tool.name}\n`);
  io.stdout(`class:       ${record.failure.class} (attempts ${record.failure.attempts})\n`);
  io.stdout(`server:      ${record.server.command}\n`);
  io.stdout(`arguments:   ${JSON.stringify(record.tool.arguments)}\n`);
  io.stdout('dry-run:     no upstream tools/call will be made\n');
}

function reportDryRunGuards(deps: {
  io: ReplayRunIO;
  config: McprelayConfig;
  record: FailureRecord;
  remainingMarkers: string[];
  verdict: DedupVerdict;
}): void {
  if (deps.remainingMarkers.length > 0) {
    deps.io.stdout(`redacted:    requires --set for: ${deps.remainingMarkers.join(', ')}\n`);
  }
  if (deps.verdict.duplicate) {
    deps.io.stdout(
      `duplicate:   ${deps.verdict.previous?.key} succeeded at ${deps.verdict.previous?.executedAt} (${deps.verdict.matchedBy}); --force required\n`,
    );
  }
  if (deps.config.reliability.perTool[deps.record.tool.name]?.effects === 'read') {
    deps.io.stdout('hint:        effects: read — a read-only tool is rarely worth replaying\n');
  }
}

/** Read-only inspection: tools/list only, zero `tools/call`. */
async function runDryRun(deps: {
  io: ReplayRunIO;
  config: McprelayConfig;
  record: FailureRecord;
  replayArguments: Record<string, unknown>;
  remainingMarkers: string[];
  verdict: DedupVerdict;
  json: boolean;
}): Promise<number> {
  const { io, record, replayArguments } = deps;
  reportDryRunSummary(io, record);
  reportDryRunGuards(deps);

  let upstream: { client: Client; link: UpstreamLink } | undefined;
  try {
    upstream = await connectStoredServer(record, deps.config);
    const tools = await listToolNames(upstream.client);
    if (!tools.includes(record.tool.name)) {
      io.stderr(`mcprelay: tool '${record.tool.name}' does not exist upstream; replay aborted\n`);
      return EXIT_FAILURE;
    }
    io.stdout(`tool check:  present (${tools.length} tools)\n`);
    io.stdout(`arguments:   ${JSON.stringify(replayArguments)}\n`);
    if (deps.json) {
      io.stdout(`${JSON.stringify({ id: record.id, dryRun: true, toolPresent: true })}\n`);
    }
    return EXIT_OK;
  } catch (error) {
    io.stderr(
      `mcprelay: could not reach the stored server: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_FAILURE;
  } finally {
    if (upstream !== undefined) await closeUpstream(upstream);
  }
}

/**
 * `mcprelay replay run <id>`: dry-run inspection, or redrive for side effects.
 * The body reads as the run sequence; each phase lives in a named helper above.
 */
export async function runReplayRecord(options: ReplayRunOptions, io: ReplayRunIO): Promise<number> {
  const config = loadReplayConfig(options, io);
  if (config === undefined) return EXIT_USAGE;

  const providers = openProviders(config, io);
  if (providers === undefined) return EXIT_FAILURE;

  try {
    let record: FailureRecord | undefined;
    try {
      record = await fetchRecord(providers.queue, options.id, io);
    } catch (error) {
      if (error instanceof RecordNotFoundError) io.stderr(`mcprelay: ${error.message}\n`);
      else io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    }
    if (record === undefined) return EXIT_FAILURE;

    const storedArguments = (record.tool.arguments ?? {}) as Record<string, unknown>;
    const key = extractIdempotencyKey({ arguments: storedArguments });
    const identity: CallIdentity = {
      ...(key === undefined ? {} : { key }),
      argumentsHash: record.tool.arguments_hash,
    };
    const { replayArguments, remainingMarkers } = resolveArguments(record, options.overrides);
    const verdict = await computeDedupVerdict(providers.queue, config, record, key);

    if (options.dryRun) {
      return await runDryRun({
        io,
        config,
        record,
        replayArguments,
        remainingMarkers,
        verdict,
        json: options.json,
      });
    }

    const refusal = guardRun({ remainingMarkers, verdict, force: options.force, io });
    if (refusal !== undefined) return refusal;

    if (!(await claimOrReport(providers.queue, record, io))) return EXIT_FAILURE;

    const attempt = await attemptReplay(config, record, replayArguments);
    try {
      await persistOutcome(providers, record, attempt, identity);
    } catch (error) {
      io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    }
    return reportOutcome(io, record, attempt, options.json);
  } finally {
    await providers.close();
  }
}

interface BatchRecordResult {
  id: string;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
}

/** One record inside a batch: the same guards, claim, attempt, and persist as a single run. */
async function replayBatchRecord(
  providers: Providers,
  config: McprelayConfig,
  record: FailureRecord,
  options: ReplayRunOptions,
  io: ReplayRunIO,
): Promise<BatchRecordResult> {
  const storedArguments = (record.tool.arguments ?? {}) as Record<string, unknown>;
  const key = extractIdempotencyKey({ arguments: storedArguments });
  const identity: CallIdentity = {
    ...(key === undefined ? {} : { key }),
    argumentsHash: record.tool.arguments_hash,
  };
  const { replayArguments, remainingMarkers } = resolveArguments(record, options.overrides);
  const verdict = await computeDedupVerdict(providers.queue, config, record, key);

  if (options.dryRun) {
    const code = await runDryRun({
      io,
      config,
      record,
      replayArguments,
      remainingMarkers,
      verdict,
      json: false,
    });
    return code === EXIT_OK
      ? { id: record.id, status: 'ok' }
      : { id: record.id, status: 'failed', error: 'dry-run inspection failed' };
  }

  const refusal = guardRun({ remainingMarkers, verdict, force: options.force, io });
  if (refusal !== undefined) return { id: record.id, status: 'skipped', error: 'guard refused' };

  if (!(await claimOrReport(providers.queue, record, io))) {
    return { id: record.id, status: 'skipped', error: 'claimed by another replay' };
  }

  const attempt = await attemptReplay(config, record, replayArguments);
  await persistOutcome(providers, record, attempt, identity);
  if (attempt.kind === 'unreachable') {
    return { id: record.id, status: 'failed', error: attempt.message };
  }
  if (attempt.outcome.ok) return { id: record.id, status: 'ok' };
  return { id: record.id, status: 'failed', error: attempt.outcome.error ?? 'unknown error' };
}

/**
 * `mcprelay replay run --all`: sequentially redrives the pending records that
 * match the filter, reporting per-record outcomes and a summary.
 */
export async function runReplayBatch(options: ReplayRunOptions, io: ReplayRunIO): Promise<number> {
  const config = loadReplayConfig(options, io);
  if (config === undefined) return EXIT_USAGE;

  const providers = openProviders(config, io);
  if (providers === undefined) return EXIT_FAILURE;

  try {
    let records: FailureRecord[];
    try {
      records = await providers.queue.list({ ...options.filter, status: 'pending' });
    } catch (error) {
      io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    }

    const results: BatchRecordResult[] = [];
    for (const record of records) {
      const result = await replayBatchRecord(providers, config, record, options, io);
      results.push(result);
      if (!options.json) {
        if (result.status === 'ok') io.stdout(`replay ok: ${record.id}\n`);
        else if (result.status === 'failed') {
          io.stderr(`replay failed: ${record.id}: ${result.error ?? 'unknown error'}\n`);
        } else {
          io.stderr(`replay skipped: ${record.id}: ${result.error ?? 'skipped'}\n`);
        }
      }
    }

    const summary = {
      all: true,
      selected: records.length,
      ok: results.filter((result) => result.status === 'ok').length,
      failed: results.filter((result) => result.status === 'failed').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
    };
    if (options.json) {
      io.stdout(`${JSON.stringify({ ...summary, records: results })}\n`);
    } else {
      io.stdout(
        `replay --all: ${summary.selected} selected, ${summary.ok} ok, ${summary.failed} failed, ${summary.skipped} skipped\n`,
      );
    }
    return summary.failed > 0 || summary.skipped > 0 ? EXIT_FAILURE : EXIT_OK;
  } finally {
    await providers.close();
  }
}

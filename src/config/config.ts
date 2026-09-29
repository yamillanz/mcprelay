import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { DEFAULT_REDACTION_PATTERNS } from '../redaction/redact.js';

/** Configuration error: message always names the config path and the field. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface RetryConfig {
  maxAttempts: number;
  backoff: 'exponential';
  baseMs: number;
  jitter: boolean;
}

export interface ToolOverride {
  timeoutMs?: number;
  idempotent?: boolean;
  effects?: 'read' | 'write';
  retry?: Partial<RetryConfig>;
  captureToolErrors?: boolean;
}

export interface ReplayConfig {
  dedupWindowMs: number;
}

export interface ReliabilityConfig {
  timeoutMs: number;
  retry: RetryConfig;
  replay: ReplayConfig;
  idempotentDefault: boolean;
  perTool: Record<string, ToolOverride>;
}

export interface QueueConfig {
  provider: 'sqlite';
  sqlite: { path: string };
}

export interface StoreConfig {
  provider: 'sqlite';
  sqlite: { path: string };
}

export interface RedactionConfig {
  patterns: string[];
}

export interface McprelayConfig {
  reliability: ReliabilityConfig;
  queue: QueueConfig;
  store: StoreConfig;
  redaction: RedactionConfig;
  warnings: string[];
}

export interface ConfigOverrides {
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface ToolPolicy {
  timeoutMs: number;
  retry: RetryConfig;
  idempotent: boolean;
  captureToolErrors: boolean;
}

const DEFAULT_CONFIG_PATH = 'mcprelay.config.yaml';
const RELIABILITY_KEYS = new Set([
  'timeout_ms',
  'idempotent_default',
  'retry',
  'replay',
  'per_tool',
]);
const RETRY_KEYS = new Set(['max_attempts', 'backoff', 'base_ms', 'jitter']);
const REPLAY_KEYS = new Set(['dedup_window']);
const PER_TOOL_KEYS = new Set([
  'timeout_ms',
  'idempotent',
  'effects',
  'retry',
  'capture_tool_errors',
]);
const QUEUE_KEYS = new Set(['provider', 'sqlite']);
const SQLITE_KEYS = new Set(['path']);
const REDACTION_KEYS = new Set(['patterns']);

export function defaultConfig(): McprelayConfig {
  return {
    reliability: {
      timeoutMs: 30000,
      retry: { maxAttempts: 3, backoff: 'exponential', baseMs: 250, jitter: true },
      replay: { dedupWindowMs: 24 * 60 * 60 * 1000 },
      idempotentDefault: false,
      perTool: {},
    },
    queue: { provider: 'sqlite', sqlite: { path: './.mcprelay/queue.db' } },
    store: { provider: 'sqlite', sqlite: { path: './.mcprelay/history.db' } },
    redaction: { patterns: [...DEFAULT_REDACTION_PATTERNS] },
    warnings: [],
  };
}

export function resolveToolPolicy(config: McprelayConfig, tool: string): ToolPolicy {
  const override = config.reliability.perTool[tool];
  return {
    timeoutMs: override?.timeoutMs ?? config.reliability.timeoutMs,
    retry: { ...config.reliability.retry, ...(override?.retry ?? {}) },
    idempotent: override?.idempotent ?? config.reliability.idempotentDefault,
    captureToolErrors: override?.captureToolErrors ?? false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new ConfigError(`${label}: expected integer >= ${minimum}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${label}: expected boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new ConfigError(`${label}.${key}: not a recognized setting`);
  }
}

function requireBackoff(value: unknown, label: string): 'exponential' {
  if (value !== 'exponential') {
    throw new ConfigError(`${label}: expected 'exponential', got ${JSON.stringify(value)}`);
  }
  return 'exponential';
}

function requireEffects(value: unknown, label: string): 'read' | 'write' {
  if (value !== 'read' && value !== 'write') {
    throw new ConfigError(`${label}: expected 'read' or 'write', got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Copies the retry fields present in `raw` onto `target`; only present fields change. */
function parseRetryFields(raw: unknown, label: string, target: Partial<RetryConfig>): void {
  if (!isRecord(raw)) throw new ConfigError(`${label}: expected a mapping`);
  assertKnownKeys(raw, RETRY_KEYS, label);

  if ('max_attempts' in raw) {
    target.maxAttempts = requireInteger(raw.max_attempts, `${label}.max_attempts`, 1);
  }
  if ('backoff' in raw) target.backoff = requireBackoff(raw.backoff, `${label}.backoff`);
  if ('base_ms' in raw) target.baseMs = requireInteger(raw.base_ms, `${label}.base_ms`, 0);
  if ('jitter' in raw) target.jitter = requireBoolean(raw.jitter, `${label}.jitter`);
}

function parsePerToolOverride(raw: unknown, label: string): ToolOverride {
  if (!isRecord(raw)) throw new ConfigError(`${label}: expected a mapping`);
  assertKnownKeys(raw, PER_TOOL_KEYS, label);

  const override: ToolOverride = {};
  if ('timeout_ms' in raw) {
    override.timeoutMs = requireInteger(raw.timeout_ms, `${label}.timeout_ms`, 1);
  }
  if ('idempotent' in raw) {
    override.idempotent = requireBoolean(raw.idempotent, `${label}.idempotent`);
  }
  if ('effects' in raw) override.effects = requireEffects(raw.effects, `${label}.effects`);
  if ('retry' in raw) {
    const retry: Partial<RetryConfig> = {};
    parseRetryFields(raw.retry, `${label}.retry`, retry);
    override.retry = retry;
  }
  if ('capture_tool_errors' in raw) {
    override.captureToolErrors = requireBoolean(
      raw.capture_tool_errors,
      `${label}.capture_tool_errors`,
    );
  }
  return override;
}

function applyPerTool(target: Record<string, ToolOverride>, raw: unknown, label: string): void {
  if (!isRecord(raw)) throw new ConfigError(`${label}: expected a mapping of tool names`);
  for (const [tool, rawOverride] of Object.entries(raw)) {
    target[tool] = parsePerToolOverride(rawOverride, `${label}.${tool}`);
  }
}

/** Parses `30m`, `24h`, `7d`, `90s`, `500ms` into milliseconds. */
function parseDuration(text: string, label: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text);
  if (match === null) {
    throw new ConfigError(
      `${label}: expected a duration like '30m' or '24h', got ${JSON.stringify(text)}`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const factor =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
  return amount * factor;
}

function applyReplay(config: McprelayConfig, raw: unknown, label: string): void {
  if (!isRecord(raw)) throw new ConfigError(`${label}: expected a mapping`);
  assertKnownKeys(raw, REPLAY_KEYS, label);
  if ('dedup_window' in raw) {
    if (typeof raw.dedup_window !== 'string') {
      throw new ConfigError(
        `${label}.dedup_window: expected a duration string, got ${JSON.stringify(raw.dedup_window)}`,
      );
    }
    config.reliability.replay.dedupWindowMs = parseDuration(
      raw.dedup_window,
      `${label}.dedup_window`,
    );
  }
}

function applyReliability(config: McprelayConfig, raw: unknown, path: string): void {
  if (!isRecord(raw)) throw new ConfigError(`${path}: reliability: expected a mapping`);
  assertKnownKeys(raw, RELIABILITY_KEYS, `${path}: reliability`);

  if ('timeout_ms' in raw) {
    config.reliability.timeoutMs = requireInteger(
      raw.timeout_ms,
      `${path}: reliability.timeout_ms`,
      1,
    );
  }
  if ('idempotent_default' in raw) {
    config.reliability.idempotentDefault = requireBoolean(
      raw.idempotent_default,
      `${path}: reliability.idempotent_default`,
    );
  }
  if ('retry' in raw) {
    parseRetryFields(raw.retry, `${path}: reliability.retry`, config.reliability.retry);
  }
  if ('replay' in raw) {
    applyReplay(config, raw.replay, `${path}: reliability.replay`);
  }
  if ('per_tool' in raw) {
    applyPerTool(config.reliability.perTool, raw.per_tool, `${path}: reliability.per_tool`);
  }
}

function resolveConfigPath(options: { path?: string; cwd?: string }): {
  path: string;
  required: boolean;
} {
  return options.path === undefined
    ? { path: resolve(options.cwd ?? process.cwd(), DEFAULT_CONFIG_PATH), required: false }
    : { path: options.path, required: true };
}

/** Returns the file text, or undefined when the file does not exist. */
function readConfigText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `${path}: cannot read config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Parses YAML into a top-level mapping; undefined for an empty document. */
function parseConfigDocument(text: string, path: string): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(
      `${path}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ConfigError(`${path}: expected a YAML mapping at the top level`);
  return raw;
}

const TOP_LEVEL_KEYS = new Set(['reliability', 'queue', 'store', 'redaction']);

function applySqliteSection(
  target: { provider: 'sqlite'; sqlite: { path: string } },
  raw: unknown,
  label: string,
): void {
  if (!isRecord(raw)) throw new ConfigError(`${label}: expected a mapping`);
  assertKnownKeys(raw, QUEUE_KEYS, label);

  if ('provider' in raw) {
    if (raw.provider !== 'sqlite') {
      throw new ConfigError(
        `${label}.provider: expected 'sqlite', got ${JSON.stringify(raw.provider)}`,
      );
    }
    target.provider = 'sqlite';
  }
  if ('sqlite' in raw) {
    const sqlite = raw.sqlite;
    if (!isRecord(sqlite)) throw new ConfigError(`${label}.sqlite: expected a mapping`);
    assertKnownKeys(sqlite, SQLITE_KEYS, `${label}.sqlite`);
    if ('path' in sqlite) {
      if (typeof sqlite.path !== 'string' || sqlite.path.length === 0) {
        throw new ConfigError(
          `${label}.sqlite.path: expected a non-empty string, got ${JSON.stringify(sqlite.path)}`,
        );
      }
      target.sqlite.path = sqlite.path;
    }
  }
}

function applyRedaction(config: McprelayConfig, raw: unknown, label: string): void {
  if (!isRecord(raw)) throw new ConfigError(`${label}: expected a mapping`);
  assertKnownKeys(raw, REDACTION_KEYS, label);
  if ('patterns' in raw) {
    const patterns = raw.patterns;
    if (
      !Array.isArray(patterns) ||
      patterns.some((entry) => typeof entry !== 'string' || entry.length === 0)
    ) {
      throw new ConfigError(`${label}.patterns: expected an array of non-empty strings`);
    }
    config.redaction.patterns = patterns as string[];
  }
}

function applyConfigDocument(
  config: McprelayConfig,
  document: Record<string, unknown>,
  path: string,
): void {
  for (const key of Object.keys(document)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      config.warnings.push(
        `${path}: unknown top-level section '${key}' ignored (not implemented yet)`,
      );
    }
  }
  if ('reliability' in document) applyReliability(config, document.reliability, path);
  if ('queue' in document) applySqliteSection(config.queue, document.queue, `${path}: queue`);
  if ('store' in document) applySqliteSection(config.store, document.store, `${path}: store`);
  if ('redaction' in document) applyRedaction(config, document.redaction, `${path}: redaction`);
}

function applyOverrides(config: McprelayConfig, overrides: ConfigOverrides | undefined): void {
  if (overrides?.timeoutMs !== undefined) config.reliability.timeoutMs = overrides.timeoutMs;
  if (overrides?.maxAttempts !== undefined) {
    config.reliability.retry.maxAttempts = overrides.maxAttempts;
  }
}

/**
 * Loads the config as three explicit steps: safe defaults, then the file (if
 * present), then CLI overrides.
 */
export function loadConfig(
  options: { path?: string; cwd?: string; overrides?: ConfigOverrides } = {},
): McprelayConfig {
  const { path, required } = resolveConfigPath(options);
  const config = defaultConfig();
  const text = readConfigText(path);

  if (text === undefined) {
    if (required) throw new ConfigError(`${path}: config file not found`);
  } else {
    const document = parseConfigDocument(text, path);
    if (document !== undefined) applyConfigDocument(config, document, path);
  }

  applyOverrides(config, options.overrides);
  return config;
}

import { createHash } from 'node:crypto';

/** Default key patterns redacted before persistence (NFR-4). */
export const DEFAULT_REDACTION_PATTERNS: readonly string[] = [
  'api_key',
  'token',
  'password',
  'authorization',
  'secret',
  'credential',
];

/** Marker stored in place of a redacted value. */
export const REDACTED = '[REDACTED]';

const CIRCULAR = '[Circular]';

function matchesPattern(key: string, patterns: readonly string[]): boolean {
  const lower = key.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/**
 * Recursively replaces values whose key matches a redaction pattern.
 * Arrays keep their shape; cycles are cut off with a marker.
 */
export function redactValue(
  value: unknown,
  patterns: readonly string[],
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, patterns, seen));
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    result[key] = matchesPattern(key, patterns) ? REDACTED : redactValue(entry, patterns, seen);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegexSource(pattern: string): string {
  return escapeRegExp(pattern).replace(/[_-]/g, '[_-]?');
}

/**
 * Best-effort masking of `key=value` / `key: value` secrets inside free-text
 * messages (structured payloads use redactValue instead).
 */
export function redactMessage(message: string, patterns: readonly string[]): string {
  let result = message;
  for (const pattern of patterns) {
    const source = patternToRegexSource(pattern);
    const regex = new RegExp(`(${source})\\s*[:=]\\s*\\S+`, 'gi');
    result = result.replace(regex, `$1=${REDACTED}`);
  }
  return result;
}

/** Stable JSON with object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const source = value as Record<string, unknown>;
  const entries = Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`);
  return `{${entries.join(',')}}`;
}

/** sha256 over the canonical serialization of the RAW arguments (NFR-4). */
export function hashArguments(rawArguments: unknown): string {
  return createHash('sha256').update(canonicalJson(rawArguments)).digest('hex');
}

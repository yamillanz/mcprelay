/** Policy configuration error: message always names the rule path and field. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** Longest accepted regex pattern (FR-Y6: bounded matching work). */
export const MAX_PATTERN_LENGTH = 200;
/** Longest accepted matched value; longer values never match (FR-Y6). */
export const MAX_MATCH_INPUT_LENGTH = 4096;

export type Matcher =
  | { kind: 'equals'; value: unknown }
  | { kind: 'in'; values: unknown[] }
  | { kind: 'prefix'; value: string }
  | { kind: 'regex'; source: string; regex: RegExp }
  | { kind: 'max_length'; value: number }
  | { kind: 'min'; value: number }
  | { kind: 'max'; value: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep JSON equality (objects, arrays, primitives). */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

/** Walks a dot-separated path through objects (by key) and arrays (by index). */
export function getPath(root: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a tool-name glob (`*`, `?`) into an anchored regex. */
export function globToRegex(pattern: string): RegExp {
  let source = '';
  for (const character of pattern) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += escapeRegExp(character);
  }
  return new RegExp(`^${source}$`);
}

interface GroupFrame {
  hasQuantifier: boolean;
  alternatives: string[];
  currentAlternative: string | undefined;
}

function alternationIsAmbiguous(alternatives: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const first of alternatives) {
    if (first === '' || first === '*') return true;
    if (seen.has(first)) return true;
    seen.add(first);
  }
  return false;
}

/**
 * ReDoS heuristic (FR-Y6): flags quantified groups that themselves contain a
 * quantifier (nested repetition) or an ambiguous alternation. Conservative by
 * design: some safe patterns are rejected, dangerous ones are not executed.
 */
function findRedosRisk(pattern: string): string | undefined {
  const frames: GroupFrame[] = [];
  let inClass = false;
  let pendingGroupRisk: string | undefined;

  const noteAtom = (first: string): void => {
    const frame = frames.at(-1);
    if (frame !== undefined && frame.currentAlternative === undefined) {
      frame.currentAlternative = first;
    }
  };
  const pushAlternative = (frame: GroupFrame): void => {
    frame.alternatives.push(frame.currentAlternative ?? '');
    frame.currentAlternative = undefined;
  };

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;

    if (character === '\\') {
      noteAtom('*');
      index += 1;
      pendingGroupRisk = undefined;
      continue;
    }
    if (inClass) {
      if (character === ']') inClass = false;
      continue;
    }
    if (character === '[') {
      inClass = true;
      noteAtom('*');
      pendingGroupRisk = undefined;
      continue;
    }
    if (character === '(') {
      frames.push({ hasQuantifier: false, alternatives: [], currentAlternative: undefined });
      if (pattern[index + 1] === '?') {
        index += 1;
        if (pattern[index + 1] === '<') {
          const nameEnd = pattern.indexOf('>', index);
          if (nameEnd > index) index = nameEnd;
        }
      }
      pendingGroupRisk = undefined;
      continue;
    }
    if (character === ')') {
      const frame = frames.pop();
      if (frame !== undefined) {
        pushAlternative(frame);
        if (frame.hasQuantifier) pendingGroupRisk = 'nested quantifier';
        else if (frame.alternatives.length > 1 && alternationIsAmbiguous(frame.alternatives)) {
          pendingGroupRisk = 'ambiguous alternation';
        } else pendingGroupRisk = undefined;
      }
      continue;
    }
    if (character === '|') {
      const frame = frames.at(-1);
      if (frame !== undefined) pushAlternative(frame);
      pendingGroupRisk = undefined;
      continue;
    }
    if (character === '*' || character === '+' || character === '?') {
      if (pendingGroupRisk !== undefined) return pendingGroupRisk;
      const frame = frames.at(-1);
      if (frame !== undefined) frame.hasQuantifier = true;
      pendingGroupRisk = undefined;
      continue;
    }
    if (character === '{') {
      const close = pattern.indexOf('}', index);
      if (close > index) {
        if (pendingGroupRisk !== undefined) return pendingGroupRisk;
        const frame = frames.at(-1);
        if (frame !== undefined) frame.hasQuantifier = true;
        index = close;
        pendingGroupRisk = undefined;
        continue;
      }
    }
    noteAtom(character === '.' ? '*' : character);
    pendingGroupRisk = undefined;
  }
  return undefined;
}

function compileRegex(pattern: string, label: string): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new PolicyError(
      `${label}.regex: pattern exceeds ${MAX_PATTERN_LENGTH} characters (FR-Y6)`,
    );
  }
  const risk = findRedosRisk(pattern);
  if (risk !== undefined) {
    throw new PolicyError(
      `${label}.regex: pattern rejected (${risk}); rewrite it without repetition`,
    );
  }
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new PolicyError(
      `${label}.regex: invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Compiles one path's matcher mapping; multiple matchers on a path are ANDed. */
export function compilePathMatchers(raw: unknown, label: string): Matcher[] {
  if (!isRecord(raw)) throw new PolicyError(`${label}: expected a mapping of matchers`);
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new PolicyError(`${label}: expected at least one matcher`);

  const matchers: Matcher[] = [];
  for (const key of keys) {
    const value = raw[key];
    switch (key) {
      case 'equals':
        matchers.push({ kind: 'equals', value });
        break;
      case 'in':
        if (!Array.isArray(value) || value.length === 0) {
          throw new PolicyError(`${label}.in: expected a non-empty array`);
        }
        matchers.push({ kind: 'in', values: value });
        break;
      case 'prefix':
        if (typeof value !== 'string' || value.length === 0) {
          throw new PolicyError(`${label}.prefix: expected a non-empty string`);
        }
        matchers.push({ kind: 'prefix', value });
        break;
      case 'regex':
        if (typeof value !== 'string' || value.length === 0) {
          throw new PolicyError(`${label}.regex: expected a non-empty string`);
        }
        matchers.push({ kind: 'regex', source: value, regex: compileRegex(value, label) });
        break;
      case 'max_length':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          throw new PolicyError(`${label}.max_length: expected an integer >= 0`);
        }
        matchers.push({ kind: 'max_length', value });
        break;
      case 'min':
      case 'max':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new PolicyError(`${label}.${key}: expected a finite number`);
        }
        matchers.push({ kind: key, value });
        break;
      default:
        throw new PolicyError(`${label}.${key}: not a recognized matcher`);
    }
  }
  return matchers;
}

/** Evaluates one matcher against one argument value (missing values are handled by callers). */
export function matcherMatches(matcher: Matcher, value: unknown): boolean {
  switch (matcher.kind) {
    case 'equals':
      return deepEqual(value, matcher.value);
    case 'in':
      return matcher.values.some((entry) => deepEqual(value, entry));
    case 'prefix':
      return (
        typeof value === 'string' &&
        value.length <= MAX_MATCH_INPUT_LENGTH &&
        value.startsWith(matcher.value)
      );
    case 'regex':
      return (
        typeof value === 'string' &&
        value.length <= MAX_MATCH_INPUT_LENGTH &&
        matcher.regex.test(value)
      );
    case 'max_length':
      return (typeof value === 'string' || Array.isArray(value)) && value.length <= matcher.value;
    case 'min':
      return typeof value === 'number' && Number.isFinite(value) && value >= matcher.value;
    case 'max':
      return typeof value === 'number' && Number.isFinite(value) && value <= matcher.value;
  }
}

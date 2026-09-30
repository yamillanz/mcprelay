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

interface ScanState {
  frames: GroupFrame[];
  inClass: boolean;
  /** Risk found on the group that just closed; applied when a quantifier follows. */
  pendingGroupRisk: string | undefined;
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

/** Records the first character of the atom that starts the current alternative. */
function noteAtom(state: ScanState, firstCharacter: string): void {
  const frame = state.frames.at(-1);
  if (frame !== undefined && frame.currentAlternative === undefined) {
    frame.currentAlternative = firstCharacter;
  }
}

function pushAlternative(frame: GroupFrame): void {
  frame.alternatives.push(frame.currentAlternative ?? '');
  frame.currentAlternative = undefined;
}

function startAlternative(state: ScanState): void {
  const frame = state.frames.at(-1);
  if (frame !== undefined) pushAlternative(frame);
}

/** Advances past `(?` and a `(?<name>` group name; returns the last index consumed. */
function skipGroupPrefix(pattern: string, index: number): number {
  if (pattern[index + 1] !== '?') return index;
  const questionIndex = index + 1;
  if (pattern[questionIndex + 1] !== '<') return questionIndex;
  const nameEnd = pattern.indexOf('>', questionIndex);
  return nameEnd > questionIndex ? nameEnd : questionIndex;
}

function openGroup(state: ScanState, pattern: string, index: number): number {
  state.frames.push({ hasQuantifier: false, alternatives: [], currentAlternative: undefined });
  state.pendingGroupRisk = undefined;
  return skipGroupPrefix(pattern, index);
}

function closeGroup(state: ScanState): void {
  const frame = state.frames.pop();
  if (frame === undefined) return;
  pushAlternative(frame);
  if (frame.hasQuantifier) {
    state.pendingGroupRisk = 'nested quantifier';
  } else if (frame.alternatives.length > 1 && alternationIsAmbiguous(frame.alternatives)) {
    state.pendingGroupRisk = 'ambiguous alternation';
  } else {
    state.pendingGroupRisk = undefined;
  }
}

/** Consumes a quantifier; returns the risk it closes when the quantified atom was risky. */
function applyQuantifier(state: ScanState): string | undefined {
  if (state.pendingGroupRisk !== undefined) return state.pendingGroupRisk;
  const frame = state.frames.at(-1);
  if (frame !== undefined) frame.hasQuantifier = true;
  return undefined;
}

/**
 * ReDoS heuristic (FR-Y6): flags quantified groups that themselves contain a
 * quantifier (nested repetition) or an ambiguous alternation. Conservative by
 * design: some safe patterns are rejected, dangerous ones are not executed.
 * One case per character kind; all state lives in `ScanState`.
 */
function findRedosRisk(pattern: string): string | undefined {
  const state: ScanState = { frames: [], inClass: false, pendingGroupRisk: undefined };

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;

    // Escape and class content come first: `\` also escapes inside a class,
    // and only an unescaped `]` closes one.
    if (character === '\\') {
      noteAtom(state, '*');
      index += 1;
      state.pendingGroupRisk = undefined;
      continue;
    }
    if (state.inClass) {
      if (character === ']') state.inClass = false;
      continue;
    }

    switch (character) {
      case '[':
        state.inClass = true;
        noteAtom(state, '*');
        break;
      case '(':
        index = openGroup(state, pattern, index);
        break;
      case ')':
        closeGroup(state);
        continue; // closeGroup owns pendingGroupRisk; the shared reset must not clear it
      case '|':
        startAlternative(state);
        break;
      case '*':
      case '+':
      case '?': {
        const risk = applyQuantifier(state);
        if (risk !== undefined) return risk;
        break;
      }
      case '{': {
        const close = pattern.indexOf('}', index);
        if (close > index) {
          const risk = applyQuantifier(state);
          if (risk !== undefined) return risk;
          index = close;
          break;
        }
        noteAtom(state, '{');
        break;
      }
      default:
        noteAtom(state, character === '.' ? '*' : character);
        break;
    }
    state.pendingGroupRisk = undefined;
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

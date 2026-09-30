import {
  PolicyError,
  compilePathMatchers,
  getPath,
  globToRegex,
  matcherMatches,
  type Matcher,
} from './matchers.js';

export { PolicyError } from './matchers.js';

export type PolicyAction = 'allow' | 'deny';

export interface CompiledRule {
  tool: string;
  toolRegex: RegExp;
  caller?: string;
  args: Array<{ path: string; matchers: Matcher[] }>;
  action: PolicyAction;
  specificity: number;
}

export interface PolicyConfig {
  default: PolicyAction;
  rules: CompiledRule[];
}

export interface PolicyCall {
  tool: string;
  arguments: unknown;
  caller?: string;
}

export interface PolicyDecision {
  action: PolicyAction;
  /** 1-based rule number from the file, or null when the default action applied. */
  rule: number | null;
  reason: string;
}

export function defaultPolicyConfig(): PolicyConfig {
  return { default: 'allow', rules: [] };
}

const POLICY_KEYS = new Set(['default', 'rules']);
const RULE_KEYS = new Set(['tool', 'caller', 'args', 'action']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseAction(value: unknown, label: string): PolicyAction {
  if (value !== 'allow' && value !== 'deny') {
    throw new PolicyError(`${label}: expected 'allow' or 'deny', got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseRuleArgs(raw: unknown, label: string): Array<{ path: string; matchers: Matcher[] }> {
  if (!isRecord(raw)) throw new PolicyError(`${label}: expected a mapping of argument paths`);
  return Object.entries(raw).map(([path, spec]) => {
    if (path.length === 0) throw new PolicyError(`${label}: argument path must not be empty`);
    return { path, matchers: compilePathMatchers(spec, `${label}.${path}`) };
  });
}

/**
 * Specificity score (FR-Y1): exact tool +2 / glob +1, caller +1, each argument
 * matcher +1. Highest score wins; ties are broken by file order.
 */
function parseRule(raw: unknown, label: string): CompiledRule {
  if (!isRecord(raw)) throw new PolicyError(`${label}: expected a mapping`);
  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) throw new PolicyError(`${label}.${key}: not a recognized rule field`);
  }
  if (typeof raw.tool !== 'string' || raw.tool.length === 0) {
    throw new PolicyError(`${label}.tool: expected a non-empty string`);
  }
  if (!('action' in raw)) {
    throw new PolicyError(`${label}.action: expected 'allow' or 'deny'`);
  }
  const action = parseAction(raw.action, `${label}.action`);

  let caller: string | undefined;
  if ('caller' in raw) {
    if (typeof raw.caller !== 'string' || raw.caller.length === 0) {
      throw new PolicyError(`${label}.caller: expected a non-empty string`);
    }
    caller = raw.caller;
  }

  const args = 'args' in raw ? parseRuleArgs(raw.args, `${label}.args`) : [];
  const argMatcherCount = args.reduce((total, entry) => total + entry.matchers.length, 0);
  const toolScore = raw.tool.includes('*') || raw.tool.includes('?') ? 1 : 2;

  return {
    tool: raw.tool,
    toolRegex: globToRegex(raw.tool),
    ...(caller === undefined ? {} : { caller }),
    args,
    action,
    specificity: toolScore + (caller === undefined ? 0 : 1) + argMatcherCount,
  };
}

/** Parses the `policy` config section; every error names the rule path and field. */
export function parsePolicyConfig(raw: unknown, label: string): PolicyConfig {
  if (!isRecord(raw)) throw new PolicyError(`${label}: expected a mapping`);
  for (const key of Object.keys(raw)) {
    if (!POLICY_KEYS.has(key)) throw new PolicyError(`${label}.${key}: not a recognized setting`);
  }

  const defaultAction = 'default' in raw ? parseAction(raw.default, `${label}.default`) : 'allow';

  let rules: CompiledRule[] = [];
  if ('rules' in raw) {
    if (!Array.isArray(raw.rules)) throw new PolicyError(`${label}.rules: expected a list`);
    rules = raw.rules.map((entry, index) => parseRule(entry, `${label}.rules[${index}]`));
  }
  return { default: defaultAction, rules };
}

function ruleMatches(rule: CompiledRule, call: PolicyCall, caller: string): boolean {
  if (!rule.toolRegex.test(call.tool)) return false;
  if (rule.caller !== undefined && rule.caller !== caller) return false;
  for (const entry of rule.args) {
    const found = getPath(call.arguments, entry.path);
    if (!found.found) return false;
    if (!entry.matchers.every((matcher) => matcherMatches(matcher, found.value))) return false;
  }
  return true;
}

/** Resolves the decision for one hypothetical or real call (FR-Y1). */
export function evaluateCall(policy: PolicyConfig, call: PolicyCall): PolicyDecision {
  const caller = call.caller ?? 'local';
  let best: { rule: CompiledRule; index: number } | undefined;

  for (let index = 0; index < policy.rules.length; index += 1) {
    const rule = policy.rules[index] as CompiledRule;
    if (!ruleMatches(rule, call, caller)) continue;
    // Strictly greater: equal specificity keeps the earlier rule (file order).
    if (best === undefined || rule.specificity > best.rule.specificity) best = { rule, index };
  }

  if (best !== undefined) {
    const number = best.index + 1;
    return {
      action: best.rule.action,
      rule: number,
      reason: `matched rule #${number} (tool '${best.rule.tool}')`,
    };
  }
  return {
    action: policy.default,
    rule: null,
    reason: `no rule matched; default action '${policy.default}'`,
  };
}

import { loadConfig, type McprelayConfig } from '../config/config.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { createPersistence, type Persistence } from '../queue/providers.js';
import { evaluateCall, type PolicyDecision } from './policy.js';

export interface PolicyIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const POLICY_USAGE =
  'Usage: mcprelay policy test [--tool <name>] [--args <json>] [--caller <id>] [--id <failure-id>] [--config <path>] [--json]';

interface PolicyTestOptions {
  configPath?: string;
  tool?: string;
  args?: string;
  caller?: string;
  id?: string;
  json: boolean;
}

type ParsedPolicyTest = { ok: true; options: PolicyTestOptions } | { ok: false; message: string };

function parsePolicyTestTokens(tokens: readonly string[]): ParsedPolicyTest {
  const options: PolicyTestOptions = { json: false };
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index] as string;
    switch (token) {
      case '--config':
      case '--tool':
      case '--args':
      case '--caller':
      case '--id': {
        const value = tokens[index + 1];
        if (value === undefined) return { ok: false, message: `Missing value for '${token}'.` };
        if (token === '--config') options.configPath = value;
        if (token === '--tool') options.tool = value;
        if (token === '--args') options.args = value;
        if (token === '--caller') options.caller = value;
        if (token === '--id') options.id = value;
        index += 2;
        break;
      }
      case '--json':
        options.json = true;
        index += 1;
        break;
      default:
        return { ok: false, message: `Unknown option '${token}'.` };
    }
  }

  if (options.id === undefined && options.tool === undefined) {
    return {
      ok: false,
      message: 'Missing call to evaluate: pass --tool (with optional --args) or --id.',
    };
  }
  return { ok: true, options };
}

function usageError(io: PolicyIO, message: string): number {
  io.stderr(`${message}\n${POLICY_USAGE}\n`);
  return EXIT_USAGE;
}

function loadPolicyConfig(
  configPath: string | undefined,
  io: PolicyIO,
): McprelayConfig | undefined {
  try {
    const config = loadConfig(configPath === undefined ? {} : { path: configPath });
    for (const warning of config.warnings) io.stderr(`mcprelay: warning: ${warning}\n`);
    return config;
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

/** Resolves the call to evaluate from a stored failure record (FR-Y3). */
async function loadStoredCall(
  config: McprelayConfig,
  id: string,
  io: PolicyIO,
): Promise<{ tool: string; arguments: unknown } | undefined> {
  let persistence: Persistence;
  try {
    persistence = createPersistence(config);
    persistence.getQueue();
  } catch (error) {
    io.stderr(
      `mcprelay: cannot open the queue provider: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
  try {
    const record = await persistence.getQueue().get(id);
    if (record === null) {
      io.stderr(`mcprelay: failure record '${id}' not found\n`);
      return undefined;
    }
    return { tool: record.tool.name, arguments: record.tool.arguments };
  } finally {
    await persistence.close();
  }
}

function formatDecision(
  tool: string,
  caller: string,
  decision: PolicyDecision,
  json: boolean,
): string {
  if (json) {
    return `${JSON.stringify({
      tool,
      caller,
      decision: decision.action,
      rule: decision.rule,
      reason: decision.reason,
    })}\n`;
  }
  return (
    `tool:     ${tool}\n` +
    `caller:   ${caller}\n` +
    `decision: ${decision.action}\n` +
    `rule:     ${decision.rule === null ? 'none (default policy)' : `#${decision.rule}`}\n` +
    `reason:   ${decision.reason}\n`
  );
}

/** `mcprelay policy test`: evaluates one call against the policy, never enforces (FR-Y3). */
export async function runPolicy(tokens: readonly string[], io: PolicyIO): Promise<number> {
  const subcommand = tokens[0];
  if (subcommand !== 'test') {
    return usageError(
      io,
      subcommand === undefined
        ? 'Missing policy subcommand.'
        : `Unknown policy subcommand '${subcommand}'.`,
    );
  }

  const parsed = parsePolicyTestTokens(tokens.slice(1));
  if (!parsed.ok) return usageError(io, parsed.message);
  const { configPath, tool, args, caller, id, json } = parsed.options;

  const config = loadPolicyConfig(configPath, io);
  if (config === undefined) return EXIT_USAGE;

  let resolvedTool: string;
  let resolvedArguments: unknown;
  if (id !== undefined) {
    const stored = await loadStoredCall(config, id, io);
    if (stored === undefined) return EXIT_FAILURE;
    resolvedTool = stored.tool;
    resolvedArguments = stored.arguments;
  } else if (tool !== undefined) {
    resolvedTool = tool;
    if (args !== undefined) {
      try {
        resolvedArguments = JSON.parse(args);
      } catch {
        return usageError(io, `Invalid --args JSON: ${args}`);
      }
    } else {
      resolvedArguments = {};
    }
  } else {
    return usageError(io, 'Missing call to evaluate: pass --tool (with optional --args) or --id.');
  }

  const resolvedCaller = caller ?? 'local';
  const decision = evaluateCall(config.policy, {
    tool: resolvedTool,
    arguments: resolvedArguments,
    caller: resolvedCaller,
  });
  io.stdout(formatDecision(resolvedTool, resolvedCaller, decision, json));
  return EXIT_OK;
}

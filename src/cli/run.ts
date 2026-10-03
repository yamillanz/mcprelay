import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { loadConfig } from '../config/config.js';
import { runPolicy } from '../policy/policy-cli.js';
import { runProxy, type ProxyInvocation } from '../proxy/run.js';
import { runReplay } from '../replay/replay-cli.js';
import { packageVersion } from '../version.js';

export { EXIT_OK, EXIT_USAGE };

/** Output sinks, injected so the CLI is testable without spawning a process. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const HELP = `mcprelay — the reliability layer for MCP tool calls

Usage:
  mcprelay <command> [options]

Commands:
  run        Wrap a stdio MCP server: mcprelay run [options] -- <server command…>
             (also: mcprelay [options] -- <server command…>)
  replay     Inspect the dead-letter queue: replay list | replay inspect <id>
  policy     Inspect policy decisions: policy test [--tool X --args JSON | --id <id>]
  validate   Check the configuration and report precise errors
  version    Print the mcprelay version
  help       Show this help

Run options:
  --config <path>       Config file (default ./mcprelay.config.yaml)
  --timeout-ms <ms>     Per-call timeout; overrides the config file
  --max-attempts <n>    Retry bound; overrides the config file
  --policy-dry-run      Report policy decisions without enforcing them
  --http <url>          Wrap a remote Streamable HTTP server instead of a
                        local command (config: upstream.http.headers)

Options:
  -h, --help      Show this help
  -v, --version   Print the mcprelay version

Exit codes:
  0  success (clean session)
  1  the command ran but failed (record not found, database error)
  2  usage or configuration error
  3  upstream failure (the wrapped server exited unexpectedly)

Status: M5 — declarative policy (allow/deny by tool, caller, and arguments;
dry-run and denial audit). HTTP transport lands next — see docs/PRD.md §12.
`;

interface RunInvocation {
  httpUrl?: string;
  command?: string;
  args: string[];
  configPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  policyDryRun?: boolean;
}

type ParsedRun = { ok: true; invocation: RunInvocation } | { ok: false; message: string };

const RUN_USAGE =
  'Usage: mcprelay run [options] -- <server command…>  |  mcprelay run [options] --http <url>';

function parseRunInvocation(tokens: readonly string[]): ParsedRun {
  let configPath: string | undefined;
  let timeoutMs: number | undefined;
  let maxAttempts: number | undefined;
  let policyDryRun: boolean | undefined;
  let httpUrl: string | undefined;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || token === '--') break;
    if (token === '--policy-dry-run') {
      policyDryRun = true;
      index += 1;
      continue;
    }
    if (token === '--http') {
      const value = tokens[index + 1];
      if (value === undefined) return { ok: false, message: "Missing value for '--http'." };
      try {
        new URL(value);
      } catch {
        return { ok: false, message: `Invalid URL for '--http': ${value}` };
      }
      httpUrl = value;
      index += 2;
      continue;
    }
    if (token === '--config' || token === '--timeout-ms' || token === '--max-attempts') {
      const value = tokens[index + 1];
      if (value === undefined) return { ok: false, message: `Missing value for '${token}'.` };
      if (token === '--config') {
        configPath = value;
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return { ok: false, message: `Invalid value for '${token}': ${value}` };
        }
        if (token === '--timeout-ms') timeoutMs = parsed;
        else maxAttempts = parsed;
      }
      index += 2;
      continue;
    }
    return { ok: false, message: `Unknown option '${token}'.` };
  }

  if (httpUrl !== undefined) {
    if (tokens[index] === '--') {
      return {
        ok: false,
        message: "Use either '--http <url>' or '-- <server command…>', not both.",
      };
    }
    return {
      ok: true,
      invocation: {
        httpUrl,
        args: [],
        ...(configPath === undefined ? {} : { configPath }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        ...(policyDryRun === undefined ? {} : { policyDryRun }),
      },
    };
  }

  if (tokens[index] !== '--' || tokens[index + 1] === undefined) {
    return { ok: false, message: RUN_USAGE };
  }

  return {
    ok: true,
    invocation: {
      command: tokens[index + 1] as string,
      args: tokens.slice(index + 2),
      ...(configPath === undefined ? {} : { configPath }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      ...(policyDryRun === undefined ? {} : { policyDryRun }),
    },
  };
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`${message}\nRun 'mcprelay --help' for usage.\n`);
  return EXIT_USAGE;
}

async function runValidate(tokens: readonly string[], io: CliIO): Promise<number> {
  let configPath: string | undefined;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--config') {
      const value = tokens[index + 1];
      if (value === undefined) return usageError(io, "Missing value for '--config'.");
      configPath = value;
      index += 2;
      continue;
    }
    return usageError(io, `Unknown option '${token}'.`);
  }

  try {
    const config = loadConfig(configPath === undefined ? {} : { path: configPath });
    for (const warning of config.warnings) io.stderr(`mcprelay: warning: ${warning}\n`);
    io.stdout(`config ok: ${configPath ?? 'defaults (no mcprelay.config.yaml)'}\n`);
    return EXIT_OK;
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
}

async function runWith(tokens: readonly string[], io: CliIO): Promise<number> {
  const parsed = parseRunInvocation(tokens);
  if (!parsed.ok) return usageError(io, parsed.message);
  const { httpUrl, command, args, configPath, timeoutMs, maxAttempts, policyDryRun } =
    parsed.invocation;
  const invocation: ProxyInvocation =
    httpUrl !== undefined
      ? { kind: 'http', url: httpUrl }
      : { kind: 'stdio', command: command as string, args };
  return runProxy(invocation, io, {
    ...(configPath === undefined ? {} : { configPath }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(policyDryRun === undefined ? {} : { policyDryRun }),
  });
}

/**
 * Runs one CLI invocation and resolves with the process exit code.
 * argv excludes the node binary and script path.
 */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;

  if (rest.length > 0 && command === 'version') {
    return usageError(io, `Unexpected argument '${rest[0]}' after 'version'.`);
  }

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(HELP);
    return EXIT_OK;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    io.stdout(`${packageVersion()}\n`);
    return EXIT_OK;
  }

  if (command === 'validate') {
    return runValidate(rest, io);
  }

  if (command === 'replay') {
    return runReplay(rest, io);
  }

  if (command === 'policy') {
    return runPolicy(rest, io);
  }

  if (
    command === 'run' ||
    command === '--' ||
    command === '--config' ||
    command === '--timeout-ms' ||
    command === '--max-attempts' ||
    command === '--policy-dry-run' ||
    command === '--http'
  ) {
    return runWith(command === 'run' ? rest : argv, io);
  }

  if (command.startsWith('-')) {
    return usageError(io, `Unknown option '${command}'.`);
  }

  return usageError(io, `Unknown command '${command}'.`);
}

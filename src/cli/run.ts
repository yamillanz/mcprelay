import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { runProxy } from '../proxy/run.js';
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
  version    Print the mcprelay version
  help       Show this help

Run options:
  --config <path>       Config file (default ./mcprelay.config.yaml)
  --timeout-ms <ms>     Per-call timeout; overrides the config file
  --max-attempts <n>    Retry bound; overrides the config file

Options:
  -h, --help      Show this help
  -v, --version   Print the mcprelay version

Exit codes:
  0  success (clean session)
  2  usage or configuration error
  3  upstream failure (the wrapped server exited unexpectedly)

Status: M2 — transparent stdio proxy with timeout, classified retries, and
structured call logs. Policy, DLQ, and replay land in later milestones — see
docs/PRD.md §12.
`;

interface RunInvocation {
  command: string;
  args: string[];
  configPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

type ParsedRun = { ok: true; invocation: RunInvocation } | { ok: false; message: string };

const RUN_USAGE = 'Usage: mcprelay run [options] -- <server command…>';

function parseRunInvocation(tokens: readonly string[]): ParsedRun {
  let configPath: string | undefined;
  let timeoutMs: number | undefined;
  let maxAttempts: number | undefined;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || token === '--') break;
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
    },
  };
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`${message}\nRun 'mcprelay --help' for usage.\n`);
  return EXIT_USAGE;
}

async function runWith(tokens: readonly string[], io: CliIO): Promise<number> {
  const parsed = parseRunInvocation(tokens);
  if (!parsed.ok) return usageError(io, parsed.message);
  const { command, args, configPath, timeoutMs, maxAttempts } = parsed.invocation;
  return runProxy(command, args, io, {
    ...(configPath === undefined ? {} : { configPath }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
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

  if (
    command === 'run' ||
    command === '--' ||
    command === '--config' ||
    command === '--timeout-ms' ||
    command === '--max-attempts'
  ) {
    return runWith(command === 'run' ? rest : argv, io);
  }

  if (command.startsWith('-')) {
    return usageError(io, `Unknown option '${command}'.`);
  }

  return usageError(io, `Unknown command '${command}'.`);
}

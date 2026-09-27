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
  run        Wrap a stdio MCP server: mcprelay run -- <server command…>
             (also: mcprelay -- <server command…>)
  version    Print the mcprelay version
  help       Show this help

Options:
  -h, --help      Show this help
  -v, --version   Print the mcprelay version

Exit codes:
  0  success (clean session)
  2  usage error
  3  upstream failure (the wrapped server exited unexpectedly)

Status: M1 — transparent stdio proxy with structured call logs. Policy,
retry, DLQ, and replay land in later milestones — see docs/PRD.md §12.
`;

function usageError(io: CliIO, message: string): number {
  io.stderr(`${message}\nRun 'mcprelay --help' for usage.\n`);
  return EXIT_USAGE;
}

async function runWith(rest: readonly string[], io: CliIO): Promise<number> {
  const separator = rest[0];
  const serverCommand = rest[1];
  if (separator !== '--' || serverCommand === undefined) {
    return usageError(io, 'Usage: mcprelay run -- <server command…>');
  }
  return runProxy(serverCommand, rest.slice(2), io);
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

  if (command === 'run' || command === '--') {
    return runWith(command === 'run' ? rest : argv, io);
  }

  if (command.startsWith('-')) {
    return usageError(io, `Unknown option '${command}'.`);
  }

  return usageError(io, `Unknown command '${command}'.`);
}

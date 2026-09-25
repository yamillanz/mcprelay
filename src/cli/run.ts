import { readFileSync } from 'node:fs';

/** Process exit code for successful runs. */
export const EXIT_OK = 0;

/** Process exit code for usage errors (unknown command or option). */
export const EXIT_USAGE = 2;

/** Output sinks, injected so the CLI is testable without spawning a process. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const HELP = `mcprelay — the reliability layer for MCP tool calls

Usage:
  mcprelay <command> [options]

Commands:
  version   Print the mcprelay version
  help      Show this help

Options:
  -h, --help      Show this help
  -v, --version   Print the mcprelay version

Exit codes:
  0  success
  2  usage error

Status: M0 scaffold. The proxy, retry pipeline, DLQ, and replay commands land
in later milestones — see docs/PRD.md §12.
`;

function packageVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`${message}\nRun 'mcprelay --help' for usage.\n`);
  return EXIT_USAGE;
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

  if (command.startsWith('-')) {
    return usageError(io, `Unknown option '${command}'.`);
  }

  return usageError(io, `Unknown command '${command}'.`);
}

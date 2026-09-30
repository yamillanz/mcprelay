import { EXIT_OK, EXIT_UPSTREAM, EXIT_USAGE } from '../exit-codes.js';
import { loadConfig, type McprelayConfig } from '../config/config.js';
import { CallLogger } from '../observability/call-log.js';
import { packageVersion } from '../version.js';
import { startBridge } from './bridge.js';

export interface ProxyIO {
  stderr(text: string): void;
}

export interface ProxyOptions {
  configPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  policyDryRun?: boolean;
}

/**
 * Wraps one upstream stdio server for the current process session.
 * Returns the process exit code: 0 for a clean session, 2 for a configuration
 * error, 3 when the upstream died.
 */
export async function runProxy(
  command: string,
  args: readonly string[],
  io: ProxyIO,
  options: ProxyOptions = {},
): Promise<number> {
  let config: McprelayConfig;
  try {
    config = loadConfig({
      ...(options.configPath === undefined ? {} : { path: options.configPath }),
      overrides: {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        ...(options.policyDryRun === undefined ? {} : { policyDryRun: options.policyDryRun }),
      },
    });
  } catch (error) {
    io.stderr(`mcprelay: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
  for (const warning of config.warnings) io.stderr(`mcprelay: warning: ${warning}\n`);

  const logger = new CallLogger(io.stderr);
  let bridge;
  try {
    bridge = await startBridge({
      command,
      args,
      logger,
      stderr: io.stderr,
      version: packageVersion(),
      config,
    });
  } catch (error) {
    io.stderr(
      `mcprelay: failed to start upstream: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_UPSTREAM;
  }

  const side = await bridge.closed;
  // Let in-flight error responses flush to the client before tearing down.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await bridge.close();
  return side === 'upstream' ? EXIT_UPSTREAM : EXIT_OK;
}

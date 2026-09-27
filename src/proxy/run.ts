import { EXIT_OK, EXIT_UPSTREAM } from '../exit-codes.js';
import { CallLogger } from '../observability/call-log.js';
import { packageVersion } from '../version.js';
import { startBridge } from './bridge.js';

export interface ProxyIO {
  stderr(text: string): void;
}

/**
 * Wraps one upstream stdio server for the current process session.
 * Returns the process exit code: 0 for a clean session, 3 when the
 * upstream died.
 */
export async function runProxy(
  command: string,
  args: readonly string[],
  io: ProxyIO,
): Promise<number> {
  const logger = new CallLogger(io.stderr);
  let bridge;
  try {
    bridge = await startBridge({
      command,
      args,
      logger,
      stderr: io.stderr,
      version: packageVersion(),
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

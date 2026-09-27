import { readFileSync } from 'node:fs';

/** Reads the version from the published package manifest (single source). */
export function packageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

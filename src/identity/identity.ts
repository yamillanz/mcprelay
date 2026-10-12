import { timingSafeEqual } from 'node:crypto';

export interface IdentityKey {
  key: string;
  identity: string;
}

export interface IdentitySettings {
  profile: string;
  keys: IdentityKey[];
}

export type IdentityResolution = { ok: true; identity: string } | { ok: false; reason: string };

const BEARER = /^Bearer\s+(.+)$/i;

/** Reads the standard bearer credential shape from `_meta` (stdio carrier). */
export function credentialFromMeta(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const value = (meta as Record<string, unknown>).authorization;
  if (typeof value !== 'string') return undefined;
  const match = BEARER.exec(value.trim());
  return match?.[1];
}

function keyEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** One resolution per intercepted call: keyed credential → mapped identity, else the profile. */
export function resolveIdentity(settings: IdentitySettings, meta: unknown): IdentityResolution {
  const credential = credentialFromMeta(meta);
  if (credential !== undefined && settings.keys.length > 0) {
    const match = settings.keys.find((entry) => keyEquals(entry.key, credential));
    if (match === undefined) return { ok: false, reason: 'unrecognized api key' };
    return { ok: true, identity: match.identity };
  }
  return { ok: true, identity: settings.profile };
}

/** Removes credential fields from `_meta` before any relay; every other key survives. */
export function stripCredentialFields(meta: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key.toLowerCase() === 'authorization') continue;
    stripped[key] = value;
  }
  return stripped;
}

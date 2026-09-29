function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `_meta.idempotencyKey`, then an args `idempotency_key` / `idempotencyKey` field. */
export function extractIdempotencyKey(params: {
  _meta?: unknown;
  arguments?: unknown;
}): string | undefined {
  if (isRecord(params._meta)) {
    const fromMeta = params._meta.idempotencyKey;
    if (typeof fromMeta === 'string' || typeof fromMeta === 'number') return String(fromMeta);
  }
  if (isRecord(params.arguments)) {
    for (const field of ['idempotency_key', 'idempotencyKey']) {
      const value = params.arguments[field];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
  }
  return undefined;
}

import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/server';

/** In-memory session context captured from the upstream session (FR-P3). */
export interface SessionContext {
  server: Implementation;
  capabilities: ServerCapabilities;
  protocolRevision?: string;
  instructions?: string;
  toolCount?: number;
}

export function createSessionContext(
  server: Implementation | undefined,
  capabilities: ServerCapabilities | undefined,
  protocolRevision: string | undefined,
  instructions: string | undefined,
  fallbackServer: Implementation,
): SessionContext {
  const context: SessionContext = {
    server: server ?? fallbackServer,
    capabilities: capabilities ?? {},
  };
  if (protocolRevision !== undefined) context.protocolRevision = protocolRevision;
  if (instructions !== undefined) context.instructions = instructions;
  return context;
}

export function recordToolInventory(context: SessionContext, tools: unknown): void {
  if (Array.isArray(tools)) context.toolCount = tools.length;
}

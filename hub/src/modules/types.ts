import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Access a caller has to one section: read tools only, or read and write tools. */
export type Level = "read" | "write";

export interface CallContext {
  /** OAuth subject of the authenticated caller, for audit logging. */
  subject: string;
}

/** One section of the hub: a backend whose tools share a name prefix and an access level. */
export interface HubModule {
  /** Section name used in the access policy and as the tool prefix, e.g. "netbird". */
  name: string;
  /** Guidance for the model, included in the server instructions when the caller can use the section. */
  instructions: string;
  /** Registers this section's tools for one request. Write tools only when `level` is "write". */
  register(server: McpServer, level: Level, ctx: CallContext): void;
}

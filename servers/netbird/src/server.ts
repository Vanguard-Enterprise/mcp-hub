import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerToken, tokensMatch } from "./auth.js";
import type { NetBirdClient } from "./netbird.js";
import { registerTools } from "./tools.js";

export interface ServerConfig {
  /** Token that clients must present as `Authorization: Bearer <token>`. */
  mcpAuthToken: string;
  netbird: NetBirdClient;
}

export const SERVER_INFO = { name: "netbird", version: "0.1.0" };

const INSTRUCTIONS =
  "Read-only view of a NetBird (WireGuard mesh) account via its Management API. " +
  "NetBird has two separate DNS features: nameserver groups are forwarders to upstream resolvers and hold no records, " +
  "while DNS zones hold authoritative records that NetBird answers itself for the zone's distribution groups. " +
  "When a name does not resolve, check both.";

/** Builds the HTTP server. The caller decides where to listen. */
export function createHttpServer(config: ServerConfig): Server {
  return createServer((req, res) => {
    handle(req, res, config).catch((error: unknown) => {
      console.error("request failed:", error instanceof Error ? error.message : error);
      if (!res.headersSent) respond(res, 500, { error: "internal error" });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, config: ServerConfig): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  // Access log: method, path, status only. Headers are never logged.
  res.on("finish", () => console.log(`${new Date().toISOString()} ${req.method} ${path} ${res.statusCode}`));

  if (path === "/healthz") return respond(res, 200, { status: "ok" });
  if (path !== "/mcp") return respond(res, 404, { error: "not found" });

  if (!tokensMatch(bearerToken(req.headers.authorization), config.mcpAuthToken)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="netbird-mcp"');
    return respond(res, 401, { error: "unauthorized" });
  }

  // Stateless mode: a fresh MCP server and transport per request, no sessions to track.
  const mcp = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerTools(mcp, config.netbird);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => void mcp.close());
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

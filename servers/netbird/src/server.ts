import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerToken } from "./auth.js";
import type { NetBirdClient } from "./netbird.js";
import { AuthError, bearerChallenge, protectedResourceMetadata, protectedResourceMetadataUrl, type TokenVerifier } from "./oauth.js";
import { registerTools } from "./tools.js";
import { registerWriteTools } from "./tools-write.js";

export interface ServerConfig {
  verifier: TokenVerifier;
  netbird: NetBirdClient;
}

export const SERVER_INFO = { name: "netbird", version: "0.3.0" };

const INSTRUCTIONS =
  "Access to a NetBird (WireGuard mesh) account via its Management API. Read tools are netbird_list_* and netbird_get_*; " +
  "netbird_create_*, netbird_update_*, and netbird_delete_* change live network configuration, so confirm with the user first " +
  "and read the current object before an update, because updates replace the whole object. " +
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
  const auth = config.verifier.config;
  const log: string[] = [];
  // Access log: method, path, status, and token subject/audience/typ when authenticated. Never headers or tokens.
  res.on("finish", () => console.log(`${new Date().toISOString()} ${req.method} ${path} ${res.statusCode}${log.length ? " " + log.join(" ") : ""}`));

  if (path === "/healthz") return respond(res, 200, { status: "ok" });
  if (path === "/readyz") {
    return config.verifier.ready ? respond(res, 200, { status: "ready" }) : respond(res, 503, { status: "waiting for OIDC discovery" });
  }
  // RFC 9728: both the root form and the path-aware form for /mcp.
  if (path === "/.well-known/oauth-protected-resource" || path === new URL(protectedResourceMetadataUrl(auth.resourceUrl)).pathname) {
    return respond(res, 200, protectedResourceMetadata(auth));
  }
  if (path !== "/mcp") return respond(res, 404, { error: "not found" });

  const token = bearerToken(req.headers.authorization);
  if (token === undefined) {
    res.setHeader("WWW-Authenticate", bearerChallenge(auth));
    return respond(res, 401, { error: "unauthorized", error_description: "bearer token required" });
  }
  let verified;
  try {
    verified = await config.verifier.verify(token);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    if (error.status === 401) {
      res.setHeader("WWW-Authenticate", bearerChallenge(auth, { code: "invalid_token", description: error.message }));
      return respond(res, 401, { error: "invalid_token", error_description: error.message });
    }
    res.setHeader("Retry-After", "5");
    return respond(res, 503, { error: error.code, error_description: error.message });
  }
  log.push(`sub=${verified.subject}`, `aud=${verified.audience.join(",")}`, `typ=${verified.typ}`);

  // Stateless mode: a fresh MCP server and transport per request, no sessions to track.
  const mcp = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerTools(mcp, config.netbird);
  registerWriteTools(mcp, config.netbird, verified.subject);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => void mcp.close());
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

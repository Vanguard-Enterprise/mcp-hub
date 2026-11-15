import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type AccessPolicy, resolveAccess } from "./access.js";
import { bearerToken } from "./auth.js";
import type { HubModule } from "./modules/types.js";
import { AuthError, bearerChallenge, protectedResourceMetadata, protectedResourceMetadataUrl, type TokenVerifier } from "./oauth.js";

export interface ServerConfig {
  verifier: TokenVerifier;
  modules: HubModule[];
  policy: AccessPolicy;
}

export const SERVER_INFO = { name: "mcp-hub", version: "0.4.0" };

const HUB_INSTRUCTIONS =
  "This MCP hub groups several backends into sections; tool names start with the section name. " +
  "Which sections and whether their write tools appear depends on the caller's identity-provider groups. " +
  "hub_whoami shows the caller's groups and access per section.";

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
  // Access log: method, path, status, and for authenticated calls the subject and resolved access. Never headers or tokens.
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
  let subject: string;
  let groups: string[];
  try {
    subject = (await config.verifier.verify(token)).subject;
    groups = await config.verifier.groups(token, subject);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    if (error.status === 401) {
      res.setHeader("WWW-Authenticate", bearerChallenge(auth, { code: "invalid_token", description: error.message }));
      return respond(res, 401, { error: "invalid_token", error_description: error.message });
    }
    res.setHeader("Retry-After", "5");
    return respond(res, 503, { error: error.code, error_description: error.message });
  }
  const access = resolveAccess(config.policy, groups);
  log.push(`sub=${subject}`, `access=${[...access].map(([s, l]) => `${s}:${l}`).join(",") || "none"}`);

  // Stateless mode: a fresh MCP server per request, holding only the tools this caller may use.
  // A tool outside the caller's sections is never registered, so calling it by name fails too.
  const allowed = config.modules.filter((m) => access.has(m.name));
  const instructions = [HUB_INSTRUCTIONS, ...allowed.map((m) => m.instructions)].join("\n\n");
  const mcp = new McpServer(SERVER_INFO, { instructions });
  registerWhoami(mcp, subject, groups, access, config.modules);
  for (const module of allowed) module.register(mcp, access.get(module.name) as "read" | "write", { subject });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => void mcp.close());
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}

function registerWhoami(mcp: McpServer, subject: string, groups: string[], access: Map<string, string>, modules: HubModule[]): void {
  mcp.registerTool(
    "hub_whoami",
    {
      description: "Show the caller's identity-provider groups and their access (none, read, or write) to each hub section.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ subject, groups, sections: Object.fromEntries(modules.map((m) => [m.name, access.get(m.name) ?? "none"])) }),
        },
      ],
    }),
  );
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

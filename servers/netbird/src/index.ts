import { NetBirdClient } from "./netbird.js";
import { TokenVerifier } from "./oauth.js";
import { createHttpServer } from "./server.js";

const DEFAULT_NETBIRD_API_URL = "https://api.netbird.io";
const DEFAULT_SCOPES = "openid profile email offline_access";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

function parseUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    console.error(`${name} must be an absolute URL, got ${JSON.stringify(value)}`);
    process.exit(1);
  }
}

const netbird = new NetBirdClient(process.env.NETBIRD_API_URL?.trim() || DEFAULT_NETBIRD_API_URL, requireEnv("NETBIRD_API_TOKEN"));
const issuer = parseUrl("OIDC_ISSUER", requireEnv("OIDC_ISSUER")).href.replace(/\/+$/, "");
const resourceUrl = parseUrl("MCP_PUBLIC_URL", requireEnv("MCP_PUBLIC_URL"));
resourceUrl.pathname = resourceUrl.pathname.replace(/\/+$/, "");
resourceUrl.search = "";
resourceUrl.hash = "";
const audiences = requireEnv("OAUTH_AUDIENCE")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);
const scopesSupported = (process.env.OAUTH_SCOPES?.trim() || DEFAULT_SCOPES).split(/\s+/).filter(Boolean);
const host = process.env.HOST?.trim() || "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}

const verifier = new TokenVerifier({ issuer, audiences, resourceUrl, scopesSupported });
const server = createHttpServer({ verifier, netbird });

server.listen(port, host, () => {
  console.log(
    `netbird-mcp-server listening on http://${host}:${port}/mcp (resource ${resourceUrl.href}, issuer ${issuer}, NetBird API ${netbird.baseUrl})`,
  );
});

// Discovery runs after listen so liveness passes while Pocket ID is unreachable; readiness waits for it.
let shuttingDown = false;
void (async () => {
  for (let delayMs = 1_000; !shuttingDown; delayMs = Math.min(delayMs * 2, 30_000)) {
    try {
      await verifier.init();
      console.log("OIDC discovery loaded, ready to verify tokens");
      return;
    } catch (error) {
      console.error(`OIDC discovery failed, retrying in ${delayMs / 1000}s:`, error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
})();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`received ${signal}, shutting down`);
    shuttingDown = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

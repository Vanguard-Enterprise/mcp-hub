import { readFileSync } from "node:fs";
import { parseAccessPolicy } from "./access.js";
import { argoCdModuleFromEnv } from "./modules/argocd/index.js";
import { netbirdModuleFromEnv } from "./modules/netbird/index.js";
import { pocketIdModuleFromEnv } from "./modules/pocketid/index.js";
import type { HubModule } from "./modules/types.js";
import { TokenVerifier } from "./oauth.js";
import { createHttpServer } from "./server.js";

// `groups` is required: Pocket ID only reports group memberships to tokens granted it.
const DEFAULT_SCOPES = "openid profile email groups offline_access";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireEnv(name: string): string {
  return process.env[name]?.trim() || fail(`Missing required environment variable ${name}`);
}

function parseUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    fail(`${name} must be an absolute URL, got ${JSON.stringify(value)}`);
  }
}

// Every module is enabled by its own environment variables; add new ones here.
let modules: HubModule[];
try {
  modules = [netbirdModuleFromEnv(process.env), pocketIdModuleFromEnv(process.env), argoCdModuleFromEnv(process.env)].filter((m): m is HubModule => m !== undefined);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (modules.length === 0) fail("No modules are configured (set NETBIRD_API_TOKEN for netbird, POCKETID_API_KEY for pocketid, or ARGOCD_API_TOKEN for argocd)");

const policyFile = requireEnv("ACCESS_POLICY_FILE");
let policy;
try {
  policy = parseAccessPolicy(readFileSync(policyFile, "utf8"), modules.map((m) => m.name));
} catch (error) {
  fail(`${policyFile}: ${error instanceof Error ? error.message : String(error)}`);
}
for (const m of modules) if (!(m.name in policy.sections)) console.warn(`module ${m.name} has no entry in the access policy, so nobody can use it`);

// Kept exactly as configured: OIDC requires the issuer to match the discovery
// document and the token `iss` byte for byte (Pocket ID advertises no trailing slash).
const issuer = requireEnv("OIDC_ISSUER");
parseUrl("OIDC_ISSUER", issuer);
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
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(process.env.PORT)}`);

const verifier = new TokenVerifier({ issuer, audiences, resourceUrl, scopesSupported });
const server = createHttpServer({ verifier, modules, policy });

server.listen(port, host, () => {
  console.log(
    `mcp-hub listening on http://${host}:${port}/mcp (resource ${resourceUrl.href}, issuer ${issuer}, modules ${modules.map((m) => m.name).join(", ")})`,
  );
});

// Discovery runs after listen so liveness passes while the issuer is unreachable; readiness waits for it.
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

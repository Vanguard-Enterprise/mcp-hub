import { NetBirdClient } from "./netbird.js";
import { createHttpServer } from "./server.js";

const DEFAULT_NETBIRD_API_URL = "https://api.netbird.io";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const netbird = new NetBirdClient(process.env.NETBIRD_API_URL?.trim() || DEFAULT_NETBIRD_API_URL, requireEnv("NETBIRD_API_TOKEN"));
const mcpAuthToken = requireEnv("MCP_AUTH_TOKEN");
const host = process.env.HOST?.trim() || "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}

const server = createHttpServer({ mcpAuthToken, netbird });
server.listen(port, host, () => {
  console.log(`netbird-mcp-server listening on http://${host}:${port}/mcp (NetBird API: ${netbird.baseUrl})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  });
}

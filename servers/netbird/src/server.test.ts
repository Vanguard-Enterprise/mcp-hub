import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { NetBirdClient } from "./netbird.js";
import { createHttpServer } from "./server.js";

const MCP_AUTH_TOKEN = "test-bearer-token";
const server = createHttpServer({ mcpAuthToken: MCP_AUTH_TOKEN, netbird: new NetBirdClient("http://127.0.0.1:9", "unused") });
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

function rpc(method: string, params: unknown, authorization?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

test("healthz is public", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
});

test("unknown paths return 404", async () => {
  const res = await fetch(`${base}/other`);
  assert.equal(res.status, 404);
});

test("/mcp without a bearer token returns 401", async () => {
  const res = await rpc("tools/list", {});
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
});

test("/mcp with a wrong bearer token returns 401", async () => {
  assert.equal((await rpc("tools/list", {}, "Bearer wrong")).status, 401);
  assert.equal((await rpc("tools/list", {}, `Token ${MCP_AUTH_TOKEN}`)).status, 401);
});

test("/mcp with the right bearer token serves the read-only tool list", async () => {
  const res = await rpc("tools/list", {}, `Bearer ${MCP_AUTH_TOKEN}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
  const names = body.result.tools.map((t) => t.name);
  assert.equal(names.length, 17);
  assert.ok(names.includes("netbird_list_peers"));
  assert.ok(names.includes("netbird_get_dns_record"));
  assert.ok(body.result.tools.every((t) => t.annotations?.readOnlyHint === true));
});

test("tool calls report NetBird connection problems as tool errors", async () => {
  const res = await rpc("tools/call", { name: "netbird_list_peers", arguments: {} }, `Bearer ${MCP_AUTH_TOKEN}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { isError?: boolean } };
  assert.equal(body.result.isError, true);
});

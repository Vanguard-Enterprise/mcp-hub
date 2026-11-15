import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NetBirdClient } from "./netbird.js";
import { registerTools } from "./tools.js";
import { registerWriteTools } from "./tools-write.js";

interface Seen {
  method: string;
  path: string;
  authorization?: string;
  contentType?: string;
  body: string;
}

// A fake NetBird Management API that records every request. Responds 200 with an echo,
// 204-like empty 200 for DELETE, and 400 for anything under /api/fail.
const seen: Seen[] = [];
const fake: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization, contentType: req.headers["content-type"], body });
    if (req.url?.startsWith("/api/fail")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "bad request", code: 400 }));
    } else if (req.method === "DELETE") {
      res.writeHead(200).end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "new-id", echo: body ? JSON.parse(body) : null }));
    }
  });
});

let client: Client;

before(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const netbird = new NetBirdClient(`http://127.0.0.1:${(fake.address() as AddressInfo).port}`, "nbp_test");
  const server = new McpServer({ name: "netbird", version: "test" });
  registerTools(server, netbird);
  registerWriteTools(server, netbird);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});
after(async () => {
  await client.close();
  fake.close();
});

function last(): Seen {
  const entry = seen.at(-1);
  assert.ok(entry, "no request reached the fake NetBird API");
  return entry;
}

test("read tools are read-only, write tools are not, and deletes are destructive", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 40);
  for (const tool of tools) {
    const isWrite = /^netbird_(create|update|delete)_/.test(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, !isWrite, tool.name);
    if (/^netbird_(delete|update)_/.test(tool.name)) assert.equal(tool.annotations?.destructiveHint, true, tool.name);
    if (/^netbird_create_/.test(tool.name)) assert.equal(tool.annotations?.destructiveHint, false, tool.name);
  }
});

test("create sends POST with a JSON body and the PAT", async () => {
  const result = (await client.callTool({ name: "netbird_create_group", arguments: { name: "servers", peers: ["p1"] } })) as CallToolResult;
  assert.notEqual(result.isError, true);
  const req = last();
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/groups");
  assert.equal(req.authorization, "Token nbp_test");
  assert.match(req.contentType ?? "", /^application\/json/);
  assert.deepEqual(JSON.parse(req.body), { name: "servers", peers: ["p1"] });
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { id: "new-id", echo: { name: "servers", peers: ["p1"] } });
});

test("update sends PUT to the object's path with the ID removed from the body", async () => {
  await client.callTool({
    name: "netbird_update_dns_record",
    arguments: { zone_id: "z 1", record_id: "r/1", name: "grafana.internal.example.com", type: "A", content: "10.1.50.176", ttl: 300 },
  });
  const req = last();
  assert.equal(req.method, "PUT");
  assert.equal(req.path, "/api/dns/zones/z%201/records/r%2F1");
  assert.deepEqual(JSON.parse(req.body), { name: "grafana.internal.example.com", type: "A", content: "10.1.50.176", ttl: 300 });
});

test("delete sends DELETE without a body and reports the outcome", async () => {
  const result = (await client.callTool({ name: "netbird_delete_peer", arguments: { peer_id: "p1" } })) as CallToolResult;
  const req = last();
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/api/peers/p1");
  assert.equal(req.body, "");
  assert.equal(req.contentType, undefined);
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { status: "ok", method: "DELETE", path: "/api/peers/p1" });
});

test("policy rules are validated before anything is sent", async () => {
  const before = seen.length;
  const result = (await client.callTool({
    name: "netbird_create_policy",
    arguments: { name: "bad", enabled: true, rules: [{ name: "r", enabled: true, action: "allow", bidirectional: true, protocol: "tcp" }] },
  })) as CallToolResult;
  assert.equal(result.isError, true);
  assert.equal(seen.length, before, "invalid input must not reach NetBird");
});

test("NetBird errors on writes come back as tool errors", async () => {
  const netbird = new NetBirdClient(`http://127.0.0.1:${(fake.address() as AddressInfo).port}/api/fail`, "nbp_test");
  const server = new McpServer({ name: "netbird", version: "test" });
  registerWriteTools(server, netbird);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const failing = new Client({ name: "test", version: "0" });
  await failing.connect(ct);
  try {
    const result = (await failing.callTool({ name: "netbird_delete_group", arguments: { group_id: "g1" } })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /HTTP 400 for DELETE \/api\/groups\/g1/);
  } finally {
    await failing.close();
  }
});

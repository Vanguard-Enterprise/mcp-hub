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
      // NetBird's delete handlers answer 200 with an empty JSON object.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
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
    if (/^netbird_(delete|update)_/.test(tool.name)) {
      assert.equal(tool.annotations?.destructiveHint, true, tool.name);
      assert.equal(tool.annotations?.idempotentHint, true, tool.name);
    }
    if (/^netbird_create_/.test(tool.name)) {
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.equal(tool.annotations?.idempotentHint, false, tool.name);
    }
  }
});

const RULE = { name: "r", enabled: true, action: "accept", bidirectional: true, protocol: "tcp", ports: ["443"], sources: ["g1"], destinations: ["g2"] };
const ROUTE = { description: "d", network_id: "n", enabled: true, network: "10.0.0.0/24", peer: "p1", metric: 100, masquerade: true, groups: ["g1"], keep_route: false };
const NS_GROUP = { name: "ns", description: "d", nameservers: [{ ip: "1.1.1.1", ns_type: "udp", port: 53 }], enabled: true, groups: ["g1"], primary: true, domains: [], search_domains_enabled: false };
const ZONE = { name: "z", domain: "int.example.com", enable_search_domain: true, distribution_groups: ["g1"] };
const RECORD = { name: "a.int.example.com", type: "A", content: "10.0.0.1", ttl: 300 };
const PEER = { name: "n", ssh_enabled: false, login_expiration_enabled: true, inactivity_expiration_enabled: false };

// Every write tool: minimal valid arguments and the request they must produce. The body is
// the arguments minus the path parameters (network_id is a real body field, so match exactly).
const PATH_PARAMS = new Set(["group_id", "policy_id", "route_id", "key_id", "nsgroup_id", "zone_id", "record_id", "peer_id"]);
const CASES: { tool: string; args: Record<string, unknown>; method: string; path: string }[] = [
  { tool: "netbird_create_group", args: { name: "g" }, method: "POST", path: "/api/groups" },
  { tool: "netbird_update_group", args: { group_id: "g1", name: "g", peers: ["p1"] }, method: "PUT", path: "/api/groups/g1" },
  { tool: "netbird_delete_group", args: { group_id: "g1" }, method: "DELETE", path: "/api/groups/g1" },
  { tool: "netbird_create_policy", args: { name: "p", enabled: true, rules: [RULE] }, method: "POST", path: "/api/policies" },
  { tool: "netbird_update_policy", args: { policy_id: "p1", name: "p", enabled: true, rules: [{ ...RULE, id: "r1" }] }, method: "PUT", path: "/api/policies/p1" },
  { tool: "netbird_delete_policy", args: { policy_id: "p1" }, method: "DELETE", path: "/api/policies/p1" },
  { tool: "netbird_create_route", args: ROUTE, method: "POST", path: "/api/routes" },
  { tool: "netbird_update_route", args: { route_id: "r1", ...ROUTE }, method: "PUT", path: "/api/routes/r1" },
  { tool: "netbird_delete_route", args: { route_id: "r1" }, method: "DELETE", path: "/api/routes/r1" },
  { tool: "netbird_create_setup_key", args: { name: "k", type: "reusable", expires_in: 86400, auto_groups: ["g1"], usage_limit: 0 }, method: "POST", path: "/api/setup-keys" },
  { tool: "netbird_update_setup_key", args: { key_id: "k1", revoked: true, auto_groups: ["g1"] }, method: "PUT", path: "/api/setup-keys/k1" },
  { tool: "netbird_delete_setup_key", args: { key_id: "k1" }, method: "DELETE", path: "/api/setup-keys/k1" },
  { tool: "netbird_create_nameserver_group", args: NS_GROUP, method: "POST", path: "/api/dns/nameservers" },
  { tool: "netbird_update_nameserver_group", args: { nsgroup_id: "n1", ...NS_GROUP }, method: "PUT", path: "/api/dns/nameservers/n1" },
  { tool: "netbird_delete_nameserver_group", args: { nsgroup_id: "n1" }, method: "DELETE", path: "/api/dns/nameservers/n1" },
  { tool: "netbird_create_dns_zone", args: ZONE, method: "POST", path: "/api/dns/zones" },
  { tool: "netbird_update_dns_zone", args: { zone_id: "z1", ...ZONE, enabled: false }, method: "PUT", path: "/api/dns/zones/z1" },
  { tool: "netbird_delete_dns_zone", args: { zone_id: "z1" }, method: "DELETE", path: "/api/dns/zones/z1" },
  { tool: "netbird_create_dns_record", args: { zone_id: "z1", ...RECORD }, method: "POST", path: "/api/dns/zones/z1/records" },
  { tool: "netbird_update_dns_record", args: { zone_id: "z1", record_id: "r1", ...RECORD }, method: "PUT", path: "/api/dns/zones/z1/records/r1" },
  { tool: "netbird_delete_dns_record", args: { zone_id: "z1", record_id: "r1" }, method: "DELETE", path: "/api/dns/zones/z1/records/r1" },
  { tool: "netbird_update_peer", args: { peer_id: "p1", ...PEER }, method: "PUT", path: "/api/peers/p1" },
  { tool: "netbird_delete_peer", args: { peer_id: "p1" }, method: "DELETE", path: "/api/peers/p1" },
];

test("every write tool sends the spec's method and path, with the ID parameters kept out of the body", async () => {
  const { tools } = await client.listTools();
  const writeTools = tools.map((t) => t.name).filter((n) => /^netbird_(create|update|delete)_/.test(n)).sort();
  assert.deepEqual(writeTools, CASES.map((c) => c.tool).sort(), "every write tool has a case");
  for (const c of CASES) {
    const result = (await client.callTool({ name: c.tool, arguments: c.args })) as CallToolResult;
    assert.notEqual(result.isError, true, `${c.tool}: ${JSON.stringify(result.content)}`);
    const req = last();
    assert.equal(req.method, c.method, c.tool);
    assert.equal(req.path, c.path, c.tool);
    const expectedBody = Object.fromEntries(Object.entries(c.args).filter(([k]) => !PATH_PARAMS.has(k)));
    if (c.method === "DELETE") assert.equal(req.body, "", c.tool);
    else assert.deepEqual(JSON.parse(req.body), expectedBody, c.tool);
  }
});

test("unknown argument keys are stripped before the body is sent", async () => {
  await client.callTool({ name: "netbird_create_group", arguments: { name: "g", id: "forged", foo: 1 } });
  assert.deepEqual(JSON.parse(last().body), { name: "g" });
});

test("spec bounds are enforced before anything is sent", async () => {
  const before = seen.length;
  for (const [name, args] of [
    ["netbird_create_route", { ...ROUTE, metric: 0 }],
    ["netbird_create_nameserver_group", { ...NS_GROUP, nameservers: Array(4).fill(NS_GROUP.nameservers[0]) }],
    ["netbird_create_group", { name: "g", resources: [{ id: "x", type: "bucket" }] }],
  ] as const) {
    const result = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as CallToolResult;
    assert.equal(result.isError, true, name);
  }
  assert.equal(seen.length, before);
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
  // The API's "{}" is turned into a status object.
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

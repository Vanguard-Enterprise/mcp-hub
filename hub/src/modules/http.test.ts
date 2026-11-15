import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError, JsonApiClient } from "./http.js";
import { ToolRegistrar } from "./tools.js";

// "target" records whether a redirect was followed; "origin" redirects, or answers 200 with a non-JSON body.
let targetHits = 0;
const target: Server = createServer((_req, res) => {
  targetHits++;
  res.end("{}");
});
const origin: Server = createServer((req, res) => {
  if (req.url?.startsWith("/redirect")) {
    res.writeHead(302, { Location: `http://localhost:${(target.address() as AddressInfo).port}/stolen` });
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("not json");
});

let originUrl: string;
before(async () => {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});
after(() => {
  target.close();
  origin.close();
});

test("a base URL must be HTTPS, or plain HTTP on loopback", () => {
  for (const ok of ["https://id.example.com", "http://127.0.0.1:1411", "http://localhost:8080", "http://[::1]:80"]) {
    assert.doesNotThrow(() => new JsonApiClient("Test", ok, {}), ok);
  }
  assert.throws(() => new JsonApiClient("Test", "http://id.example.com", {}), /must use https:\/\//);
  assert.throws(() => new JsonApiClient("Test", "http://pocket-id.pocket-id.svc:1411", {}), /must use https:\/\//);
  assert.throws(() => new JsonApiClient("Test", "id.example.com", {}), /absolute URL/);
});

test("redirects are never followed, so credentials stay with the configured origin", async () => {
  const client = new JsonApiClient("Test", originUrl, { "X-API-Key": "secret" });
  for (const method of ["GET", "PUT"] as const) {
    const call = method === "GET" ? client.get("/redirect") : client.request("PUT", "/redirect", { a: 1 });
    await assert.rejects(call, (error: unknown) => error instanceof ApiError && error.status === 302 && /redirect to http:\/\/localhost/.test(error.message));
  }
  assert.equal(targetHits, 0);
});

test("a write is audited even when reading the answer throws", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    const server = new McpServer({ name: "t", version: "0" });
    let callback: ((args: object) => Promise<unknown>) | undefined;
    // Capture the registered callback to call it directly, as the SDK would.
    server.registerTool = ((_name: string, _config: unknown, cb: (args: object) => Promise<unknown>) => {
      callback = cb;
    }) as unknown as McpServer["registerTool"];
    new ToolRegistrar(server, new JsonApiClient("Test", originUrl, {}), "user-1").write("t_write", "d", {}, {}, () => ({ method: "POST", path: "/x", body: {} }));
    await assert.rejects(callback!({}), SyntaxError);
  } finally {
    console.log = log;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", / write t_write POST \/x sub=user-1 error$/);
});

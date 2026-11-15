import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { parseAccessPolicy } from "./access.js";
import { NetBirdClient } from "./modules/netbird/client.js";
import { netbirdModule } from "./modules/netbird/index.js";
import { TokenVerifier } from "./oauth.js";
import { createHttpServer } from "./server.js";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const RESOURCE = new URL("https://mcp.example.com/mcp");

// A fake OIDC provider: discovery, a JWKS with one RSA key, and userinfo that reports the
// groups below for the token's subject (unverified decode is fine for a fake).
const GROUPS: Record<string, string[]> = {
  "user-1": ["mcp_netbird_write"],
  reader: ["mcp_netbird_read", "unrelated"],
  nobody: ["unrelated"],
};
let userinfoStatus = 200;
// Set to send a 200 with a body that is not JSON.
let userinfoBroken = false;
// Set to advertise an unacceptable userinfo endpoint in discovery.
let badUserinfo: string | undefined;
let userinfoSubOverride: string | undefined;
let userinfoCalls = 0;
let issuer = "";
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: { keys: unknown[] };
// Set to a non-200 status to simulate a JWKS outage.
let jwksStatus = 200;
const idp: Server = createServer((req, res) => {
  if (req.url === "/.well-known/openid-configuration") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const userinfo = badUserinfo ?? `${issuer}/api/oidc/userinfo`;
    res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, userinfo_endpoint: userinfo }));
  } else if (req.url === "/.well-known/jwks.json") {
    res.writeHead(jwksStatus, { "Content-Type": "application/json" });
    res.end(jwksStatus === 200 ? JSON.stringify(jwks) : "unavailable");
  } else if (req.url === "/api/oidc/userinfo") {
    userinfoCalls++;
    const sub = decodeJwt((req.headers.authorization ?? "").replace(/^Bearer /, "")).sub ?? "";
    res.writeHead(userinfoStatus, { "Content-Type": "application/json" });
    res.end(userinfoBroken ? '{"sub":' : JSON.stringify({ sub: userinfoSubOverride ?? sub, groups: GROUPS[sub] ?? [] }));
  } else {
    res.writeHead(404).end();
  }
});

let verifier: TokenVerifier;
let server: Server;
let base = "";

before(async () => {
  const pair = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  otherPrivateKey = other.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  verifier = newVerifier();
  await verifier.init();
  server = createHttpServer({ verifier, modules: MODULES, policy: POLICY });
  base = await listen(server);
});
after(() => {
  server.close();
  idp.close();
});

const MODULES = [netbirdModule(new NetBirdClient("http://127.0.0.1:9", "unused"))];
const POLICY = parseAccessPolicy(JSON.stringify({ sections: { netbird: { read: ["mcp_netbird_read"], write: ["mcp_netbird_write"] } } }), ["netbird"]);

function newVerifier(): TokenVerifier {
  return new TokenVerifier({
    issuer,
    audiences: [RESOURCE.href, CLIENT_ID],
    resourceUrl: RESOURCE,
    scopesSupported: ["openid", "profile", "email", "groups", "offline_access"],
  });
}

async function listen(httpServer: Server): Promise<string> {
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
}

async function mint(
  overrides: { aud?: string | string[]; iss?: string; exp?: string; key?: CryptoKey; sub?: string; typ?: string | null } = {},
): Promise<string> {
  const header: Record<string, string> = { alg: "RS256", kid: "k1" };
  if (overrides.typ !== null) header.typ = overrides.typ ?? "at+jwt";
  const jwt = new SignJWT({ scope: "openid profile email" })
    .setProtectedHeader(header as { alg: string })
    .setIssuer(overrides.iss ?? issuer)
    .setAudience(overrides.aud ?? [RESOURCE.href, issuer])
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(overrides.exp ?? "5m");
  if (overrides.sub !== "") jwt.setSubject(overrides.sub ?? "user-1");
  return jwt.sign(overrides.key ?? privateKey);
}

function rpc(method: string, params: unknown, authorization?: string, origin = base): Promise<Response> {
  return fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

test("healthz is public, readyz waits for OIDC discovery", async () => {
  // Own verifier and server so this test does not depend on, or affect, the shared ready one.
  const cold = newVerifier();
  const coldServer = createHttpServer({ verifier: cold, modules: MODULES, policy: POLICY });
  const coldBase = await listen(coldServer);
  try {
    assert.equal((await fetch(`${coldBase}/healthz`)).status, 200);
    assert.equal((await fetch(`${coldBase}/readyz`)).status, 503);
    const early = await rpc("tools/list", {}, `Bearer ${await mint()}`, coldBase);
    assert.equal(early.status, 503);
    assert.equal(early.headers.get("retry-after"), "5");
    await cold.init();
    assert.equal((await fetch(`${coldBase}/readyz`)).status, 200);
    assert.equal((await rpc("tools/list", {}, `Bearer ${await mint()}`, coldBase)).status, 200);
  } finally {
    coldServer.close();
  }
});

test("a JWKS outage is reported as 503, not as an invalid token", async () => {
  // Fresh verifier so the JWKS has not been cached yet; discovery itself still works.
  const fresh = newVerifier();
  await fresh.init();
  const freshServer = createHttpServer({ verifier: fresh, modules: MODULES, policy: POLICY });
  const freshBase = await listen(freshServer);
  jwksStatus = 503;
  try {
    const res = await rpc("tools/list", {}, `Bearer ${await mint()}`, freshBase);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    assert.equal(res.headers.get("www-authenticate"), null);
  } finally {
    jwksStatus = 200;
    freshServer.close();
  }
});

test("protected resource metadata is served at both well-known forms", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.resource, RESOURCE.href);
    assert.deepEqual(body.authorization_servers, [issuer]);
    assert.deepEqual(body.scopes_supported, ["openid", "profile", "email", "groups", "offline_access"]);
  }
});

test("unknown paths return 404", async () => {
  assert.equal((await fetch(`${base}/other`)).status, 404);
});

test("/mcp without a bearer token returns 401 with the resource metadata challenge", async () => {
  const res = await rpc("tools/list", {});
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer realm="mcp-hub", resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"$/);
});

test("/mcp rejects tokens that fail verification", async () => {
  const cases: Record<string, string> = {
    "not a jwt": "Bearer not-a-jwt",
    "wrong scheme": `Token ${await mint()}`,
    "wrong signing key": `Bearer ${await mint({ key: otherPrivateKey })}`,
    "wrong issuer": `Bearer ${await mint({ iss: "https://evil.example.com" })}`,
    "wrong audience": `Bearer ${await mint({ aud: "https://other.example.com/mcp" })}`,
    expired: `Bearer ${await mint({ exp: "-1m" })}`,
    "no subject": `Bearer ${await mint({ sub: "" })}`,
    // An ID token for the same client: right issuer, key, and audience, but typ JWT.
    "ID token (typ JWT)": `Bearer ${await mint({ typ: "JWT", aud: CLIENT_ID })}`,
    "no typ header": `Bearer ${await mint({ typ: null })}`,
    "other typ": `Bearer ${await mint({ typ: "logout+jwt" })}`,
  };
  for (const [name, authorization] of Object.entries(cases)) {
    const res = await rpc("tools/list", {}, authorization);
    assert.equal(res.status, 401, name);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/, name);
    if (name !== "wrong scheme") assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/, name);
  }
});

test("/mcp accepts tokens for the resource audience or the client audience and serves the tools", async () => {
  for (const aud of [RESOURCE.href, CLIENT_ID, [CLIENT_ID, issuer]]) {
    const res = await rpc("tools/list", {}, `Bearer ${await mint({ aud })}`);
    assert.equal(res.status, 200, JSON.stringify(aud));
    const body = (await res.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    assert.equal(body.result.tools.length, 41);
    for (const tool of body.result.tools) {
      assert.equal(tool.annotations?.readOnlyHint, !/^netbird_(create|update|delete)_/.test(tool.name), tool.name);
    }
  }
});

test("/mcp accepts the application/at+jwt media type form", async () => {
  const res = await rpc("tools/list", {}, `Bearer ${await mint({ typ: "application/at+jwt" })}`);
  assert.equal(res.status, 200);
});

test("tool calls report NetBird connection problems as tool errors", async () => {
  const res = await rpc("tools/call", { name: "netbird_list_peers", arguments: {} }, `Bearer ${await mint()}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { isError?: boolean } };
  assert.equal(body.result.isError, true);
});

async function toolNames(sub: string): Promise<string[]> {
  const res = await rpc("tools/list", {}, `Bearer ${await mint({ sub })}`);
  assert.equal(res.status, 200, sub);
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name);
}

test("tool lists follow the caller's groups: write, read, or none", async () => {
  const writer = await toolNames("user-1");
  assert.equal(writer.length, 41);
  assert.ok(writer.includes("netbird_delete_peer"));

  const reader = await toolNames("reader");
  assert.equal(reader.length, 18, "hub_whoami plus the 17 read tools");
  assert.ok(reader.includes("netbird_list_peers"));
  assert.ok(!reader.some((n) => /^netbird_(create|update|delete)_/.test(n)));

  assert.deepEqual(await toolNames("nobody"), ["hub_whoami"]);
});

test("a read-only caller cannot call a write tool by name", async () => {
  const res = await rpc("tools/call", { name: "netbird_delete_peer", arguments: { peer_id: "p1" } }, `Bearer ${await mint({ sub: "reader" })}`);
  const body = (await res.json()) as { result?: { isError?: boolean }; error?: unknown };
  assert.ok(body.error !== undefined || body.result?.isError === true, JSON.stringify(body));
});

test("hub_whoami reports groups and access per section", async () => {
  const res = await rpc("tools/call", { name: "hub_whoami", arguments: {} }, `Bearer ${await mint({ sub: "reader" })}`);
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  assert.deepEqual(JSON.parse(body.result.content[0]!.text), { subject: "reader", groups: ["mcp_netbird_read", "unrelated"], sections: { netbird: "read" } });
});

test("group lookups are cached per token", async () => {
  const token = await mint({ sub: "reader" });
  const before = userinfoCalls;
  await rpc("tools/list", {}, `Bearer ${token}`);
  await rpc("tools/list", {}, `Bearer ${token}`);
  assert.equal(userinfoCalls - before, 1);
});

test("userinfo problems: rejection is 401, subject mismatch is 401, outage is 503", async () => {
  try {
    userinfoStatus = 403;
    let res = await rpc("tools/list", {}, `Bearer ${await mint({ sub: "u-403" })}`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

    userinfoStatus = 200;
    userinfoSubOverride = "someone-else";
    res = await rpc("tools/list", {}, `Bearer ${await mint({ sub: "u-mismatch" })}`);
    assert.equal(res.status, 401);
    userinfoSubOverride = undefined;

    userinfoStatus = 502;
    res = await rpc("tools/list", {}, `Bearer ${await mint({ sub: "u-502" })}`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");

    userinfoStatus = 200;
    userinfoBroken = true;
    res = await rpc("tools/list", {}, `Bearer ${await mint({ sub: "u-broken-body" })}`);
    assert.equal(res.status, 503, "an unreadable body is retryable, not a login problem");
    assert.equal(res.headers.get("www-authenticate"), null);
  } finally {
    userinfoStatus = 200;
    userinfoBroken = false;
    userinfoSubOverride = undefined;
  }
});

test("discovery refuses userinfo endpoints that are not HTTPS, except plain HTTP on loopback", async () => {
  try {
    for (const url of ["http://id.example.com/api/oidc/userinfo", "ftp://localhost/userinfo", "ws://127.0.0.1/userinfo"]) {
      badUserinfo = url;
      await assert.rejects(newVerifier().init(), /non-HTTPS userinfo_endpoint/, url);
    }
  } finally {
    badUserinfo = undefined;
  }
});

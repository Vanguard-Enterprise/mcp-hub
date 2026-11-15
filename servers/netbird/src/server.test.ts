import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { NetBirdClient } from "./netbird.js";
import { TokenVerifier } from "./oauth.js";
import { createHttpServer } from "./server.js";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const RESOURCE = new URL("https://mcp-netbird.example.com/mcp");

// A fake OIDC provider: discovery document plus a JWKS with one RSA key.
let issuer = "";
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: { keys: unknown[] };
// Set to a non-200 status to simulate a JWKS outage.
let jwksStatus = 200;
const idp: Server = createServer((req, res) => {
  if (req.url === "/.well-known/openid-configuration") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` }));
  } else if (req.url === "/.well-known/jwks.json") {
    res.writeHead(jwksStatus, { "Content-Type": "application/json" });
    res.end(jwksStatus === 200 ? JSON.stringify(jwks) : "unavailable");
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
  server = createHttpServer({ verifier, netbird: NETBIRD });
  base = await listen(server);
});
after(() => {
  server.close();
  idp.close();
});

const NETBIRD = new NetBirdClient("http://127.0.0.1:9", "unused");

function newVerifier(): TokenVerifier {
  return new TokenVerifier({
    issuer,
    audiences: [RESOURCE.href, CLIENT_ID],
    resourceUrl: RESOURCE,
    scopesSupported: ["openid", "profile", "email", "offline_access"],
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
  const coldServer = createHttpServer({ verifier: cold, netbird: NETBIRD });
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
  const freshServer = createHttpServer({ verifier: fresh, netbird: NETBIRD });
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
    assert.deepEqual(body.scopes_supported, ["openid", "profile", "email", "offline_access"]);
  }
});

test("unknown paths return 404", async () => {
  assert.equal((await fetch(`${base}/other`)).status, 404);
});

test("/mcp without a bearer token returns 401 with the resource metadata challenge", async () => {
  const res = await rpc("tools/list", {});
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer realm="netbird-mcp", resource_metadata="https:\/\/mcp-netbird\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"$/);
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

test("/mcp accepts tokens for the resource audience or the client audience and serves the read-only tools", async () => {
  for (const aud of [RESOURCE.href, CLIENT_ID, [CLIENT_ID, issuer]]) {
    const res = await rpc("tools/list", {}, `Bearer ${await mint({ aud })}`);
    assert.equal(res.status, 200, JSON.stringify(aud));
    const body = (await res.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    assert.equal(body.result.tools.length, 17);
    assert.ok(body.result.tools.every((t) => t.annotations?.readOnlyHint === true));
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

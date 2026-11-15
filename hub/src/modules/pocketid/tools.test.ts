import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PocketIdClient } from "./client.js";
import { HIDDEN, registerReadTools } from "./read.js";
import { registerWriteTools } from "./write.js";

interface Seen {
  method: string;
  path: string;
  apiKey?: string;
  authorization?: string;
  contentType?: string;
  body: string;
}

const APP_CONFIG = [
  { key: "appName", type: "string", value: "Pocket ID" },
  { key: "allowUserSignups", type: "string", value: "disabled" },
  { key: "smtpPassword", type: "string", value: "smtp-secret" },
  { key: "ldapBindPassword", type: "string", value: "" },
];

// A fake Pocket ID admin API that records every request. Canned answers for the endpoints whose
// responses the tools rewrite or merge, 400 under /api/fail, an empty 204 for DELETE, and an echo otherwise.
const seen: Seen[] = [];
const fake: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    seen.push({
      method: req.method ?? "",
      path: req.url ?? "",
      apiKey: req.headers["x-api-key"] as string | undefined,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      body,
    });
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const send = (status: number, data?: unknown) => {
      res.writeHead(status, data === undefined ? {} : { "Content-Type": "application/json" });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    if (path.startsWith("/api/fail")) return send(400, { error: "bad request" });
    if (req.method === "GET" && path === "/api/application-configuration/all") return send(200, APP_CONFIG);
    // Like Pocket ID, answer a configuration update with the saved configuration, credentials included.
    if (req.method === "PUT" && path === "/api/application-configuration") {
      return send(200, Object.entries(JSON.parse(body) as Record<string, string>).map(([key, value]) => ({ key, type: "string", value })));
    }
    if (req.method === "GET" && path === "/api/signup-tokens") {
      return send(200, { data: [{ id: "t1", token: "invite-secret", usageLimit: 1 }], pagination: { totalItems: 1 } });
    }
    if (req.method === "GET" && path.endsWith("/scim-service-provider")) return send(200, { id: "s1", endpoint: "https://scim.example.com", token: "scim-secret" });
    // Like Pocket ID, answer SCIM provider writes with the provider, bearer token included.
    if ((req.method === "POST" || req.method === "PUT") && /^\/api\/scim\/service-provider(\/[^/]+)?$/.test(path)) {
      return send(200, { id: "s1", ...(JSON.parse(body) as object) });
    }
    if (req.method === "DELETE") return send(204);
    send(200, { id: "new-id", echo: body ? JSON.parse(body) : null });
  });
});

let baseUrl: string;
let client: Client;

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(clientTransport);
  return c;
}

before(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const pocketid = new PocketIdClient(baseUrl, "pid_test_key");
  const server = new McpServer({ name: "pocketid", version: "test" });
  registerReadTools(server, pocketid);
  registerWriteTools(server, pocketid);
  client = await connect(server);
});
after(async () => {
  await client.close();
  fake.close();
});

function last(): Seen {
  const entry = seen.at(-1);
  assert.ok(entry, "no request reached the fake Pocket ID API");
  return entry;
}

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const READ_TOOL = /^pocketid_(list|get|preview)_/;

test("read tools are read-only; write tools are not, force a prompt, and updates and deletes are destructive", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 54);
  for (const tool of tools) {
    const isRead = READ_TOOL.test(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, isRead, tool.name);
    assert.equal((tool._meta as Record<string, unknown> | undefined)?.["anthropic/requiresUserInteraction"], isRead ? undefined : true, tool.name);
    if (/^pocketid_(delete|update|set|remove)_/.test(tool.name)) assert.equal(tool.annotations?.destructiveHint, true, tool.name);
    if (/^pocketid_(create|send|sync)_/.test(tool.name)) assert.equal(tool.annotations?.destructiveHint, false, tool.name);
  }
});

// Every read tool: arguments and the exact request path (with query) it must produce.
const READS: { tool: string; args?: Record<string, unknown>; path: string }[] = [
  { tool: "pocketid_list_users", path: "/api/users" },
  { tool: "pocketid_get_user", args: { user_id: "u1" }, path: "/api/users/u1" },
  { tool: "pocketid_list_groups_of_user", args: { user_id: "u1" }, path: "/api/users/u1/groups" },
  { tool: "pocketid_list_user_passkeys", args: { user_id: "u1" }, path: "/api/users/u1/webauthn-credentials" },
  { tool: "pocketid_list_user_authorized_clients", args: { user_id: "u1" }, path: "/api/oidc/users/u1/authorized-clients" },
  { tool: "pocketid_list_groups", args: { search: "mcp" }, path: "/api/user-groups?search=mcp" },
  { tool: "pocketid_get_group", args: { group_id: "g1" }, path: "/api/user-groups/g1" },
  { tool: "pocketid_list_oidc_clients", path: "/api/oidc/clients" },
  { tool: "pocketid_get_oidc_client", args: { client_id: "c1" }, path: "/api/oidc/clients/c1" },
  { tool: "pocketid_list_oidc_client_secrets", args: { client_id: "c1" }, path: "/api/oidc/clients/c1/secrets" },
  { tool: "pocketid_preview_oidc_client_claims", args: { client_id: "c1", user_id: "u1" }, path: "/api/oidc/clients/c1/preview/u1" },
  { tool: "pocketid_list_oidc_client_apis", args: { client_id: "c1" }, path: "/api/api-access/c1/apis" },
  { tool: "pocketid_get_oidc_client_scim_provider", args: { client_id: "c1" }, path: "/api/oidc/clients/c1/scim-service-provider" },
  { tool: "pocketid_list_apis", path: "/api/apis" },
  { tool: "pocketid_get_api", args: { api_id: "a1" }, path: "/api/apis/a1" },
  { tool: "pocketid_list_api_clients", args: { api_id: "a1" }, path: "/api/apis/a1/clients" },
  { tool: "pocketid_list_signup_tokens", path: "/api/signup-tokens" },
  { tool: "pocketid_list_audit_logs", path: "/api/audit-logs/all?sort%5Bcolumn%5D=createdAt&sort%5Bdirection%5D=desc" },
  { tool: "pocketid_get_app_config", path: "/api/application-configuration/all" },
];

test("every read tool sends one GET to the API path with the API key", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).filter((n) => READ_TOOL.test(n)).sort(), READS.map((r) => r.tool).sort(), "every read tool has a case");
  for (const r of READS) {
    const result = await call(r.tool, r.args);
    assert.notEqual(result.isError, true, `${r.tool}: ${text(result)}`);
    const req = last();
    assert.equal(req.method, "GET", r.tool);
    assert.equal(req.path, r.path, r.tool);
    assert.equal(req.apiKey, "pid_test_key", r.tool);
    assert.equal(req.authorization, undefined, r.tool);
  }
});

test("list tools map pagination, sorting, and filters to Pocket ID's query parameters", async () => {
  await call("pocketid_list_users", { search: "fr", page: 2, limit: 50, sort_column: "username", sort_direction: "desc", is_admin: true, disabled: false });
  const query = new URL(last().path, "http://x").searchParams;
  assert.deepEqual(Object.fromEntries(query), {
    search: "fr",
    "pagination[page]": "2",
    "pagination[limit]": "50",
    "sort[column]": "username",
    "sort[direction]": "desc",
    "filters[isAdmin]": "true",
    "filters[disabled]": "false",
  });

  await call("pocketid_list_audit_logs", { event: "SIGN_IN", user_id: "u1", client_name: "Grafana", location: "external", sort_direction: "asc" });
  assert.deepEqual(Object.fromEntries(new URL(last().path, "http://x").searchParams), {
    "sort[column]": "createdAt",
    "sort[direction]": "asc",
    "filters[event]": "SIGN_IN",
    "filters[userID]": "u1",
    "filters[clientName]": "Grafana",
    "filters[location]": "external",
  });
});

test("list limits are enforced before anything is sent", async () => {
  const before = seen.length;
  assert.equal((await call("pocketid_list_users", { limit: 101 })).isError, true);
  assert.equal((await call("pocketid_list_audit_logs", { event: "LOGOUT" })).isError, true);
  assert.equal(seen.length, before);
});

test("read tools never return credentials", async () => {
  const config = JSON.parse(text(await call("pocketid_get_app_config"))) as { key: string; value: string }[];
  const value = (key: string) => config.find((e) => e.key === key)?.value;
  assert.equal(value("smtpPassword"), HIDDEN);
  assert.equal(value("ldapBindPassword"), "", "an unset password stays visibly unset");
  assert.equal(value("appName"), "Pocket ID");

  const tokens = text(await call("pocketid_list_signup_tokens"));
  assert.doesNotMatch(tokens, /invite-secret/);
  assert.equal((JSON.parse(tokens) as { data: { token: string }[] }).data[0]?.token, HIDDEN);

  const scim = text(await call("pocketid_get_oidc_client_scim_provider", { client_id: "c1" }));
  assert.doesNotMatch(scim, /scim-secret/);
  assert.equal((JSON.parse(scim) as { endpoint: string }).endpoint, "https://scim.example.com");
});

const CLIENT = { name: "Grafana", isPublic: false, pkceEnabled: true, callbackURLs: ["https://grafana.example.com/login/generic_oauth"] };
const USER = { username: "alice", email: "alice@example.com", firstName: "Alice" };
const SCIM = { endpoint: "https://scim.example.com/v2", token: "t", oidcClientId: "c1" };

// Every write tool except pocketid_update_app_config (tested below): minimal valid arguments and
// the request they must produce. `body` defaults to the arguments minus the path parameters.
const PATH_PARAMS = new Set(["user_id", "group_id", "client_id", "secret_id", "credential_id", "api_id", "token_id", "provider_id"]);
const WRITES: { tool: string; args: Record<string, unknown>; method: string; path: string; body?: unknown }[] = [
  { tool: "pocketid_create_user", args: { ...USER, userGroupIds: ["g1"] }, method: "POST", path: "/api/users" },
  { tool: "pocketid_update_user", args: { user_id: "u1", ...USER, emailVerified: true, isAdmin: false, disabled: true }, method: "PUT", path: "/api/users/u1" },
  { tool: "pocketid_delete_user", args: { user_id: "u1" }, method: "DELETE", path: "/api/users/u1" },
  { tool: "pocketid_set_user_groups", args: { user_id: "u1", userGroupIds: ["g1", "g2"] }, method: "PUT", path: "/api/users/u1/user-groups" },
  {
    tool: "pocketid_set_user_custom_claims",
    args: { user_id: "u1", claims: [{ key: "team", value: "ops" }] },
    method: "PUT",
    path: "/api/custom-claims/user/u1",
    body: [{ key: "team", value: "ops" }],
  },
  { tool: "pocketid_delete_user_passkey", args: { user_id: "u1", credential_id: "k1" }, method: "DELETE", path: "/api/users/u1/webauthn-credentials/k1" },
  { tool: "pocketid_create_one_time_access_token", args: { user_id: "u1", ttl: "1h" }, method: "POST", path: "/api/users/u1/one-time-access-token" },
  { tool: "pocketid_send_one_time_access_email", args: { user_id: "u1" }, method: "POST", path: "/api/users/u1/one-time-access-email", body: {} },
  { tool: "pocketid_create_group", args: { friendlyName: "MCP Pocket ID read", name: "mcp_pocketid_read" }, method: "POST", path: "/api/user-groups" },
  { tool: "pocketid_update_group", args: { group_id: "g1", friendlyName: "Ops", name: "ops" }, method: "PUT", path: "/api/user-groups/g1" },
  { tool: "pocketid_delete_group", args: { group_id: "g1" }, method: "DELETE", path: "/api/user-groups/g1" },
  { tool: "pocketid_set_group_users", args: { group_id: "g1", userIds: ["u1"] }, method: "PUT", path: "/api/user-groups/g1/users" },
  { tool: "pocketid_set_group_allowed_clients", args: { group_id: "g1", oidcClientIds: ["c1"] }, method: "PUT", path: "/api/user-groups/g1/allowed-oidc-clients" },
  { tool: "pocketid_set_group_custom_claims", args: { group_id: "g1", claims: [] }, method: "PUT", path: "/api/custom-claims/user-group/g1", body: [] },
  { tool: "pocketid_create_oidc_client", args: { id: "grafana", ...CLIENT }, method: "POST", path: "/api/oidc/clients" },
  { tool: "pocketid_update_oidc_client", args: { client_id: "c1", ...CLIENT, isGroupRestricted: true }, method: "PUT", path: "/api/oidc/clients/c1" },
  { tool: "pocketid_delete_oidc_client", args: { client_id: "c1" }, method: "DELETE", path: "/api/oidc/clients/c1" },
  { tool: "pocketid_set_oidc_client_allowed_groups", args: { client_id: "c1", userGroupIds: ["g1"] }, method: "PUT", path: "/api/oidc/clients/c1/allowed-user-groups" },
  { tool: "pocketid_create_oidc_client_secret", args: { client_id: "c1", expiresAt: "2027-01-01T00:00:00Z" }, method: "POST", path: "/api/oidc/clients/c1/secrets" },
  { tool: "pocketid_delete_oidc_client_secret", args: { client_id: "c1", secret_id: "s1" }, method: "DELETE", path: "/api/oidc/clients/c1/secrets/s1" },
  { tool: "pocketid_create_api", args: { name: "MCP Hub", resource: "https://mcp.example.com/mcp" }, method: "POST", path: "/api/apis" },
  { tool: "pocketid_update_api", args: { api_id: "a1", name: "Hub" }, method: "PUT", path: "/api/apis/a1" },
  { tool: "pocketid_delete_api", args: { api_id: "a1" }, method: "DELETE", path: "/api/apis/a1" },
  { tool: "pocketid_set_api_permissions", args: { api_id: "a1", permissions: [{ key: "read", name: "Read" }] }, method: "PUT", path: "/api/apis/a1/permissions" },
  { tool: "pocketid_set_api_metadata_client_access", args: { api_id: "a1", enabled: true, permissionIds: ["p1"] }, method: "PUT", path: "/api/apis/a1/cimd-access" },
  {
    tool: "pocketid_set_api_client_access",
    args: { api_id: "a1", client_id: "c1", userDelegatedAccess: true, clientAccess: false, userDelegatedPermissionIds: ["p1"] },
    method: "PUT",
    path: "/api/apis/a1/clients/c1",
  },
  { tool: "pocketid_remove_api_client_access", args: { api_id: "a1", client_id: "c1" }, method: "DELETE", path: "/api/apis/a1/clients/c1" },
  { tool: "pocketid_create_signup_token", args: { ttl: 3600, usageLimit: 1, userGroupIds: ["g1"] }, method: "POST", path: "/api/signup-tokens" },
  { tool: "pocketid_delete_signup_token", args: { token_id: "t1" }, method: "DELETE", path: "/api/signup-tokens/t1" },
  { tool: "pocketid_create_scim_provider", args: SCIM, method: "POST", path: "/api/scim/service-provider" },
  { tool: "pocketid_update_scim_provider", args: { provider_id: "s1", ...SCIM }, method: "PUT", path: "/api/scim/service-provider/s1" },
  { tool: "pocketid_delete_scim_provider", args: { provider_id: "s1" }, method: "DELETE", path: "/api/scim/service-provider/s1" },
  { tool: "pocketid_sync_scim_provider", args: { provider_id: "s1" }, method: "POST", path: "/api/scim/service-provider/s1/sync" },
  { tool: "pocketid_sync_ldap", args: {}, method: "POST", path: "/api/application-configuration/sync-ldap" },
];

test("every write tool sends the API's method, path, and body, with path parameters kept out of the body", async () => {
  const { tools } = await client.listTools();
  const writeTools = tools.map((t) => t.name).filter((n) => !READ_TOOL.test(n) && n !== "pocketid_update_app_config");
  assert.deepEqual(writeTools.sort(), WRITES.map((w) => w.tool).sort(), "every write tool has a case");
  for (const w of WRITES) {
    const result = await call(w.tool, w.args);
    assert.notEqual(result.isError, true, `${w.tool}: ${text(result)}`);
    const req = last();
    assert.equal(req.method, w.method, w.tool);
    assert.equal(req.path, w.path, w.tool);
    assert.equal(req.apiKey, "pid_test_key", w.tool);
    const expected = w.body ?? Object.fromEntries(Object.entries(w.args).filter(([k]) => !PATH_PARAMS.has(k)));
    if (w.method === "DELETE" || w.tool.startsWith("pocketid_sync_")) assert.equal(req.body, "", w.tool);
    else assert.deepEqual(JSON.parse(req.body), expected, w.tool);
  }
});

test("a DELETE's empty answer is reported as a status object", async () => {
  const result = await call("pocketid_delete_group", { group_id: "g 1/x" });
  assert.equal(last().path, "/api/user-groups/g%201%2Fx");
  assert.deepEqual(JSON.parse(text(result)), { status: "ok", method: "DELETE", path: "/api/user-groups/g%201%2Fx" });
});

test("update_app_config merges the changes into the current configuration, credentials included", async () => {
  const result = await call("pocketid_update_app_config", { changes: { allowUserSignups: "withToken" } });
  assert.notEqual(result.isError, true, text(result));
  const [get, put] = seen.slice(-2);
  assert.equal(get?.method, "GET");
  assert.equal(get?.path, "/api/application-configuration/all");
  assert.equal(put?.method, "PUT");
  assert.equal(put?.path, "/api/application-configuration");
  // The real SMTP password is sent back unchanged, not the placeholder the read tool shows.
  assert.deepEqual(JSON.parse(put?.body ?? ""), { appName: "Pocket ID", allowUserSignups: "withToken", smtpPassword: "smtp-secret", ldapBindPassword: "" });
  assert.doesNotMatch(text(result), /smtp-secret/, "the tool result does not echo the configuration's credentials");
});

test("SCIM provider writes do not return the bearer token", async () => {
  for (const [name, args] of [
    ["pocketid_create_scim_provider", { endpoint: "https://scim.example.com", token: "new-secret", oidcClientId: "c1" }],
    ["pocketid_update_scim_provider", { provider_id: "s1", endpoint: "https://scim.example.com", oidcClientId: "c1" }],
  ] as const) {
    const result = await call(name, args);
    assert.notEqual(result.isError, true, text(result));
    assert.match(last().body, /secret/, `${name} sends the real token to Pocket ID`);
    assert.doesNotMatch(text(result), /secret/, name);
    assert.equal((JSON.parse(text(result)) as { token: string }).token, HIDDEN, name);
  }
});

test("fetched objects with null fields can be sent back unchanged", async () => {
  const user = { user_id: "u1", username: "bob", email: null, locale: null, lastName: null, emailVerified: false, isAdmin: false, disabled: false };
  assert.notEqual((await call("pocketid_update_user", user)).isError, true);
  assert.equal((JSON.parse(last().body) as { locale: unknown }).locale, null);
  const client = { client_id: "c1", ...CLIENT, launchURL: null, logoutCallbackURLs: null, callbackURLs: null };
  assert.notEqual((await call("pocketid_update_oidc_client", client)).isError, true);
  assert.equal((JSON.parse(last().body) as { launchURL: unknown }).launchURL, null);
});

test("a SCIM provider update without a new token keeps the current one", async () => {
  for (const token of [undefined, HIDDEN]) {
    const result = await call("pocketid_update_scim_provider", { provider_id: "s1", endpoint: "https://scim2.example.com", oidcClientId: "c1", ...(token ? { token } : {}) });
    assert.notEqual(result.isError, true, text(result));
    const [get, put] = seen.slice(-2);
    assert.equal(get?.path, "/api/oidc/clients/c1/scim-service-provider");
    assert.equal(put?.path, "/api/scim/service-provider/s1");
    assert.deepEqual(JSON.parse(put?.body ?? ""), { endpoint: "https://scim2.example.com", oidcClientId: "c1", token: "scim-secret" });
  }
  const before = seen.length;
  const moved = await call("pocketid_update_scim_provider", { provider_id: "s2", endpoint: "https://scim.example.com", oidcClientId: "c1" });
  assert.equal(moved.isError, true);
  assert.match(text(moved), /Pass the token explicitly/);
  assert.equal(seen.length, before + 1, "only the lookup reached Pocket ID, nothing was saved");
});

test("update_app_config treats a hidden password as unchanged", async () => {
  await call("pocketid_update_app_config", { changes: { smtpPassword: HIDDEN, appName: "ID" } });
  assert.deepEqual(JSON.parse(last().body), { appName: "ID", allowUserSignups: "disabled", smtpPassword: "smtp-secret", ldapBindPassword: "" });
});

test("update_app_config rejects unknown keys and empty changes without saving", async () => {
  const before = seen.length;
  const unknown = await call("pocketid_update_app_config", { changes: { appname: "typo" } });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /Unknown configuration keys: appname/);
  assert.equal(seen.length, before + 1, "only the GET reached Pocket ID");
  assert.equal(last().method, "GET");
  assert.equal((await call("pocketid_update_app_config", { changes: {} })).isError, true);
  assert.equal(seen.length, before + 1);
});

test("input is validated before anything is sent", async () => {
  const before = seen.length;
  for (const [name, args] of [
    ["pocketid_create_user", { username: "a", email: "not-an-email" }],
    ["pocketid_update_user", { user_id: "u1", username: "a" }],
    ["pocketid_create_group", { friendlyName: "x", name: "ok" }],
    ["pocketid_create_signup_token", { ttl: "tomorrow", usageLimit: 1 }],
    ["pocketid_create_signup_token", { ttl: "24h", usageLimit: 101 }],
    ["pocketid_create_oidc_client_secret", { client_id: "c1", secret: "short" }],
    ["pocketid_create_oidc_client_secret", { client_id: "c1", expiresAt: "next week" }],
    ["pocketid_create_oidc_client", { name: "x" }],
  ] as const) {
    const result = await call(name, args as Record<string, unknown>);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(seen.length, before, "invalid input must not reach Pocket ID");
});

test("an OIDC client update sends inline federated public keys back with all their key material", async () => {
  const key = { kty: "EC", kid: "k1", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0", use: "sig" };
  const credentials = { federatedIdentities: [{ issuer: "https://ci.example.com", publicKeys: [key], replayProtection: true }] };
  const result = await call("pocketid_update_oidc_client", { client_id: "c1", ...CLIENT, credentials });
  assert.notEqual(result.isError, true, text(result));
  assert.deepEqual((JSON.parse(last().body) as { credentials: unknown }).credentials, credentials);
  const before = seen.length;
  const bad = await call("pocketid_update_oidc_client", { client_id: "c1", ...CLIENT, credentials: { federatedIdentities: [{ issuer: "i", publicKeys: [{ kty: "EC" }] }] } });
  assert.equal(bad.isError, true, "a key without kid is refused");
  assert.equal(seen.length, before);
});

test("unknown argument keys are stripped before the body is sent", async () => {
  await call("pocketid_create_group", { friendlyName: "Ops", name: "ops", id: "forged", isAdmin: true });
  assert.deepEqual(JSON.parse(last().body), { friendlyName: "Ops", name: "ops" });
});

test("Pocket ID errors come back as tool errors", async () => {
  const failing = await (async () => {
    const server = new McpServer({ name: "pocketid", version: "test" });
    const pocketid = new PocketIdClient(`${baseUrl}/api/fail`, "pid_test_key");
    registerReadTools(server, pocketid);
    registerWriteTools(server, pocketid);
    return connect(server);
  })();
  try {
    for (const [name, args] of [
      ["pocketid_get_user", { user_id: "u1" }],
      ["pocketid_delete_user", { user_id: "u1" }],
      ["pocketid_update_app_config", { changes: { appName: "x" } }],
    ] as const) {
      const result = (await failing.callTool({ name, arguments: args })) as CallToolResult;
      assert.equal(result.isError, true, name);
      assert.match(text(result), /^Pocket ID API returned HTTP 400 for /, name);
    }
  } finally {
    await failing.close();
  }
});

test("PocketIdClient does not expose the API key when serialized or inspected", () => {
  const pocketid = new PocketIdClient("https://id.example.com", "pid_supersecret");
  assert.doesNotMatch(JSON.stringify(pocketid), /supersecret/);
  assert.doesNotMatch(String(Object.entries(pocketid)), /supersecret/);
});

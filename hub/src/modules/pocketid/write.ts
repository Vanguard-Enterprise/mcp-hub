import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JsonApiClient } from "../http.js";
import { ACTION, CREATE, DELETE, id, seg, ToolInputError, ToolRegistrar, UPDATE } from "../tools.js";
import type { PocketIdClient } from "./client.js";
import { redactAppConfig } from "./read.js";

const REPLACES =
  "Replaces the whole object: fetch it first with the matching pocketid_get_* tool and send every field back with your changes; " +
  "an omitted field is reset (booleans to false, strings to empty).";

const ids = (what: string) => z.array(z.string().min(1)).describe(what);

// Go duration (e.g. "24h", "90m", "1h30m") or a number of seconds, as Pocket ID's JSONDuration accepts.
const ttl = (what: string) =>
  z
    .union([z.string().regex(/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/, 'a Go duration such as "24h" or "90m"'), z.number().int().positive()])
    .describe(`${what}: a duration such as "24h" or "90m", or a number of seconds; more than 1s and at most 744h (31 days)`);

const timestamp = z.iso.datetime({ offset: true });

const USER = {
  username: z.string().min(1).max(50).describe("Username: letters, digits, _ . - @, not starting or ending with a special character"),
  email: z.email().optional().describe("Email address"),
  emailVerified: z.boolean().optional().describe("Whether the email address counts as verified"),
  firstName: z.string().max(50).optional(),
  lastName: z.string().max(50).optional(),
  displayName: z.string().max(100).optional(),
  isAdmin: z.boolean().optional().describe("Pocket ID administrator: full control of the identity provider"),
  locale: z.string().optional().describe("UI locale, e.g. en-US"),
  disabled: z.boolean().optional().describe("Disabled users cannot sign in"),
};

const USER_UPDATE = {
  ...USER,
  emailVerified: z.boolean().describe("Whether the email address counts as verified"),
  isAdmin: z.boolean().describe("Pocket ID administrator: full control of the identity provider"),
  disabled: z.boolean().describe("Disabled users cannot sign in"),
};

const GROUP = {
  friendlyName: z.string().min(2).max(50).describe("Display name"),
  name: z.string().min(2).max(255).describe("Group name as it appears in the groups claim, e.g. mcp_netbird_read"),
};

const CLAIMS = {
  claims: z
    .array(z.object({ key: z.string().min(1), value: z.string().min(1) }))
    .describe("The complete list of custom claims; claims not in the list are removed. An empty list removes all"),
};

const FEDERATED_IDENTITY = z.object({
  issuer: z.string().min(1).describe("Issuer of the external tokens the client authenticates with"),
  subject: z.string().optional().describe("Expected subject (default: the client ID)"),
  audience: z.string().optional().describe("Expected audience (default: the Pocket ID URL)"),
  jwks: z.string().optional().describe("JWKS URL of the issuer (default: discovered). Mutually exclusive with publicKeys"),
  // Loose objects: the key material (n, e, x, y, crv, ...) depends on the key type and must reach Pocket ID unchanged.
  publicKeys: z
    .array(z.looseObject({ kty: z.string().min(1), kid: z.string().min(1) }))
    .optional()
    .describe('Inline public JWKs instead of a JWKS URL: each needs a unique kid, no private key material, and use "sig" if use is set'),
  replayProtection: z.boolean().optional().describe("Reject reused assertions"),
});

const CLIENT = {
  name: z.string().min(1).max(50).describe("Client name shown to users"),
  description: z.string().max(150).optional(),
  callbackURLs: z.array(z.string().min(1)).optional().describe("Allowed redirect URIs; * wildcards are allowed"),
  logoutCallbackURLs: z.array(z.string().min(1)).optional().describe("Allowed post-logout redirect URIs"),
  backchannelLogoutURL: z.string().optional().describe("Back-channel logout endpoint of the client"),
  isPublic: z.boolean().describe("Public client (no secret, e.g. a native or browser app); public clients must use PKCE"),
  pkceEnabled: z.boolean().describe("Require PKCE"),
  requiresReauthentication: z.boolean().optional().describe("Ask the user to authenticate again on every authorization"),
  requiresPushedAuthorizationRequests: z.boolean().optional().describe("Require pushed authorization requests (PAR)"),
  skipConsent: z.boolean().optional().describe("Skip the consent screen"),
  credentials: z
    .object({ federatedIdentities: z.array(FEDERATED_IDENTITY).optional() })
    .optional()
    .describe("Federated client credentials (JWT assertions from another issuer). Secrets are managed with the secret tools"),
  launchURL: z.url().optional().describe("URL that the user's app list opens"),
  logoUrl: z.url().optional().describe("Download the light logo from this URL (the server's egress policy may block the host)"),
  darkLogoUrl: z.url().optional().describe("Download the dark logo from this URL"),
  isGroupRestricted: z.boolean().optional().describe("Only members of the allowed groups may sign in (set them with pocketid_set_oidc_client_allowed_groups)"),
  accessTokenDurationMinutes: z.number().int().positive().optional().describe("Access token lifetime in minutes"),
  refreshTokenDurationMinutes: z.number().int().positive().optional().describe("Refresh token lifetime in minutes"),
};

const API_PERMISSION = z.object({
  key: z.string().min(1).max(128).describe("Scope value, e.g. read:reports"),
  name: z.string().min(1).max(50).describe("Display name"),
  description: z.string().max(200).optional(),
});

const SCIM_PROVIDER = {
  endpoint: z.url().describe("SCIM base URL of the service provider"),
  token: z.string().optional().describe("Bearer token Pocket ID sends to the service provider"),
  oidcClientId: z.string().min(1).describe("ID of the OIDC client whose users and groups are provisioned"),
};

/** Fetches the full configuration and returns it as a key/value object with `changes` applied. */
export async function mergedAppConfig(client: JsonApiClient, changes: Record<string, string>): Promise<Record<string, string>> {
  const current = await client.get("/api/application-configuration/all");
  if (!Array.isArray(current)) throw new ToolInputError("Pocket ID returned an unexpected application configuration format");
  const config: Record<string, string> = {};
  for (const entry of current as { key?: unknown; value?: unknown }[]) {
    if (typeof entry?.key === "string") config[entry.key] = typeof entry.value === "string" ? entry.value : String(entry.value ?? "");
  }
  const unknown = Object.keys(changes).filter((key) => !(key in config));
  if (unknown.length > 0) throw new ToolInputError(`Unknown configuration keys: ${unknown.join(", ")}. See pocketid_get_app_config for the valid keys.`);
  return { ...config, ...changes };
}

/**
 * Registers the tools that change Pocket ID: users, groups, OIDC clients, APIs, sign-up tokens,
 * SCIM providers, and the application configuration. `subject` is the caller's OAuth subject;
 * every write is logged with it, because Pocket ID attributes API-key calls to the key's owner.
 */
export function registerWriteTools(server: McpServer, pocketid: PocketIdClient, subject?: string): void {
  const tools = new ToolRegistrar(server, pocketid, subject);
  const write = tools.write.bind(tools);

  // Users
  write("pocketid_create_user", "Create a user, optionally in groups. The user then needs a passkey: send a login code or email with the one-time access tools.", CREATE, {
    ...USER,
    userGroupIds: ids("IDs of the groups the user joins").optional(),
  }, (b) => ({ method: "POST", path: "/api/users", body: b }));
  write(
    "pocketid_update_user",
    `Update a user's profile, admin flag, and disabled state. Group memberships are not changed (use pocketid_set_user_groups). ${REPLACES}`,
    UPDATE,
    { user_id: id("user"), ...USER_UPDATE },
    ({ user_id, ...b }) => ({ method: "PUT", path: `/api/users/${seg(user_id)}`, body: b }),
  );
  write("pocketid_delete_user", "Delete a user. Prefer disabling with pocketid_update_user when the account may come back.", DELETE, { user_id: id("user") }, ({ user_id }) => ({
    method: "DELETE",
    path: `/api/users/${seg(user_id)}`,
  }));
  write(
    "pocketid_set_user_groups",
    "Set the complete list of groups a user belongs to; groups not in the list are left. Group membership decides which applications, and which mcp-hub sections, the user may use.",
    UPDATE,
    { user_id: id("user"), userGroupIds: ids("IDs of every group the user should be in") },
    ({ user_id, ...b }) => ({ method: "PUT", path: `/api/users/${seg(user_id)}/user-groups`, body: b }),
  );
  write("pocketid_set_user_custom_claims", "Set a user's custom claims (added to their tokens).", UPDATE, { user_id: id("user"), ...CLAIMS }, ({ user_id, claims }) => ({
    method: "PUT",
    path: `/api/custom-claims/user/${seg(user_id)}`,
    body: claims,
  }));
  write(
    "pocketid_delete_user_passkey",
    "Delete one of a user's passkeys. A user without passkeys can only sign in with a one-time access code.",
    DELETE,
    { user_id: id("user"), credential_id: id("passkey (WebAuthn credential)") },
    ({ user_id, credential_id }) => ({ method: "DELETE", path: `/api/users/${seg(user_id)}/webauthn-credentials/${seg(credential_id)}` }),
  );
  write(
    "pocketid_create_one_time_access_token",
    "Create a one-time login code for a user, e.g. to add a first passkey. The response holds the code, which signs in as that user; share it only with them. Sign in at <Pocket ID URL>/lc/<token>.",
    CREATE,
    { user_id: id("user"), ttl: ttl("How long the code stays valid (default 15m)").optional() },
    ({ user_id, ...b }) => ({ method: "POST", path: `/api/users/${seg(user_id)}/one-time-access-token`, body: b }),
  );
  write(
    "pocketid_send_one_time_access_email",
    "Email a user a one-time login link. Needs SMTP and the admin email login option in the application configuration.",
    ACTION,
    { user_id: id("user"), ttl: ttl("How long the link stays valid (default 15m)").optional() },
    ({ user_id, ...b }) => ({ method: "POST", path: `/api/users/${seg(user_id)}/one-time-access-email`, body: b }),
  );

  // Groups
  write("pocketid_create_group", "Create a user group. Add members with pocketid_set_group_users.", CREATE, GROUP, (b) => ({ method: "POST", path: "/api/user-groups", body: b }));
  write(
    "pocketid_update_group",
    "Rename a user group. Changing `name` changes the groups claim, which breaks every access rule that names the old value (including the mcp-hub access policy).",
    UPDATE,
    { group_id: id("user group"), ...GROUP },
    ({ group_id, ...b }) => ({ method: "PUT", path: `/api/user-groups/${seg(group_id)}`, body: b }),
  );
  write("pocketid_delete_group", "Delete a user group. Members lose whatever access the group granted.", DELETE, { group_id: id("user group") }, ({ group_id }) => ({
    method: "DELETE",
    path: `/api/user-groups/${seg(group_id)}`,
  }));
  write(
    "pocketid_set_group_users",
    "Set the complete member list of a group; users not in the list are removed. Fetch the group first with pocketid_get_group to keep existing members.",
    UPDATE,
    { group_id: id("user group"), userIds: ids("IDs of every user who should be a member") },
    ({ group_id, ...b }) => ({ method: "PUT", path: `/api/user-groups/${seg(group_id)}/users`, body: b }),
  );
  write(
    "pocketid_set_group_allowed_clients",
    "Set the complete list of group-restricted OIDC clients this group's members may sign in to.",
    UPDATE,
    { group_id: id("user group"), oidcClientIds: ids("IDs of every OIDC client the group may use") },
    ({ group_id, ...b }) => ({ method: "PUT", path: `/api/user-groups/${seg(group_id)}/allowed-oidc-clients`, body: b }),
  );
  write("pocketid_set_group_custom_claims", "Set a group's custom claims (added to its members' tokens).", UPDATE, { group_id: id("user group"), ...CLAIMS }, ({ group_id, claims }) => ({
    method: "PUT",
    path: `/api/custom-claims/user-group/${seg(group_id)}`,
    body: claims,
  }));

  // OIDC clients
  write(
    "pocketid_create_oidc_client",
    "Create an OIDC client. For a confidential client the response may include `createdSecret`, the only time Pocket ID returns that secret's value.",
    CREATE,
    { id: z.string().min(2).max(128).optional().describe("Custom client ID (default: generated UUID)"), ...CLIENT },
    (b) => ({ method: "POST", path: "/api/oidc/clients", body: b }),
  );
  write("pocketid_update_oidc_client", `Update an OIDC client's settings. ${REPLACES}`, UPDATE, { client_id: id("OIDC client"), ...CLIENT }, ({ client_id, ...b }) => ({
    method: "PUT",
    path: `/api/oidc/clients/${seg(client_id)}`,
    body: b,
  }));
  write("pocketid_delete_oidc_client", "Delete an OIDC client. Applications using it can no longer sign users in.", DELETE, { client_id: id("OIDC client") }, ({ client_id }) => ({
    method: "DELETE",
    path: `/api/oidc/clients/${seg(client_id)}`,
  }));
  write(
    "pocketid_set_oidc_client_allowed_groups",
    "Set the complete list of groups allowed to sign in to a group-restricted OIDC client.",
    UPDATE,
    { client_id: id("OIDC client"), userGroupIds: ids("IDs of every group that may use the client") },
    ({ client_id, ...b }) => ({ method: "PUT", path: `/api/oidc/clients/${seg(client_id)}/allowed-user-groups`, body: b }),
  );
  write(
    "pocketid_create_oidc_client_secret",
    "Create a client secret. The response is the only time its value is returned; hand it to the application's configuration (e.g. a secret store), not to chat logs.",
    CREATE,
    {
      client_id: id("OIDC client"),
      secret: z.string().min(16).regex(/^[\x20-\x7e]+$/, "printable ASCII").optional().describe("Use this value instead of a generated one (at least 16 printable ASCII characters)"),
      expiresAt: timestamp.optional().describe("RFC 3339 time after which the secret stops working (default: never)"),
    },
    ({ client_id, ...b }) => ({ method: "POST", path: `/api/oidc/clients/${seg(client_id)}/secrets`, body: b }),
  );
  write(
    "pocketid_delete_oidc_client_secret",
    "Delete a client secret. Applications still using it fail to authenticate immediately.",
    DELETE,
    { client_id: id("OIDC client"), secret_id: id("client secret") },
    ({ client_id, secret_id }) => ({ method: "DELETE", path: `/api/oidc/clients/${seg(client_id)}/secrets/${seg(secret_id)}` }),
  );

  // APIs (OAuth resource servers)
  write(
    "pocketid_create_api",
    "Create an API (OAuth resource server). `resource` becomes the audience of tokens issued for it.",
    CREATE,
    { name: z.string().min(1).max(50), resource: z.string().min(1).max(350).describe("Resource URI, e.g. https://mcp.example.com/mcp") },
    (b) => ({ method: "POST", path: "/api/apis", body: b }),
  );
  write("pocketid_update_api", "Rename an API. The resource URI cannot be changed.", UPDATE, { api_id: id("API"), name: z.string().min(1).max(50) }, ({ api_id, ...b }) => ({
    method: "PUT",
    path: `/api/apis/${seg(api_id)}`,
    body: b,
  }));
  write("pocketid_delete_api", "Delete an API. Clients can no longer get tokens for its resource.", DELETE, { api_id: id("API") }, ({ api_id }) => ({
    method: "DELETE",
    path: `/api/apis/${seg(api_id)}`,
  }));
  write(
    "pocketid_set_api_permissions",
    "Set the complete list of an API's permissions (scopes); permissions not in the list are removed.",
    UPDATE,
    { api_id: id("API"), permissions: z.array(API_PERMISSION) },
    ({ api_id, ...b }) => ({ method: "PUT", path: `/api/apis/${seg(api_id)}/permissions`, body: b }),
  );
  write(
    "pocketid_set_api_metadata_client_access",
    "Set whether clients identified by a metadata document URL (CIMD) may request tokens for this API, and which permissions they may request.",
    UPDATE,
    { api_id: id("API"), enabled: z.boolean(), permissionIds: ids("Permission IDs CIMD clients may request").optional() },
    ({ api_id, ...b }) => ({ method: "PUT", path: `/api/apis/${seg(api_id)}/cimd-access`, body: b }),
  );
  write(
    "pocketid_set_api_client_access",
    "Grant or change an OIDC client's access to an API: user-delegated access (tokens for signed-in users) and/or client access (client credentials), each with its permission IDs.",
    UPDATE,
    {
      api_id: id("API"),
      client_id: id("OIDC client"),
      userDelegatedAccess: z.boolean(),
      clientAccess: z.boolean(),
      userDelegatedPermissionIds: ids("Permission IDs for user-delegated tokens").optional(),
      clientPermissionIds: ids("Permission IDs for client-credentials tokens").optional(),
    },
    ({ api_id, client_id, ...b }) => ({ method: "PUT", path: `/api/apis/${seg(api_id)}/clients/${seg(client_id)}`, body: b }),
  );
  write(
    "pocketid_remove_api_client_access",
    "Remove an OIDC client's access to an API.",
    DELETE,
    { api_id: id("API"), client_id: id("OIDC client") },
    ({ api_id, client_id }) => ({ method: "DELETE", path: `/api/apis/${seg(api_id)}/clients/${seg(client_id)}` }),
  );

  // Sign-up tokens
  write(
    "pocketid_create_signup_token",
    "Create a sign-up token (invitation) that lets people create their own account, optionally joining groups. The response holds the token value; the sign-up link is <Pocket ID URL>/st/<token>.",
    CREATE,
    {
      ttl: ttl("How long the token stays valid"),
      usageLimit: z.number().int().min(1).max(100).describe("How many accounts the token can create"),
      userGroupIds: ids("IDs of the groups new accounts join").optional(),
    },
    (b) => ({ method: "POST", path: "/api/signup-tokens", body: b }),
  );
  write("pocketid_delete_signup_token", "Delete a sign-up token so it can no longer be used.", DELETE, { token_id: id("sign-up token") }, ({ token_id }) => ({
    method: "DELETE",
    path: `/api/signup-tokens/${seg(token_id)}`,
  }));

  // SCIM provisioning
  write("pocketid_create_scim_provider", "Provision an OIDC client's users and groups to a SCIM service provider.", CREATE, SCIM_PROVIDER, (b) => ({
    method: "POST",
    path: "/api/scim/service-provider",
    body: b,
  }));
  write(
    "pocketid_update_scim_provider",
    `Update a SCIM service provider's endpoint, token, or client. ${REPLACES}`,
    UPDATE,
    { provider_id: id("SCIM service provider"), ...SCIM_PROVIDER },
    ({ provider_id, ...b }) => ({ method: "PUT", path: `/api/scim/service-provider/${seg(provider_id)}`, body: b }),
  );
  write("pocketid_delete_scim_provider", "Delete a SCIM service provider; Pocket ID stops provisioning to it.", DELETE, { provider_id: id("SCIM service provider") }, ({ provider_id }) => ({
    method: "DELETE",
    path: `/api/scim/service-provider/${seg(provider_id)}`,
  }));
  write("pocketid_sync_scim_provider", "Push all users and groups to a SCIM service provider now.", ACTION, { provider_id: id("SCIM service provider") }, ({ provider_id }) => ({
    method: "POST",
    path: `/api/scim/service-provider/${seg(provider_id)}/sync`,
  }));

  // Application configuration
  write(
    "pocketid_update_app_config",
    "Change application configuration values. Pass only the keys to change (values are strings, e.g. \"true\"); the hub reads the current configuration, applies the changes, and saves the whole configuration. Keys come from pocketid_get_app_config.",
    UPDATE,
    { changes: z.record(z.string().min(1), z.string()).refine((c) => Object.keys(c).length > 0, "at least one change").describe("Configuration keys and their new values") },
    // Pocket ID answers with the saved configuration, credentials included.
    async ({ changes }, client) => ({
      method: "PUT",
      path: "/api/application-configuration",
      body: await mergedAppConfig(client, changes),
      transform: redactAppConfig,
    }),
  );
  write("pocketid_sync_ldap", "Run the LDAP synchronization now (only when LDAP is enabled in the configuration).", ACTION, {}, () => ({
    method: "POST",
    path: "/api/application-configuration/sync-ldap",
  }));
}

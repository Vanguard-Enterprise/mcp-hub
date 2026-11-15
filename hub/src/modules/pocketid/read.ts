import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Query } from "../http.js";
import { id, seg, ToolRegistrar } from "../tools.js";
import type { PocketIdClient } from "./client.js";

/** Placeholder for credentials that read tools never return. */
export const HIDDEN = "[hidden]";
/** Application configuration keys holding credentials. */
export const SECRET_CONFIG_KEYS = new Set(["smtpPassword", "ldapBindPassword"]);

const LIST = {
  search: z.string().optional().describe("Search term"),
  page: z.number().int().min(1).optional().describe("Page number (default 1)"),
  limit: z.number().int().min(1).max(100).optional().describe("Items per page (default 20, at most 100)"),
  sort_column: z.string().optional().describe("Column to sort by, e.g. username, email, name, createdAt"),
  sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default asc)"),
};

type ListArgs = { search?: string; page?: number; limit?: number; sort_column?: string; sort_direction?: "asc" | "desc" };

/** Pocket ID's list parameters: `search`, `pagination[page|limit]`, `sort[column|direction]`, `filters[field]`. */
function listQuery({ search, page, limit, sort_column, sort_direction }: ListArgs, filters: Record<string, string | boolean | undefined> = {}): Query {
  const query: Query = { search, "pagination[page]": page, "pagination[limit]": limit, "sort[column]": sort_column, "sort[direction]": sort_direction };
  for (const [field, value] of Object.entries(filters)) query[`filters[${field}]`] = value;
  return query;
}

const PAGED = "Paginated: the response has `data` and `pagination` (totalPages, totalItems, currentPage, itemsPerPage).";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replaces the values of SMTP and LDAP passwords in the `[{key, type, value}]` configuration list. */
export function redactAppConfig(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((entry) =>
    isRecord(entry) && typeof entry.key === "string" && SECRET_CONFIG_KEYS.has(entry.key) && entry.value ? { ...entry, value: HIDDEN } : entry,
  );
}

/** Replaces a `token` field, on one object or on every item of a paginated `data` list. */
export function redactToken(data: unknown): unknown {
  const hide = (item: unknown) => (isRecord(item) && typeof item.token === "string" && item.token ? { ...item, token: HIDDEN } : item);
  if (isRecord(data) && Array.isArray(data.data)) return { ...data, data: data.data.map(hide) };
  return hide(data);
}

export function registerReadTools(server: McpServer, pocketid: PocketIdClient): void {
  // Every read tool is a single GET against the admin API. None returns a credential.
  const tools = new ToolRegistrar(server, pocketid);
  const get = tools.read.bind(tools);

  // Users
  get(
    "pocketid_list_users",
    `List users with their groups and custom claims, optionally searched and filtered. ${PAGED}`,
    {
      ...LIST,
      is_admin: z.boolean().optional().describe("true: only admins; false: only non-admins"),
      disabled: z.boolean().optional().describe("true: only disabled users; false: only enabled users"),
    },
    ({ is_admin, disabled, ...list }) => ({ path: "/api/users", query: listQuery(list, { isAdmin: is_admin, disabled }) }),
  );
  get("pocketid_get_user", "Retrieve one user by ID, including groups and custom claims.", { user_id: id("user") }, ({ user_id }) => ({
    path: `/api/users/${seg(user_id)}`,
  }));
  get("pocketid_list_groups_of_user", "List the groups a user belongs to.", { user_id: id("user") }, ({ user_id }) => ({
    path: `/api/users/${seg(user_id)}/groups`,
  }));
  get("pocketid_list_user_passkeys", "List a user's passkeys (WebAuthn credentials): name, type, and when they were created and last used.", { user_id: id("user") }, ({ user_id }) => ({
    path: `/api/users/${seg(user_id)}/webauthn-credentials`,
  }));
  get(
    "pocketid_list_user_authorized_clients",
    `List the OIDC clients a user has authorized, with the granted scopes and last use. ${PAGED}`,
    { user_id: id("user"), ...LIST },
    ({ user_id, ...list }) => ({ path: `/api/oidc/users/${seg(user_id)}/authorized-clients`, query: listQuery(list) }),
  );

  // Groups
  get(
    "pocketid_list_groups",
    `List user groups with their member count and custom claims. \`name\` is the value that appears in the groups claim. ${PAGED}`,
    LIST,
    (list) => ({ path: "/api/user-groups", query: listQuery(list) }),
  );
  get("pocketid_get_group", "Retrieve one user group by ID, including its members and the OIDC clients it may use.", { group_id: id("user group") }, ({ group_id }) => ({
    path: `/api/user-groups/${seg(group_id)}`,
  }));

  // OIDC clients
  get("pocketid_list_oidc_clients", `List OIDC clients (applications that sign in through Pocket ID). ${PAGED}`, LIST, (list) => ({
    path: "/api/oidc/clients",
    query: listQuery(list),
  }));
  get(
    "pocketid_get_oidc_client",
    "Retrieve one OIDC client by ID: callback URLs, public/PKCE settings, token durations, federated identities, group restriction and allowed groups. Secret values are never included.",
    { client_id: id("OIDC client") },
    ({ client_id }) => ({ path: `/api/oidc/clients/${seg(client_id)}` }),
  );
  get(
    "pocketid_list_oidc_client_secrets",
    "List an OIDC client's secrets: ID, prefix, creation and expiry, and whether active. The secret values are never returned.",
    { client_id: id("OIDC client") },
    ({ client_id }) => ({ path: `/api/oidc/clients/${seg(client_id)}/secrets` }),
  );
  get(
    "pocketid_preview_oidc_client_claims",
    "Preview the ID token, access token, and userinfo claims a user would receive from an OIDC client for the given scopes. Returns claims only, not usable tokens.",
    {
      client_id: id("OIDC client"),
      user_id: id("user"),
      scopes: z
        .array(z.string().regex(/^\S+$/, "a single scope without spaces"))
        .min(1)
        .default(["openid", "profile", "email", "groups"])
        .describe("Scopes the client requests (default openid, profile, email, groups)"),
    },
    // Pocket ID requires `scopes` and splits it on spaces.
    ({ client_id, user_id, scopes }) => ({ path: `/api/oidc/clients/${seg(client_id)}/preview/${seg(user_id)}`, query: { scopes: scopes.join(" ") } }),
  );
  get(
    "pocketid_list_oidc_client_apis",
    "List the APIs an OIDC client may request tokens for, with its user-delegated and client (machine-to-machine) access and permissions.",
    { client_id: id("OIDC client") },
    ({ client_id }) => ({ path: `/api/api-access/${seg(client_id)}/apis` }),
  );
  get(
    "pocketid_get_oidc_client_scim_provider",
    "Retrieve the SCIM service provider that provisions an OIDC client's users and groups. Its bearer token is hidden.",
    { client_id: id("OIDC client") },
    ({ client_id }) => ({ path: `/api/oidc/clients/${seg(client_id)}/scim-service-provider`, transform: redactToken }),
  );

  // APIs (OAuth resource servers)
  get(
    "pocketid_list_apis",
    `List APIs (OAuth resource servers). An API's \`resource\` is the token audience clients request with the RFC 8707 resource parameter. ${PAGED}`,
    LIST,
    (list) => ({ path: "/api/apis", query: listQuery(list) }),
  );
  get("pocketid_get_api", "Retrieve one API by ID, including its permissions (scopes).", { api_id: id("API") }, ({ api_id }) => ({ path: `/api/apis/${seg(api_id)}` }));
  get(
    "pocketid_list_api_clients",
    `List the OIDC clients that have access to an API and which permissions each holds. ${PAGED}`,
    { api_id: id("API"), ...LIST },
    ({ api_id, ...list }) => ({ path: `/api/apis/${seg(api_id)}/clients`, query: listQuery(list) }),
  );

  // Sign-up tokens
  // Pocket ID has no search for sign-up tokens.
  const { search: _search, ...LIST_NO_SEARCH } = LIST;
  get("pocketid_list_signup_tokens", `List sign-up tokens (invitations): expiry, usage, and groups. Token values are hidden. ${PAGED}`, LIST_NO_SEARCH, (list) => ({
    path: "/api/signup-tokens",
    query: listQuery(list),
    transform: redactToken,
  }));

  // Audit log
  get(
    "pocketid_list_audit_logs",
    `List audit log events for all users, newest first by default: sign-ins, client authorizations, passkey changes, account creation. ${PAGED}`,
    {
      page: LIST.page,
      limit: LIST.limit,
      sort_column: z.string().optional().describe("Column to sort by (default createdAt): createdAt, event, ipAddress, country, city"),
      sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)"),
      event: z
        .enum([
          "SIGN_IN",
          "TOKEN_SIGN_IN",
          "REMOTE_SIGN_IN",
          "ACCOUNT_CREATED",
          "CLIENT_AUTHORIZATION",
          "NEW_CLIENT_AUTHORIZATION",
          "DEVICE_CODE_AUTHORIZATION",
          "NEW_DEVICE_CODE_AUTHORIZATION",
          "PASSKEY_ADDED",
          "PASSKEY_REMOVED",
        ])
        .optional()
        .describe("Only this event type"),
      user_id: z.string().min(1).optional().describe("Only events of this user"),
      client_name: z.string().min(1).optional().describe("Only events for the OIDC client with this name"),
      location: z.enum(["internal", "external"]).optional().describe("Only events from the internal or the external network"),
    },
    ({ page, limit, sort_column, sort_direction, event, user_id, client_name, location }) => ({
      path: "/api/audit-logs/all",
      query: listQuery(
        { page, limit, sort_column: sort_column ?? "createdAt", sort_direction: sort_direction ?? "desc" },
        { event, userID: user_id, clientName: client_name, location },
      ),
    }),
  );

  // Application configuration
  get(
    "pocketid_get_app_config",
    "Retrieve the full application configuration as a list of {key, type, value}: sign-up, session, email, SMTP, LDAP, passkey, and email-verification settings. SMTP and LDAP passwords are hidden.",
    {},
    () => ({ path: "/api/application-configuration/all", transform: redactAppConfig }),
  );
}

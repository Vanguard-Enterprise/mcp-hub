# MCP hub

One [MCP](https://modelcontextprotocol.io) endpoint for all self-hosted MCP
servers, with one [Pocket ID](https://pocket-id.org) login. Each backend is a
module ("section") whose tools share a name prefix. What a caller sees is
decided by their Pocket ID groups: per section, members of its `write` groups
get read and write tools, members of its `read` groups get the read tools, and
everyone else gets none of it. Streamable HTTP, stateless, TypeScript on the
official MCP TypeScript SDK.

## Sections and access

The access policy is a JSON file (`ACCESS_POLICY_FILE`):

```json
{
  "sections": {
    "netbird": { "read": ["mcp_netbird_read"], "write": ["mcp_netbird_write"] },
    "pocketid": { "read": ["mcp_pocketid_read"], "write": ["mcp_pocketid_write"] }
  }
}
```

- Every request builds an MCP server holding only the caller's tools, so
  `tools/list` shows exactly what they may use and a hidden tool cannot be
  called by name.
- Group memberships come from the issuer's userinfo endpoint (Pocket ID puts
  `groups` there, not in access tokens) and are cached per token for 60
  seconds, so removing someone from a group takes effect within a minute.
- `hub_whoami` is always available and shows the caller's groups and access
  per section.
- The policy may only name loaded modules; a typo fails at startup.

### Adding a section

1. Add `src/modules/<name>/` exporting a `HubModule` (name, instructions, and
   `register(server, level, ctx)`), with tool names prefixed `<name>_`. A
   `JsonApiClient` (`src/modules/http.ts`) talks to a REST backend, and a
   `ToolRegistrar` (`src/modules/tools.ts`) registers read tools and audited
   write tools that carry the prompt flag described under the NetBird section.
2. Enable it from its own environment variables in `src/index.ts`.
3. Add `<name>` with its read and write groups to the access policy, and create
   those groups in Pocket ID.

## NetBird section

### Tools

All tools map to endpoints of the current NetBird OpenAPI spec
(`netbirdio/netbird`, `shared/management/http/api/openapi.yml`).

#### Read tools

Read-only (`readOnlyHint: true`), one `GET` each.

| Tool | Endpoint | Arguments |
| --- | --- | --- |
| `netbird_list_peers` | `/api/peers` | `name`, `ip`, `mac` (optional filters) |
| `netbird_get_peer` | `/api/peers/{peerId}` | `peer_id` |
| `netbird_list_groups` | `/api/groups` | `name` (optional, exact match) |
| `netbird_get_group` | `/api/groups/{groupId}` | `group_id` |
| `netbird_list_users` | `/api/users` | `service_user` (optional boolean) |
| `netbird_list_setup_keys` | `/api/setup-keys` | |
| `netbird_get_setup_key` | `/api/setup-keys/{keyId}` | `key_id` |
| `netbird_list_policies` | `/api/policies` | |
| `netbird_get_policy` | `/api/policies/{policyId}` | `policy_id` |
| `netbird_list_routes` | `/api/routes` | |
| `netbird_get_route` | `/api/routes/{routeId}` | `route_id` |
| `netbird_list_nameserver_groups` | `/api/dns/nameservers` | |
| `netbird_get_nameserver_group` | `/api/dns/nameservers/{nsgroupId}` | `nsgroup_id` |
| `netbird_list_dns_zones` | `/api/dns/zones` | |
| `netbird_get_dns_zone` | `/api/dns/zones/{zoneId}` | `zone_id` |
| `netbird_list_dns_records` | `/api/dns/zones/{zoneId}/records` | `zone_id` |
| `netbird_get_dns_record` | `/api/dns/zones/{zoneId}/records/{recordId}` | `zone_id`, `record_id` |

#### Write tools

These change live network configuration. They are annotated as mutating
(`readOnlyHint: false`; updates and deletes also `destructiveHint: true`), but
annotations describe behaviour and do not enforce a prompt. Whether a client
asks before running a tool depends on that client's permission mode; Claude
Code 2.1.283 and later starts in auto mode, where a classifier can approve
calls without asking. Every write tool therefore also carries the
`anthropic/requiresUserInteraction` flag in its `tools/list` entry, which makes
Claude Code prompt on every call in every permission mode (auto, acceptEdits,
bypassPermissions; in dontAsk mode the call is denied) with no "don't ask
again". Use Claude Code 2.1.246 or later for this behaviour: the flag is
documented on its MCP page, and that release fixed the "don't ask again"
option still being offered for such tools. Support in earlier releases is not
documented, so verify it before relying on it. Other clients may ignore the
flag, so also keep write tools out of allow lists and add explicit rules where
you want them, for example in Claude Code's `settings.json`:

```json
{
  "permissions": {
    "ask": ["mcp__hub__netbird_create_*", "mcp__hub__netbird_update_*"],
    "deny": ["mcp__hub__netbird_delete_*"]
  }
}
```

Updates are `PUT`s that replace the whole object: read it first with the
matching `netbird_get_*` tool and send every field back with the change.

| Tool | Endpoint |
| --- | --- |
| `netbird_create_group`, `netbird_update_group`, `netbird_delete_group` | `POST /api/groups`, `PUT`/`DELETE /api/groups/{groupId}` |
| `netbird_create_policy`, `netbird_update_policy`, `netbird_delete_policy` | `POST /api/policies`, `PUT`/`DELETE /api/policies/{policyId}` |
| `netbird_create_route`, `netbird_update_route`, `netbird_delete_route` | `POST /api/routes`, `PUT`/`DELETE /api/routes/{routeId}` |
| `netbird_create_setup_key`, `netbird_update_setup_key`, `netbird_delete_setup_key` | `POST /api/setup-keys`, `PUT`/`DELETE /api/setup-keys/{keyId}` |
| `netbird_create_nameserver_group`, `netbird_update_nameserver_group`, `netbird_delete_nameserver_group` | `POST /api/dns/nameservers`, `PUT`/`DELETE /api/dns/nameservers/{nsgroupId}` |
| `netbird_create_dns_zone`, `netbird_update_dns_zone`, `netbird_delete_dns_zone` | `POST /api/dns/zones`, `PUT`/`DELETE /api/dns/zones/{zoneId}` |
| `netbird_create_dns_record`, `netbird_update_dns_record`, `netbird_delete_dns_record` | `POST /api/dns/zones/{zoneId}/records`, `PUT`/`DELETE .../records/{recordId}` |
| `netbird_update_peer`, `netbird_delete_peer` | `PUT`/`DELETE /api/peers/{peerId}` |

Request bodies are validated against schemas derived from the spec before
anything is sent; invalid input is a tool error and never reaches NetBird.
`netbird_create_setup_key` returns the key's secret value, which the API shows
only once. Not exposed: users, tokens, accounts, posture checks, networks,
ingress, integrations, and anything that is cloud-only.

Tool results are the API's JSON, unchanged, except that `DELETE` (which the API
answers with an empty object) returns a short status object. Every write is
logged with the tool name, method, path, and the caller's OAuth subject, never
the body. NetBird errors (4xx/5xx) come back as tool errors with the status and
body, not as protocol errors.

## Pocket ID section

Administers the [Pocket ID](https://pocket-id.org) instance through its admin
API with an admin user's API key (`X-API-Key`). Endpoints and fields follow
Pocket ID v2.19 (`pocket-id/pocket-id`, `backend/internal`). Request bodies use
the API's own camelCase field names, so what a `get` tool returns can be sent
back to the matching `update` tool; path parameters are snake_case arguments.

Pocket ID is also the hub's login. Group memberships decide which sections and
write tools each user gets, so the write half of this section can grant
access to everything behind the hub, its own write tools included. Keep
`mcp_pocketid_write` as small as Pocket ID's admin list.

### Read tools

Read-only, one `GET` each. List tools take `search`, `page`, `limit` (at most
100), `sort_column`, and `sort_direction`, and return `{data, pagination}`.
Read tools never return credentials: SMTP and LDAP passwords, SCIM bearer
tokens, and sign-up token values come back as `[hidden]`, and client secrets
are only ever listed by prefix.

| Tool | Endpoint | Arguments |
| --- | --- | --- |
| `pocketid_list_users` | `/api/users` | list arguments, `is_admin`, `disabled` |
| `pocketid_get_user` | `/api/users/{id}` | `user_id` |
| `pocketid_list_groups_of_user` | `/api/users/{id}/groups` | `user_id` |
| `pocketid_list_user_passkeys` | `/api/users/{id}/webauthn-credentials` | `user_id` |
| `pocketid_list_user_authorized_clients` | `/api/oidc/users/{id}/authorized-clients` | `user_id`, list arguments |
| `pocketid_list_groups` | `/api/user-groups` | list arguments |
| `pocketid_get_group` | `/api/user-groups/{id}` | `group_id` |
| `pocketid_list_oidc_clients` | `/api/oidc/clients` | list arguments |
| `pocketid_get_oidc_client` | `/api/oidc/clients/{id}` | `client_id` |
| `pocketid_list_oidc_client_secrets` | `/api/oidc/clients/{id}/secrets` | `client_id` |
| `pocketid_preview_oidc_client_claims` | `/api/oidc/clients/{id}/preview/{userId}` | `client_id`, `user_id` |
| `pocketid_list_oidc_client_apis` | `/api/api-access/{clientId}/apis` | `client_id` |
| `pocketid_get_oidc_client_scim_provider` | `/api/oidc/clients/{id}/scim-service-provider` | `client_id` |
| `pocketid_list_apis` | `/api/apis` | list arguments |
| `pocketid_get_api` | `/api/apis/{id}` | `api_id` |
| `pocketid_list_api_clients` | `/api/apis/{id}/clients` | `api_id`, list arguments |
| `pocketid_list_signup_tokens` | `/api/signup-tokens` | list arguments |
| `pocketid_list_audit_logs` | `/api/audit-logs/all` | `page`, `limit`, `sort_*` (default newest first), `event`, `user_id`, `client_name`, `location` |
| `pocketid_get_app_config` | `/api/application-configuration/all` | |

### Write tools

Annotated and flagged like the NetBird write tools (`readOnlyHint: false`,
`destructiveHint` on updates, sets, removals, and deletes, and
`anthropic/requiresUserInteraction` on every one), validated against the API's
binding rules before anything is sent, and logged with the caller's subject.
Pocket ID's own audit log attributes every call to the API key's owner.

`pocketid_update_*` tools are `PUT`s that replace the whole object, and
`pocketid_set_*` tools replace the whole list they set: read first and send
everything back with the change. `pocketid_update_app_config` is the
exception: it takes only the keys to change, reads the current configuration
(with the real credentials) itself, and saves the merged result, so a change
to one setting cannot wipe the SMTP or LDAP password. Unknown keys are refused
before anything is saved. Credentials sent back as the `[hidden]` placeholder
mean "unchanged": a hidden SMTP or LDAP password is left as it is, and
`pocketid_update_scim_provider` without a token (or with `[hidden]`) looks up
and keeps the provider's current token.

| Tool | Endpoint |
| --- | --- |
| `pocketid_create_user`, `pocketid_update_user`, `pocketid_delete_user` | `POST /api/users`, `PUT`/`DELETE /api/users/{id}` |
| `pocketid_set_user_groups` | `PUT /api/users/{id}/user-groups` |
| `pocketid_set_user_custom_claims` | `PUT /api/custom-claims/user/{id}` |
| `pocketid_delete_user_passkey` | `DELETE /api/users/{id}/webauthn-credentials/{credentialId}` |
| `pocketid_create_one_time_access_token`, `pocketid_send_one_time_access_email` | `POST /api/users/{id}/one-time-access-token`, `POST .../one-time-access-email` |
| `pocketid_create_group`, `pocketid_update_group`, `pocketid_delete_group` | `POST /api/user-groups`, `PUT`/`DELETE /api/user-groups/{id}` |
| `pocketid_set_group_users`, `pocketid_set_group_allowed_clients` | `PUT /api/user-groups/{id}/users`, `PUT .../allowed-oidc-clients` |
| `pocketid_set_group_custom_claims` | `PUT /api/custom-claims/user-group/{id}` |
| `pocketid_create_oidc_client`, `pocketid_update_oidc_client`, `pocketid_delete_oidc_client` | `POST /api/oidc/clients`, `PUT`/`DELETE /api/oidc/clients/{id}` |
| `pocketid_set_oidc_client_allowed_groups` | `PUT /api/oidc/clients/{id}/allowed-user-groups` |
| `pocketid_create_oidc_client_secret`, `pocketid_delete_oidc_client_secret` | `POST /api/oidc/clients/{id}/secrets`, `DELETE .../secrets/{secretId}` |
| `pocketid_create_api`, `pocketid_update_api`, `pocketid_delete_api` | `POST /api/apis`, `PUT`/`DELETE /api/apis/{id}` |
| `pocketid_set_api_permissions`, `pocketid_set_api_metadata_client_access` | `PUT /api/apis/{id}/permissions`, `PUT .../cimd-access` |
| `pocketid_set_api_client_access`, `pocketid_remove_api_client_access` | `PUT`/`DELETE /api/apis/{id}/clients/{clientId}` |
| `pocketid_create_signup_token`, `pocketid_delete_signup_token` | `POST /api/signup-tokens`, `DELETE /api/signup-tokens/{id}` |
| `pocketid_create_scim_provider`, `pocketid_update_scim_provider`, `pocketid_delete_scim_provider`, `pocketid_sync_scim_provider` | `POST /api/scim/service-provider`, `PUT`/`DELETE .../{id}`, `POST .../{id}/sync` |
| `pocketid_update_app_config` | `GET /api/application-configuration/all`, then `PUT /api/application-configuration` |
| `pocketid_sync_ldap` | `POST /api/application-configuration/sync-ldap` |

Tools that create a credential return it once, as the API does: one-time
access tokens, sign-up tokens, client secrets, and the secret a new
confidential client may get (`createdSecret`). Not exposed: the caller's own
account (`/api/users/me`), API keys (Pocket ID allows creating them only from
a browser session), logo and image uploads, the test email, client metadata
refresh, and the device-login and sign-in flows.

### API key

Create the key in Pocket ID while signed in as an admin
(`/settings/admin/api-keys`).
It acts with that user's full admin rights and must have an expiry date;
Pocket ID can email a reminder before it expires (`emailApiKeyExpirationEnabled`).
After renewing or replacing it, update the hub's secret and restart the pods.

## How authentication works

1. A request to `POST /mcp` without a valid token gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="<url>"`.
2. The client fetches the RFC 9728 document at
   `/.well-known/oauth-protected-resource` (also served at
   `/.well-known/oauth-protected-resource/mcp`), which names the Pocket ID issuer
   as the authorization server and the scopes to request.
3. The client logs the user in at Pocket ID (authorization code + PKCE, public
   client, no secret) and sends the access token as `Authorization: Bearer`.
4. The server verifies the JWT with the issuer's JWKS (found via OIDC discovery):
   signature (asymmetric algorithms only), `iss`, `exp`, `aud`, and the RFC 9068
   `typ` header (`at+jwt`), which rejects ID tokens and any other JWT the issuer
   signs. The audience must be one of `OAUTH_AUDIENCE`, normally only the MCP
   resource URL that clients request with the RFC 8707 `resource` parameter.
5. The hub asks the issuer's userinfo endpoint for the caller's groups with the
   same token (it needs the `openid` and `groups` scopes) and resolves them
   against the access policy.

Pocket ID needs: one public OIDC client with PKCE and the callback URL
`http://localhost/callback` (registered without a port, so any loopback port
matches); one API whose resource is the `MCP_PUBLIC_URL`, with that client
granted user-delegated access; and the groups the access policy names. Restrict
the client to those groups so nobody else can even log in.

## Configuration

Everything is read from environment variables. `pnpm start` also loads a `.env`
file in this directory if one exists (see `.env.example`).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OIDC_ISSUER` | yes | | Pocket ID issuer exactly as its discovery document advertises it (no trailing slash), e.g. `https://id.example.com`. Discovery and `iss` check. |
| `MCP_PUBLIC_URL` | yes | | Public URL of the MCP endpoint, e.g. `https://mcp.example.com/mcp`. The RFC 8707 resource. |
| `OAUTH_AUDIENCE` | yes | | Comma-separated accepted `aud` values. Normally only the resource URL; add the OAuth client ID only for clients that send no `resource` parameter. |
| `OAUTH_SCOPES` | no | `openid profile email groups offline_access` | Scopes advertised in the resource metadata. Keep `openid` and `groups`. |
| `ACCESS_POLICY_FILE` | yes | | Path to the access policy JSON (see `access-policy.example.json`). |
| `NETBIRD_API_TOKEN` | for netbird | | NetBird Personal Access Token; setting it enables the netbird section. Sent to NetBird as `Authorization: Token <PAT>`. |
| `NETBIRD_API_URL` | no | `https://api.netbird.io` | Base URL of a self-hosted NetBird management server. |
| `POCKETID_API_KEY` | for pocketid | | Pocket ID admin API key; setting it enables the pocketid section. Sent as `X-API-Key`. |
| `POCKETID_URL` | no | `OIDC_ISSUER` | Base URL of the Pocket ID instance to administer, when it is not the hub's own issuer. |
| `HOST` | no | `0.0.0.0` | Listen address. |
| `PORT` | no | `8080` | Listen port. |

Tokens are never logged. The access log contains method, path, status, and for
authenticated calls the token subject and the resolved access per section.

## Endpoints

- `POST /mcp`: the MCP endpoint, bearer token required.
- `GET /.well-known/oauth-protected-resource[/mcp]`: RFC 9728 metadata, public.
- `GET /healthz`: liveness, public, always `200` once the process is up.
- `GET /readyz`: readiness, `200` only after OIDC discovery against the issuer
  succeeded (retried with backoff), `503` before that.

## Run locally

Requires Node 22.9 or newer and pnpm.

```sh
cd hub
pnpm install
pnpm build
cp .env.example .env                               # fill in the values
cp access-policy.example.json access-policy.json   # adjust the groups
pnpm start                                         # http://0.0.0.0:8080/mcp
```

Container image: `docker build -t mcp-hub hub` (multi-stage, distroless Node
24, runs as uid 65532). CI publishes `ghcr.io/vanguard-enterprise/mcp-hub:main`
and `:sha-<commit>` on every push to `main`. The image contains neither `.env`
nor a policy, so mount the policy read-only and point `ACCESS_POLICY_FILE` at
its path inside the container:

```sh
docker run --rm -p 8080:8080 --env-file .env \
  -v "$PWD/access-policy.json:/etc/mcp-hub/access-policy.json:ro" \
  -e ACCESS_POLICY_FILE=/etc/mcp-hub/access-policy.json \
  ghcr.io/vanguard-enterprise/mcp-hub:main
```

## Add to Claude Code

```sh
claude mcp add --transport http --scope user hub https://mcp.vngenterprise.com/mcp \
  --client-id <pocket-id-client-id>
claude mcp login hub --no-browser
```

`claude mcp login` prints the Pocket ID authorization URL. Open it on any device
and sign in with your passkey. The browser is then redirected to
`http://localhost:<port>/callback`, which only resolves on the machine running
Claude Code; when that page does not load, copy the full URL from the address
bar and paste it at the prompt. Claude Code stores and refreshes the tokens
after that. Use `/mcp` inside Claude Code to re-authenticate or clear the
tokens. Claude Code has no device-code grant for MCP servers, so this paste
step is the supported path when the browser runs on another device.

## Checks

```sh
pnpm check     # typecheck, build, unit and HTTP tests (node:test)
```

The HTTP tests run a fake OIDC provider (discovery, JWKS, userinfo with
per-user groups) and verify the 401 challenge, the metadata documents, readiness
gating, token rejection cases (bad signature, issuer, audience, expiry), tool
lists for write, read, and no-access callers, that a hidden tool cannot be
called, group caching, and userinfo failures. The section
tests connect an in-process MCP client to the server and check, against a fake
NetBird or Pocket ID API, the method, path, headers, and body of every tool,
input validation, error mapping, that Pocket ID read tools hide credentials,
and that the configuration update merges instead of replacing.

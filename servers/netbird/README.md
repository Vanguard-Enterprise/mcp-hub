# NetBird MCP server

A small [MCP](https://modelcontextprotocol.io) server that exposes the
[NetBird Management API](https://docs.netbird.io/api) as read-only tools.
Streamable HTTP transport, stateless, TypeScript on the official MCP TypeScript
SDK. Authentication is OAuth 2.1: the server is a resource server for
[Pocket ID](https://pocket-id.org) access tokens, and MCP clients such as Claude
Code run the authorization-code + PKCE login themselves.

## Tools

All tools are read-only (`readOnlyHint: true`) and map to `GET` endpoints of the
current NetBird OpenAPI spec (`netbirdio/netbird`, `shared/management/http/api/openapi.yml`).

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

Tool results are the API's JSON, unchanged. NetBird errors (4xx/5xx) come back
as tool errors with the status and body, not as protocol errors.

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

Pocket ID needs two objects: a public OIDC client with PKCE and the callback URL
`http://localhost/callback` (registered without a port, so any loopback port
matches), and an API whose resource is the `MCP_PUBLIC_URL`, with that client
granted user-delegated access. Restrict the client to a user group.

## Configuration

Everything is read from environment variables. `pnpm start` also loads a `.env`
file in this directory if one exists (see `.env.example`).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OIDC_ISSUER` | yes | | Pocket ID issuer, e.g. `https://id.example.com`. Discovery and `iss` check. |
| `MCP_PUBLIC_URL` | yes | | Public URL of the MCP endpoint, e.g. `https://mcp-netbird.example.com/mcp`. The RFC 8707 resource. |
| `OAUTH_AUDIENCE` | yes | | Comma-separated accepted `aud` values. Normally only the resource URL; add the OAuth client ID only for clients that send no `resource` parameter. |
| `OAUTH_SCOPES` | no | `openid profile email offline_access` | Scopes advertised in the resource metadata. |
| `NETBIRD_API_TOKEN` | yes | | NetBird Personal Access Token. Sent to NetBird as `Authorization: Token <PAT>`. |
| `NETBIRD_API_URL` | no | `https://api.netbird.io` | Base URL of a self-hosted NetBird management server. |
| `HOST` | no | `0.0.0.0` | Listen address. |
| `PORT` | no | `8080` | Listen port. |

Tokens are never logged. The access log contains method, path, status, and for
authenticated calls the token subject, audience, and `typ` header.

## Endpoints

- `POST /mcp`: the MCP endpoint, bearer token required.
- `GET /.well-known/oauth-protected-resource[/mcp]`: RFC 9728 metadata, public.
- `GET /healthz`: liveness, public, always `200` once the process is up.
- `GET /readyz`: readiness, `200` only after OIDC discovery against the issuer
  succeeded (retried with backoff), `503` before that.

## Run locally

Requires Node 22.9 or newer and pnpm.

```sh
cd servers/netbird
pnpm install
pnpm build
cp .env.example .env     # fill in the values
pnpm start               # http://0.0.0.0:8080/mcp
```

Container image: `docker build -t mcp-netbird servers/netbird` (multi-stage,
distroless Node 24, runs as uid 65532). CI publishes
`ghcr.io/vanguard-enterprise/mcp-netbird:main` and `:sha-<commit>` on every push
to `main`.

## Add to Claude Code

```sh
claude mcp add --transport http --scope user netbird https://mcp-netbird.vngenterprise.com/mcp \
  --client-id <pocket-id-client-id>
claude mcp login netbird --no-browser
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

The HTTP tests run a fake OIDC provider (discovery + JWKS) and verify the 401
challenge, the metadata documents, readiness gating, token rejection cases
(bad signature, issuer, audience, expiry), and the tool list.

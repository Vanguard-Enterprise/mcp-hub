# NetBird MCP server

A small [MCP](https://modelcontextprotocol.io) server that exposes the
[NetBird Management API](https://docs.netbird.io/api) as read-only tools.
Streamable HTTP transport, bearer-token auth handled by the server itself,
no sessions (stateless), TypeScript on the official MCP TypeScript SDK.

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

## Configuration

Everything is read from environment variables. `pnpm start` also loads a `.env`
file in this directory if one exists (see `.env.example`).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MCP_AUTH_TOKEN` | yes | | Token clients must send as `Authorization: Bearer <token>`. Generate with `openssl rand -hex 32`. |
| `NETBIRD_API_TOKEN` | yes | | NetBird Personal Access Token. Sent to NetBird as `Authorization: Token <PAT>`. |
| `NETBIRD_API_URL` | no | `https://api.netbird.io` | Base URL of a self-hosted NetBird management server. |
| `HOST` | no | `0.0.0.0` | Listen address. |
| `PORT` | no | `8080` | Listen port. |

Neither token is ever logged. The access log contains only method, path, and status.

## Run locally

Requires Node 22.9 or newer and pnpm.

```sh
cd servers/netbird
pnpm install
pnpm build
cp .env.example .env     # fill in MCP_AUTH_TOKEN and NETBIRD_API_TOKEN
pnpm start               # http://0.0.0.0:8080/mcp
```

Endpoints:

- `POST /mcp`: the MCP endpoint. Requires `Authorization: Bearer <MCP_AUTH_TOKEN>`, anything else gets `401`.
- `GET /healthz`: unauthenticated liveness check, returns `{"status":"ok"}`.

Quick check with curl (replace the token):

```sh
curl -s http://<host>:8080/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Add to Claude Code

```sh
claude mcp add --transport http --scope user netbird http://<host>:8080/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
claude mcp list     # should show netbird as Connected
```

Use `--scope local` instead of `--scope user` to register it for one project only.
Tools then appear in Claude Code as `mcp__netbird__<tool>`, for example
`mcp__netbird__netbird_list_peers`.

## Checks

```sh
pnpm check     # typecheck, build, unit and HTTP tests (node:test)
```

The HTTP tests start the server on a random port and verify the 401 paths, the
tool list, and that an unreachable NetBird API surfaces as a tool error.

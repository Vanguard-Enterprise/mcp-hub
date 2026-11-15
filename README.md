# mcp-hub

One self-hosted [MCP](https://modelcontextprotocol.io) endpoint,
`https://mcp.vngenterprise.com/mcp`, with one Pocket ID login. Backends are
sections of the hub; Pocket ID groups decide which sections, and whether their
write tools, each user gets. See [`hub/`](hub) for the design, configuration,
and how to add a section.

| Section | Tools | Groups |
| --- | --- | --- |
| `netbird` | NetBird Management API: read tools for peers, groups, users, setup keys, policies, routes, and DNS; create/update/delete for groups, policies, routes, setup keys, DNS, and peers. | `mcp_netbird_read`, `mcp_netbird_write` |

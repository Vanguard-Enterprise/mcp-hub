# mcp-hub

One self-hosted [MCP](https://modelcontextprotocol.io) endpoint,
`https://mcp.vngenterprise.com/mcp`, with one Pocket ID login. Backends are
sections of the hub; Pocket ID groups decide which sections, and whether their
write tools, each user gets. See [`hub/`](hub) for the design, configuration,
and how to add a section.

| Section | Tools | Groups |
| --- | --- | --- |
| `netbird` | NetBird Management API: read tools for peers, groups, users, setup keys, policies, routes, and DNS; create/update/delete for groups, policies, routes, setup keys, DNS, and peers. | `mcp_netbird_read`, `mcp_netbird_write` |
| `pocketid` | Pocket ID admin API: read tools for users, groups, OIDC clients, APIs, sign-up tokens, the audit log, and the configuration (credentials hidden); writes for users, groups, memberships, custom claims, OIDC clients and secrets, APIs and their grants, sign-up tokens, SCIM, LDAP sync, and the configuration. | `mcp_pocketid_read`, `mcp_pocketid_write` |
| `argocd` | Argo CD API, read-only: applications with sync and health, resource trees, diffs against Git, events, pod logs, revision metadata, sync windows, ApplicationSets, projects, clusters, and repositories (credentials never returned). | `mcp_argocd_read` |

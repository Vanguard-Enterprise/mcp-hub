import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CREATE, DELETE, id, seg, ToolRegistrar, UPDATE } from "../tools.js";
import type { NetBirdClient } from "./client.js";

const REPLACES =
  "Replaces the whole object: fetch it first with the matching netbird_get_* tool and send every field back with your changes. " +
  "List fields take IDs (group IDs, peer IDs), not the objects the get tool returns.";

const groupIds = (what: string) => z.array(z.string().min(1)).describe(what);

const resource = z.object({
  id: z.string().min(1).describe("ID of the resource"),
  type: z.enum(["host", "subnet", "domain", "peer"]).describe("Resource type"),
});

const GROUP = {
  name: z.string().min(1).describe("Group name"),
  peers: z.array(z.string().min(1)).optional().describe("Peer IDs that belong to the group"),
  resources: z.array(resource).optional().describe("Network resources that belong to the group"),
};

const POLICY_RULE = z.object({
  id: z.string().optional().describe("Existing rule ID (keep it when updating a policy so the rule is updated, not recreated)"),
  name: z.string().min(1).describe("Rule name"),
  description: z.string().optional(),
  enabled: z.boolean(),
  action: z.enum(["accept", "drop"]),
  bidirectional: z.boolean().describe("Whether the rule applies in both directions"),
  protocol: z.enum(["all", "tcp", "udp", "icmp", "netbird-ssh"]),
  ports: z.array(z.string()).optional().describe('Individual ports, e.g. ["80", "443"]. Mutually exclusive with port_ranges'),
  port_ranges: z.array(z.object({ start: z.number().int(), end: z.number().int() })).optional().describe("Port ranges. Mutually exclusive with ports"),
  sources: z.array(z.string()).optional().describe("Source group IDs"),
  destinations: z.array(z.string()).optional().describe("Destination group IDs"),
  sourceResource: resource.optional().describe("Source network resource instead of source groups"),
  destinationResource: resource.optional().describe("Destination network resource instead of destination groups"),
  authorized_groups: z.record(z.string(), z.array(z.string())).optional().describe("Map of user group IDs to allowed local users (netbird-ssh)"),
});

const POLICY = {
  name: z.string().min(1).describe("Policy name"),
  description: z.string().optional(),
  enabled: z.boolean(),
  source_posture_checks: z.array(z.string()).optional().describe("Posture check IDs applied to the source groups"),
  rules: z.array(POLICY_RULE).min(1).describe("Access rules"),
};

const ROUTE = {
  description: z.string().describe("Route description"),
  network_id: z.string().min(1).max(40).describe("Route network identifier; HA routes share one"),
  enabled: z.boolean(),
  peer: z.string().optional().describe("Routing peer ID. Mutually exclusive with peer_groups"),
  peer_groups: z.array(z.string()).optional().describe("Routing peer group IDs. Mutually exclusive with peer"),
  network: z.string().optional().describe("Network range in CIDR notation. Mutually exclusive with domains"),
  domains: z.array(z.string()).max(32).optional().describe("Domains to resolve dynamically. Mutually exclusive with network"),
  metric: z.number().int().min(1).max(9999).describe("Route metric (1-9999); the lowest number wins"),
  masquerade: z.boolean().describe("Masquerade traffic to the route's prefix"),
  groups: groupIds("Distribution group IDs whose peers receive the route"),
  keep_route: z.boolean().describe("Keep the route after a domain stops resolving to an IP"),
  access_control_groups: z.array(z.string()).optional().describe("Access control group IDs for the route"),
  skip_auto_apply: z.boolean().optional().describe("Exit-node route (0.0.0.0/0) only: do not apply automatically on clients"),
};

const SETUP_KEY_CREATE = {
  name: z.string().min(1).describe("Setup key name"),
  type: z.enum(["one-off", "reusable"]),
  expires_in: z.number().int().min(0).describe("Expiration in seconds; 0 means the key never expires"),
  auto_groups: groupIds("Group IDs assigned to peers that register with this key"),
  usage_limit: z.number().int().min(0).describe("How many times the key can be used; 0 means unlimited"),
  ephemeral: z.boolean().optional().describe("Peers registered with the key are ephemeral"),
  allow_extra_dns_labels: z.boolean().optional().describe("Allow extra DNS labels on the peer"),
};

const SETUP_KEY_UPDATE = {
  revoked: z.boolean().describe("true revokes the key, which cannot be undone; false keeps it active"),
  auto_groups: groupIds("Group IDs assigned to peers that register with this key"),
};

const NAMESERVER_GROUP = {
  name: z.string().min(1).max(40).describe("Nameserver group name"),
  description: z.string().describe("Description"),
  nameservers: z
    .array(z.object({ ip: z.string().min(1), ns_type: z.literal("udp"), port: z.number().int().min(1).max(65535) }))
    .min(1)
    .max(3)
    .describe("Upstream resolvers (1 to 3)"),
  enabled: z.boolean(),
  groups: groupIds("Distribution group IDs whose peers use these resolvers"),
  primary: z.boolean().describe("Resolve all domains; true only when domains is empty"),
  domains: z.array(z.string()).describe("Match domains forwarded to these resolvers; empty only when primary is true"),
  search_domains_enabled: z.boolean().describe("Use the match domains as search domains; true only when domains is not empty"),
};

const ZONE = {
  name: z.string().min(1).describe("Zone name"),
  domain: z.string().min(1).describe("Zone domain (FQDN) that the records live under"),
  enabled: z.boolean().optional().describe("Zone status (default true)"),
  enable_search_domain: z.boolean().describe("Make the zone domain a search domain for the peers"),
  distribution_groups: groupIds("Group IDs whose peers resolve this zone"),
};

const RECORD = {
  name: z.string().min(1).describe("Record FQDN; must equal or be a subdomain of the zone's domain"),
  type: z.enum(["A", "AAAA", "CNAME"]),
  content: z.string().min(1).describe("IP address for A/AAAA, target domain for CNAME"),
  ttl: z.number().int().min(0).describe("Time to live in seconds"),
};

const PEER = {
  name: z.string().min(1).describe("Peer name"),
  ssh_enabled: z.boolean(),
  login_expiration_enabled: z.boolean(),
  inactivity_expiration_enabled: z.boolean(),
  approval_required: z.boolean().optional().describe("Cloud only: whether the peer needs approval"),
  ip: z.string().optional().describe("NetBird IPv4 address to assign"),
  ipv6: z.string().optional().describe("NetBird IPv6 address to assign"),
};

/**
 * Registers the tools that create, update, and delete NetBird objects.
 * `subject` is the authenticated user's OAuth subject; every write is logged with it,
 * because NetBird's own activity log attributes everything to the PAT owner.
 */
export function registerWriteTools(server: McpServer, netbird: NetBirdClient, subject?: string): void {
  const tools = new ToolRegistrar(server, netbird, subject);
  const write = tools.write.bind(tools);

  // Groups
  write("netbird_create_group", "Create a group. Peers and resources are optional and can be added later.", CREATE, GROUP, (b) => ({
    method: "POST",
    path: "/api/groups",
    body: b,
  }));
  write("netbird_update_group", `Update a group's name, peers, and resources. ${REPLACES}`, UPDATE, { group_id: id("group"), ...GROUP }, ({ group_id, ...b }) => ({
    method: "PUT",
    path: `/api/groups/${seg(group_id)}`,
    body: b,
  }));
  write("netbird_delete_group", "Delete a group. Fails while policies, routes, or DNS settings still reference it.", DELETE, { group_id: id("group") }, ({ group_id }) => ({
    method: "DELETE",
    path: `/api/groups/${seg(group_id)}`,
  }));

  // Policies
  write("netbird_create_policy", "Create an access control policy with its rules.", CREATE, POLICY, (b) => ({ method: "POST", path: "/api/policies", body: b }));
  write("netbird_update_policy", `Update a policy and its rules. ${REPLACES} Keep rule IDs to update rules in place.`, UPDATE, { policy_id: id("policy"), ...POLICY }, ({ policy_id, ...b }) => ({
    method: "PUT",
    path: `/api/policies/${seg(policy_id)}`,
    body: b,
  }));
  write("netbird_delete_policy", "Delete an access control policy. Traffic it allowed stops immediately.", DELETE, { policy_id: id("policy") }, ({ policy_id }) => ({
    method: "DELETE",
    path: `/api/policies/${seg(policy_id)}`,
  }));

  // Routes (legacy network-routes model)
  write("netbird_create_route", "Create a network route (CIDR or domains) served by a routing peer or peer groups.", CREATE, ROUTE, (b) => ({
    method: "POST",
    path: "/api/routes",
    body: b,
  }));
  write("netbird_update_route", `Update a network route. ${REPLACES}`, UPDATE, { route_id: id("route"), ...ROUTE }, ({ route_id, ...b }) => ({
    method: "PUT",
    path: `/api/routes/${seg(route_id)}`,
    body: b,
  }));
  write("netbird_delete_route", "Delete a network route.", DELETE, { route_id: id("route") }, ({ route_id }) => ({ method: "DELETE", path: `/api/routes/${seg(route_id)}` }));

  // Setup keys
  write(
    "netbird_create_setup_key",
    "Create a setup key. The response is the only time the API returns the key's secret value; the user needs it to enroll peers.",
    CREATE,
    SETUP_KEY_CREATE,
    (b) => ({ method: "POST", path: "/api/setup-keys", body: b }),
  );
  write(
    "netbird_update_setup_key",
    "Revoke a setup key (irreversible) and/or replace its auto-assigned groups. Fetch it first with netbird_get_setup_key and send the full auto_groups list.",
    UPDATE,
    { key_id: id("setup key"), ...SETUP_KEY_UPDATE },
    ({ key_id, ...b }) => ({
    method: "PUT",
    path: `/api/setup-keys/${seg(key_id)}`,
    body: b,
  }));
  write("netbird_delete_setup_key", "Delete a setup key.", DELETE, { key_id: id("setup key") }, ({ key_id }) => ({ method: "DELETE", path: `/api/setup-keys/${seg(key_id)}` }));

  // DNS nameserver groups (forwarders)
  write(
    "netbird_create_nameserver_group",
    "Create a DNS nameserver group: forward queries for the match domains (or everything, if primary) from the distribution groups to upstream resolvers. This creates no records.",
    CREATE,
    NAMESERVER_GROUP,
    (b) => ({ method: "POST", path: "/api/dns/nameservers", body: b }),
  );
  write("netbird_update_nameserver_group", `Update a DNS nameserver group. ${REPLACES}`, UPDATE, { nsgroup_id: id("nameserver group"), ...NAMESERVER_GROUP }, ({ nsgroup_id, ...b }) => ({
    method: "PUT",
    path: `/api/dns/nameservers/${seg(nsgroup_id)}`,
    body: b,
  }));
  write("netbird_delete_nameserver_group", "Delete a DNS nameserver group.", DELETE, { nsgroup_id: id("nameserver group") }, ({ nsgroup_id }) => ({
    method: "DELETE",
    path: `/api/dns/nameservers/${seg(nsgroup_id)}`,
  }));

  // DNS zones and records (authoritative)
  write(
    "netbird_create_dns_zone",
    "Create a custom DNS zone: NetBird answers authoritatively for records under its domain for the distribution groups. Add records with netbird_create_dns_record.",
    CREATE,
    ZONE,
    (b) => ({ method: "POST", path: "/api/dns/zones", body: b }),
  );
  write("netbird_update_dns_zone", `Update a DNS zone's name, domain, status, search-domain flag, or distribution groups. ${REPLACES}`, UPDATE, { zone_id: id("DNS zone"), ...ZONE }, ({ zone_id, ...b }) => ({
    method: "PUT",
    path: `/api/dns/zones/${seg(zone_id)}`,
    body: b,
  }));
  write("netbird_delete_dns_zone", "Delete a DNS zone and every record in it.", DELETE, { zone_id: id("DNS zone") }, ({ zone_id }) => ({
    method: "DELETE",
    path: `/api/dns/zones/${seg(zone_id)}`,
  }));
  write("netbird_create_dns_record", "Create a DNS record (A, AAAA, or CNAME) in a zone.", CREATE, { zone_id: id("DNS zone"), ...RECORD }, ({ zone_id, ...b }) => ({
    method: "POST",
    path: `/api/dns/zones/${seg(zone_id)}/records`,
    body: b,
  }));
  write("netbird_update_dns_record", `Update a DNS record. ${REPLACES}`, UPDATE, { zone_id: id("DNS zone"), record_id: id("DNS record"), ...RECORD }, ({ zone_id, record_id, ...b }) => ({
    method: "PUT",
    path: `/api/dns/zones/${seg(zone_id)}/records/${seg(record_id)}`,
    body: b,
  }));
  write("netbird_delete_dns_record", "Delete a DNS record.", DELETE, { zone_id: id("DNS zone"), record_id: id("DNS record") }, ({ zone_id, record_id }) => ({
    method: "DELETE",
    path: `/api/dns/zones/${seg(zone_id)}/records/${seg(record_id)}`,
  }));

  // Peers
  write("netbird_update_peer", `Rename a peer or change its SSH, login-expiration, inactivity-expiration, approval, or IP settings. ${REPLACES}`, UPDATE, { peer_id: id("peer"), ...PEER }, ({ peer_id, ...b }) => ({
    method: "PUT",
    path: `/api/peers/${seg(peer_id)}`,
    body: b,
  }));
  write("netbird_delete_peer", "Remove a peer from the network. The device must re-enroll with a setup key or login to come back.", DELETE, { peer_id: id("peer") }, ({ peer_id }) => ({
    method: "DELETE",
    path: `/api/peers/${seg(peer_id)}`,
  }));
}

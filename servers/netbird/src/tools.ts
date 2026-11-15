import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { NetBirdApiError, type NetBirdClient, type Query } from "./netbird.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const id = (what: string) => z.string().min(1).describe(`ID of the ${what}`);
export const seg = encodeURIComponent;

/** Runs a NetBird call and turns API errors into tool errors instead of protocol errors. */
export async function netbirdResult(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await call());
  } catch (error) {
    if (error instanceof NetBirdApiError) return { isError: true, content: [{ type: "text", text: error.message }] };
    throw error;
  }
}

export function registerTools(server: McpServer, netbird: NetBirdClient): void {
  // Every read tool is a single GET against the Management API.
  function get<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    request: (args: z.infer<z.ZodObject<Shape>>) => { path: string; query?: Query },
  ): void {
    const callback = (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
      const { path, query } = request(args);
      return netbirdResult(() => netbird.get(path, query));
    };
    // ToolCallback<Shape> is a conditional type that TypeScript cannot resolve
    // for a generic Shape, so the (already validated) argument type is asserted.
    server.registerTool(name, { description, inputSchema, annotations: READ_ONLY }, callback as unknown as ToolCallback<Shape>);
  }

  get(
    "netbird_list_peers",
    "List all peers (devices) in the NetBird account, optionally filtered by name, NetBird IP, or MAC address.",
    {
      name: z.string().optional().describe("Filter peers by name"),
      ip: z.string().optional().describe("Filter peers by NetBird IP address"),
      mac: z.string().optional().describe("Filter peers by MAC address of a network interface"),
    },
    ({ name, ip, mac }) => ({ path: "/api/peers", query: { name, ip, mac } }),
  );
  get("netbird_get_peer", "Retrieve one peer by ID, including its groups, OS, version, and connection status.", { peer_id: id("peer") }, ({ peer_id }) => ({
    path: `/api/peers/${seg(peer_id)}`,
  }));

  get(
    "netbird_list_groups",
    "List all groups with their peers and resources. Groups are what policies, routes, and DNS settings are distributed to.",
    { name: z.string().optional().describe("Filter groups by exact name") },
    ({ name }) => ({ path: "/api/groups", query: { name } }),
  );
  get("netbird_get_group", "Retrieve one group by ID.", { group_id: id("group") }, ({ group_id }) => ({ path: `/api/groups/${seg(group_id)}` }));

  get(
    "netbird_list_users",
    "List users in the account. Pass service_user=true for service users only, false for regular users only.",
    { service_user: z.boolean().optional().describe("true: only service users; false: only regular users; omit: all") },
    ({ service_user }) => ({ path: "/api/users", query: { service_user } }),
  );

  get("netbird_list_setup_keys", "List all setup keys (the key value itself is masked by the API).", {}, () => ({ path: "/api/setup-keys" }));
  get("netbird_get_setup_key", "Retrieve one setup key by ID.", { key_id: id("setup key") }, ({ key_id }) => ({ path: `/api/setup-keys/${seg(key_id)}` }));

  get("netbird_list_policies", "List all access control policies and their rules (sources, destinations, protocol, ports, posture checks).", {}, () => ({
    path: "/api/policies",
  }));
  get("netbird_get_policy", "Retrieve one policy by ID.", { policy_id: id("policy") }, ({ policy_id }) => ({ path: `/api/policies/${seg(policy_id)}` }));

  get(
    "netbird_list_routes",
    "List all network routes (the legacy routes model: network CIDR or domains, routing peer or peer groups, distribution groups).",
    {},
    () => ({ path: "/api/routes" }),
  );
  get("netbird_get_route", "Retrieve one network route by ID.", { route_id: id("route") }, ({ route_id }) => ({ path: `/api/routes/${seg(route_id)}` }));

  get(
    "netbird_list_nameserver_groups",
    "List DNS nameserver groups. These are forwarders: for the listed match domains, queries from the distribution groups go to the upstream resolver IPs. They hold no records.",
    {},
    () => ({ path: "/api/dns/nameservers" }),
  );
  get("netbird_get_nameserver_group", "Retrieve one nameserver group by ID.", { nsgroup_id: id("nameserver group") }, ({ nsgroup_id }) => ({
    path: `/api/dns/nameservers/${seg(nsgroup_id)}`,
  }));

  get(
    "netbird_list_dns_zones",
    "List custom DNS zones. A zone owns a domain and holds authoritative records that NetBird answers for peers in the zone's distribution groups. The response includes each zone's records.",
    {},
    () => ({ path: "/api/dns/zones" }),
  );
  get("netbird_get_dns_zone", "Retrieve one DNS zone by ID, including its records.", { zone_id: id("DNS zone") }, ({ zone_id }) => ({
    path: `/api/dns/zones/${seg(zone_id)}`,
  }));
  get("netbird_list_dns_records", "List the DNS records (A, AAAA, CNAME, TXT, ...) in a DNS zone.", { zone_id: id("DNS zone") }, ({ zone_id }) => ({
    path: `/api/dns/zones/${seg(zone_id)}/records`,
  }));
  get(
    "netbird_get_dns_record",
    "Retrieve one DNS record in a DNS zone.",
    { zone_id: id("DNS zone"), record_id: id("DNS record") },
    ({ zone_id, record_id }) => ({ path: `/api/dns/zones/${seg(zone_id)}/records/${seg(record_id)}` }),
  );
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

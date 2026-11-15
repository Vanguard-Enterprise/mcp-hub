import type { HubModule } from "../types.js";
import { NetBirdClient } from "./client.js";
import { registerTools } from "./read.js";
import { registerWriteTools } from "./write.js";

const DEFAULT_NETBIRD_API_URL = "https://api.netbird.io";

const INSTRUCTIONS =
  "netbird_* tools access a NetBird (WireGuard mesh) account via its Management API. Read tools are netbird_list_* and " +
  "netbird_get_*; netbird_create_*, netbird_update_*, and netbird_delete_* change live network configuration, so confirm with " +
  "the user first and read the current object before an update, because updates replace the whole object. " +
  "NetBird has two separate DNS features: nameserver groups are forwarders to upstream resolvers and hold no records, " +
  "while DNS zones hold authoritative records that NetBird answers itself for the zone's distribution groups. " +
  "When a name does not resolve, check both.";

export function netbirdModule(client: NetBirdClient): HubModule {
  return {
    name: "netbird",
    instructions: INSTRUCTIONS,
    register(server, level, ctx) {
      registerTools(server, client);
      if (level === "write") registerWriteTools(server, client, ctx.subject);
    },
  };
}

/** Builds the module from the environment, or returns undefined when NETBIRD_API_TOKEN is not set. */
export function netbirdModuleFromEnv(env: NodeJS.ProcessEnv): HubModule | undefined {
  const token = env.NETBIRD_API_TOKEN?.trim();
  if (!token) return undefined;
  return netbirdModule(new NetBirdClient(env.NETBIRD_API_URL?.trim() || DEFAULT_NETBIRD_API_URL, token));
}

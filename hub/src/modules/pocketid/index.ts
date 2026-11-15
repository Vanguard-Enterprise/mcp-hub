import type { HubModule } from "../types.js";
import { PocketIdClient } from "./client.js";
import { registerReadTools } from "./read.js";
import { registerWriteTools } from "./write.js";

const INSTRUCTIONS =
  "pocketid_* tools administer the Pocket ID identity provider (users, user groups, OIDC clients, APIs, sign-up tokens, SCIM, " +
  "audit log, and application configuration). Read tools are pocketid_list_*, pocketid_get_*, and pocketid_preview_*; they never " +
  "return credentials. Every other pocketid_* tool changes the identity provider, so confirm with the user first. Pocket ID is also " +
  "this hub's login: group memberships decide which hub sections and write tools a user gets, so changing groups, users, or the " +
  "hub's OIDC client changes access to everything behind the hub. pocketid_set_* tools replace the whole list they set, and " +
  "pocketid_update_* tools (except pocketid_update_app_config, which merges) replace the whole object: read it first and send " +
  "every value back with the change.";

export function pocketIdModule(client: PocketIdClient): HubModule {
  return {
    name: "pocketid",
    instructions: INSTRUCTIONS,
    register(server, level, ctx) {
      registerReadTools(server, client);
      if (level === "write") registerWriteTools(server, client, ctx.subject);
    },
  };
}

/**
 * Builds the module from the environment, or returns undefined when POCKETID_API_KEY is not set.
 * POCKETID_URL defaults to OIDC_ISSUER: normally the hub's login and this section are the same Pocket ID.
 */
export function pocketIdModuleFromEnv(env: NodeJS.ProcessEnv): HubModule | undefined {
  const apiKey = env.POCKETID_API_KEY?.trim();
  if (!apiKey) return undefined;
  const url = env.POCKETID_URL?.trim() || env.OIDC_ISSUER?.trim();
  if (!url) throw new Error("POCKETID_URL (or OIDC_ISSUER) is required for the pocketid module");
  return pocketIdModule(new PocketIdClient(url, apiKey));
}

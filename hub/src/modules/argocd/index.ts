import type { HubModule } from "../types.js";
import { ArgoCdClient } from "./client.js";
import { registerReadTools } from "./read.js";

const INSTRUCTIONS =
  "argocd_* tools read the Argo CD instance that deploys the cluster from Git. They are read-only: syncs, refreshes, rollbacks, " +
  "and edits are made in Git or in Argo CD itself, never through this hub. Start with argocd_list_applications " +
  "(problems_only=true lists apps that are out of sync, not healthy, failing to sync, or reporting conditions), then " +
  "argocd_get_application for one app's sync and health details and history, argocd_get_resource_tree for per-resource health, " +
  "argocd_get_application_diff for what differs from Git, and argocd_list_events and argocd_get_logs for why. " +
  "argocd_get_revision_metadata shows the commit behind a synced revision. Secret contents and credentials are never returned.";

export function argoCdModule(client: ArgoCdClient): HubModule {
  return {
    name: "argocd",
    instructions: INSTRUCTIONS,
    // Read-only section: it has no write tools, whatever the caller's level.
    register(server) {
      registerReadTools(server, client);
    },
  };
}

/** Builds the module from the environment, or returns undefined when ARGOCD_API_TOKEN is not set. */
export function argoCdModuleFromEnv(env: NodeJS.ProcessEnv): HubModule | undefined {
  const token = env.ARGOCD_API_TOKEN?.trim();
  if (!token) return undefined;
  const url = env.ARGOCD_URL?.trim();
  if (!url) throw new Error("ARGOCD_URL is required for the argocd module");
  return argoCdModule(new ArgoCdClient(url, token));
}

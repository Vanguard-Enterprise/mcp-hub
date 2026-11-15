import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiResult, READ_ONLY, seg, ToolInputError, ToolRegistrar } from "../tools.js";
import type { ArgoCdClient } from "./client.js";

type Obj = Record<string, unknown>;

function isRecord(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rec(value: unknown): Obj {
  return isRecord(value) ? value : {};
}

function items(data: unknown): unknown[] {
  const list = rec(data).items;
  return Array.isArray(list) ? list : [];
}

/** Copies the listed keys that are present. Used as an allowlist, so fields Argo CD adds later stay out. */
function pick(source: unknown, keys: readonly string[]): Obj {
  const from = rec(source);
  const out: Obj = {};
  for (const key of keys) if (from[key] !== undefined && from[key] !== null) out[key] = from[key];
  return out;
}

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/** Drops server bookkeeping that only costs tokens: managedFields and the last-applied annotation. */
export function trimObject(obj: unknown): unknown {
  if (!isRecord(obj) || !isRecord(obj.metadata)) return obj;
  const { managedFields: _managed, ...metadata } = obj.metadata;
  if (isRecord(metadata.annotations) && LAST_APPLIED in metadata.annotations) {
    const { [LAST_APPLIED]: _applied, ...annotations } = metadata.annotations;
    metadata.annotations = annotations;
  }
  return { ...obj, metadata };
}

function trimList(data: unknown): unknown {
  return items(data).map(trimObject);
}

function sources(spec: Obj): Obj[] {
  const list = Array.isArray(spec.sources) ? spec.sources : spec.source ? [spec.source] : [];
  return list.map((s) => pick(s, ["repoURL", "path", "chart", "targetRevision", "ref"]));
}

/** One line of the application list: where it deploys from and to, and its sync, health, and last operation. */
export function summarizeApplication(app: unknown): Obj {
  const a = rec(app);
  const metadata = rec(a.metadata);
  const spec = rec(a.spec);
  const status = rec(a.status);
  const sync = rec(status.sync);
  const health = rec(status.health);
  const operation = rec(status.operationState);
  const automated = rec(rec(spec.syncPolicy).automated);
  const conditions = Array.isArray(status.conditions) ? status.conditions.map((c) => pick(c, ["type", "message"])) : [];
  return {
    name: metadata.name,
    project: spec.project,
    sources: sources(spec),
    destination: pick(spec.destination, ["server", "name", "namespace"]),
    sync: pick(sync, ["status", "revision", "revisions"]),
    health: pick(health, ["status", "message"]),
    ...(Object.keys(operation).length > 0 ? { lastOperation: pick(operation, ["phase", "message", "startedAt", "finishedAt"]) } : {}),
    ...(conditions.length > 0 ? { conditions } : {}),
    autoSync: rec(spec.syncPolicy).automated ? pick(automated, ["prune", "selfHeal", "enabled"]) : false,
    reconciledAt: status.reconciledAt,
    images: rec(status.summary).images,
  };
}

/** True when an app needs attention: not synced, not healthy, a failed last operation, or any condition. */
export function hasProblem(summary: Obj): boolean {
  const sync = rec(summary.sync).status;
  const health = rec(summary.health).status;
  const phase = rec(summary.lastOperation).phase;
  return sync !== "Synced" || health !== "Healthy" || phase === "Failed" || phase === "Error" || Array.isArray(summary.conditions);
}

/** A resource-tree node without the noise: identity, parents, health, info, and images. */
export function summarizeNode(node: unknown): Obj {
  const n = rec(node);
  const parents = Array.isArray(n.parentRefs) ? n.parentRefs.map((p) => pick(p, ["kind", "namespace", "name"])) : [];
  return {
    ...pick(n, ["group", "version", "kind", "namespace", "name", "uid", "health", "info", "images", "createdAt"]),
    ...(parents.length > 0 ? { parents } : {}),
  };
}

function parseState(value: unknown): unknown {
  if (typeof value !== "string" || value === "" || value === "null") return null;
  try {
    return trimObject(JSON.parse(value));
  } catch {
    return value;
  }
}

/**
 * Managed resources as target and live state, parsed from the JSON strings the API returns. Same pair as the
 * Argo CD UI diff: `target` is the predicted state after a sync (Git merged onto the live object, so defaults
 * and fields Argo CD does not manage do not show up as drift), falling back to the raw state rendered from Git;
 * `live` is the normalized current state, falling back to the raw live state. A side is null when the resource
 * is missing there (to be created, or to be pruned). Argo CD replaces Secret values before they leave the API server.
 */
export function summarizeDiff(data: unknown, includeSynced: boolean): Obj[] {
  return items(data)
    .map(rec)
    .filter((r) => includeSynced || r.modified === true)
    .map((r) => {
      // Argo CD already masks Secret values; hide them here too, so a change in its masking cannot leak them.
      const secret = r.kind === "Secret" && !r.group;
      const state = (value: unknown) => (secret ? hideSecretData(parseState(value)) : parseState(value));
      return {
        ...pick(r, ["group", "kind", "namespace", "name", "modified"]),
        target: state(r.predictedLiveState) ?? state(r.targetState),
        live: state(r.normalizedLiveState) ?? state(r.liveState),
      };
    });
}

/** Placeholder for Secret values. */
export const HIDDEN = "[hidden]";

/** Replaces every value under a Secret's `data` and `stringData` (keys stay visible, so a diff still shows which keys differ). */
export function hideSecretData(obj: unknown): unknown {
  if (!isRecord(obj)) return obj;
  const out: Obj = { ...obj };
  for (const field of ["data", "stringData"]) {
    if (isRecord(out[field])) out[field] = Object.fromEntries(Object.keys(out[field] as Obj).map((key) => [key, HIDDEN]));
  }
  return out;
}

/** Kubernetes events, newest first, without metadata noise. */
export function summarizeEvents(data: unknown): Obj[] {
  const time = (e: Obj) => String(e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? "");
  return items(data)
    .map(rec)
    .sort((a, b) => time(b).localeCompare(time(a)))
    .map((e) => ({
      ...pick(e, ["type", "reason", "message", "count", "firstTimestamp", "lastTimestamp"]),
      object: pick(e.involvedObject, ["kind", "namespace", "name"]),
    }));
}

const REPOSITORY_FIELDS = ["repo", "name", "type", "project", "connectionState", "insecure", "enableLFS", "enableOCI", "inheritedCreds", "proxy", "noProxy"] as const;
const CLUSTER_FIELDS = ["name", "server", "project", "namespaces", "clusterResources", "labels", "annotations", "connectionState", "serverVersion", "info", "shard"] as const;

/** Repository connections without credentials: an allowlist, so passwords, keys, and tokens never pass even if the API sent them. */
export function summarizeRepositories(data: unknown): Obj[] {
  return items(data).map((r) => pick(r, REPOSITORY_FIELDS));
}

/** Clusters without their connection config (bearer tokens, TLS keys, exec credentials): an allowlist. */
export function summarizeClusters(data: unknown): Obj[] {
  return items(data).map((c) => {
    const cluster = pick(c, CLUSTER_FIELDS);
    // `info.apiVersions` lists every served API version (about 10 KB per cluster); keep the status fields.
    if (cluster.info !== undefined) cluster.info = pick(cluster.info, ["connectionState", "serverVersion", "cacheInfo", "applicationsCount"]);
    return cluster;
  });
}

/**
 * Parses the logs endpoint's answer: newline-delimited `{"result": {content, timeStamp, podName, last}}` objects
 * (a gRPC-gateway server stream). An `{"error": ...}` line is reported as a tool error.
 */
export function parseLogStream(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let entry: Obj;
    try {
      entry = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    if (entry.error) throw new ToolInputError(`Argo CD log stream failed: ${String(rec(entry.error).message ?? JSON.stringify(entry.error))}`);
    const result = rec(entry.result);
    if (result.last === true && !result.content) continue;
    lines.push([result.timeStamp, result.podName, result.content].filter((part) => part !== undefined && part !== "").join(" "));
  }
  return lines;
}

const appName = z.string().min(1).describe("Application name, as argocd_list_applications shows it");

const RESOURCE = {
  namespace: z.string().optional().describe("Resource namespace; omit for cluster-scoped resources"),
  group: z.string().optional().describe("API group; omit or empty for core kinds (Pod, Service, ConfigMap)"),
  version: z.string().min(1).describe("API version, e.g. v1 (argocd_get_resource_tree lists it per node)"),
  kind: z.string().min(1).describe("Kind, e.g. Deployment"),
  resource_name: z.string().min(1).describe("Resource name"),
};

const MAX_LOG_LINES = 1000;

export function registerReadTools(server: McpServer, argocd: ArgoCdClient): void {
  // Every tool is a GET; none starts a sync, a refresh, or anything else that changes Argo CD or the cluster.
  const tools = new ToolRegistrar(server, argocd);
  const get = tools.read.bind(tools);

  get("argocd_get_version", "Argo CD server version and build details.", {}, () => ({ path: "/api/version" }));

  // Applications
  get(
    "argocd_list_applications",
    "List applications with their source, destination, sync and health status, last sync operation, conditions, auto-sync settings, and images. " +
      "problems_only=true keeps only apps that are out of sync, not healthy, whose last sync failed, or that report conditions.",
    {
      problems_only: z.boolean().optional().describe("Only applications that need attention"),
      project: z.string().optional().describe("Only applications in this Argo CD project"),
      selector: z.string().optional().describe("Label selector, e.g. team=platform"),
      repo: z.string().optional().describe("Only applications deployed from this repository URL"),
    },
    ({ problems_only, project, selector, repo }) => ({
      path: "/api/v1/applications",
      query: { projects: project, selector, repo },
      transform: (data) => {
        const apps = items(data).map(summarizeApplication);
        return problems_only ? apps.filter(hasProblem) : apps;
      },
    }),
  );
  get(
    "argocd_get_application",
    "Retrieve one application: spec, sync and health status, per-resource sync status, the last operation with per-resource results, conditions, and deployment history.",
    { name: appName },
    ({ name }) => ({ path: `/api/v1/applications/${seg(name)}`, transform: trimObject }),
  );
  get(
    "argocd_get_resource_tree",
    "The live resource tree of an application (including children such as ReplicaSets and Pods): kind, name, version, UID, parents, health, info, and images per node. " +
      "unhealthy_only=true keeps nodes whose health is set and not Healthy.",
    { name: appName, unhealthy_only: z.boolean().optional().describe("Only nodes that report a health status other than Healthy") },
    ({ name, unhealthy_only }) => ({
      path: `/api/v1/applications/${seg(name)}/resource-tree`,
      transform: (data) => {
        const tree = rec(data);
        const keep = (n: unknown) => !unhealthy_only || (isRecord(rec(n).health) && rec(rec(n).health).status !== "Healthy");
        const nodes = (Array.isArray(tree.nodes) ? tree.nodes : []).filter(keep).map(summarizeNode);
        const orphaned = (Array.isArray(tree.orphanedNodes) ? tree.orphanedNodes : []).filter(keep).map(summarizeNode);
        return { nodes, ...(orphaned.length > 0 ? { orphanedNodes: orphaned } : {}) };
      },
    }),
  );
  get(
    "argocd_get_application_diff",
    "What differs between Git and the cluster: for each managed resource that is out of sync, its target state (Git applied to the live object, as the Argo CD UI diff shows it) and its current live state. " +
      "Narrow it with kind, resource_name, or namespace; include_synced=true also returns resources that match. Secret values are masked by Argo CD.",
    {
      name: appName,
      kind: z.string().optional().describe("Only resources of this kind"),
      resource_name: z.string().optional().describe("Only resources with this name"),
      namespace: z.string().optional().describe("Only resources in this namespace"),
      include_synced: z.boolean().optional().describe("Also return resources that are in sync"),
    },
    ({ name, kind, resource_name, namespace, include_synced }) => ({
      path: `/api/v1/applications/${seg(name)}/managed-resources`,
      query: { kind, name: resource_name, namespace },
      transform: (data) => summarizeDiff(data, include_synced === true),
    }),
  );
  get(
    "argocd_get_resource",
    "The live manifest of one resource managed by (or a child of) an application. Secrets are refused: use the diff or the resource tree to see their metadata.",
    { name: appName, ...RESOURCE },
    ({ name, namespace, group, version, kind, resource_name }) => {
      if (kind.toLowerCase() === "secret" && !group) throw new ToolInputError("argocd_get_resource does not return Secrets");
      return {
        path: `/api/v1/applications/${seg(name)}/resource`,
        query: { namespace, group, version, kind, resourceName: resource_name },
        transform: (data) => parseState(rec(data).manifest),
      };
    },
  );
  get(
    "argocd_list_events",
    "Kubernetes events, newest first, for an application or, with resource_name and resource_namespace (and resource_uid from argocd_get_resource_tree), for one of its resources.",
    {
      name: appName,
      resource_name: z.string().optional().describe("Name of one resource of the application"),
      resource_namespace: z.string().optional().describe("Namespace of that resource"),
      resource_uid: z.string().optional().describe("UID of that resource"),
    },
    ({ name, resource_name, resource_namespace, resource_uid }) => ({
      path: `/api/v1/applications/${seg(name)}/events`,
      query: { resourceName: resource_name, resourceNamespace: resource_namespace, resourceUID: resource_uid },
      transform: summarizeEvents,
    }),
  );
  get(
    "argocd_get_revision_metadata",
    "Commit metadata for a revision an application deployed (author, date, message, tags), e.g. the sync revision or a history entry's revision.",
    {
      name: appName,
      revision: z.string().min(1).describe("Git commit SHA (or Helm chart version) of the revision"),
      source_index: z.number().int().min(0).optional().describe("For multi-source applications: index of the source (default 0)"),
    },
    ({ name, revision, source_index }) => ({
      path: `/api/v1/applications/${seg(name)}/revisions/${seg(revision)}/metadata`,
      query: { sourceIndex: source_index },
    }),
  );
  get("argocd_get_sync_windows", "The sync windows that apply to an application and whether syncs are currently allowed.", { name: appName }, ({ name }) => ({
    path: `/api/v1/applications/${seg(name)}/syncwindows`,
  }));

  // Logs: the endpoint streams newline-delimited JSON, so this tool reads the raw body instead of one JSON document.
  server.registerTool(
    "argocd_get_logs",
    {
      description:
        "Recent container logs of an application's pods, oldest line first, as `timestamp pod line`. Give pod_name for one pod, or kind and resource_name " +
        `(for example a Deployment) for all of its pods. Returns at most ${MAX_LOG_LINES} lines per pod; never follows.`,
      inputSchema: {
        name: appName,
        namespace: z.string().optional().describe("Namespace of the pod or resource"),
        pod_name: z.string().optional().describe("One pod"),
        kind: z.string().optional().describe("Kind of a parent resource, e.g. Deployment, StatefulSet, Job"),
        resource_name: z.string().optional().describe("Name of that parent resource"),
        group: z.string().optional().describe("API group of that parent resource, e.g. apps"),
        container: z.string().optional().describe("Container name; omit for the default container"),
        tail_lines: z.number().int().min(1).max(MAX_LOG_LINES).optional().describe("Lines per pod from the end (default 100)"),
        since_seconds: z.number().int().min(1).optional().describe("Only lines newer than this many seconds"),
        filter: z.string().optional().describe("Only lines containing this text"),
        previous: z.boolean().optional().describe("Logs of the previous, terminated container (after a restart)"),
      },
      annotations: READ_ONLY,
    },
    ({ name, namespace, pod_name, kind, resource_name, group, container, tail_lines, since_seconds, filter, previous }) =>
      apiResult(async () => {
        if (!pod_name && !(kind && resource_name)) throw new ToolInputError("Give pod_name, or kind and resource_name");
        const text = await argocd.getText(`/api/v1/applications/${seg(name)}/logs`, {
          namespace,
          podName: pod_name,
          kind,
          resourceName: resource_name,
          group,
          container,
          tailLines: tail_lines ?? 100,
          sinceSeconds: since_seconds,
          filter,
          previous,
          follow: false,
        });
        return { lines: parseLogStream(text) };
      }),
  );

  // ApplicationSets
  get("argocd_list_applicationsets", "List ApplicationSets with their generators, template, and status.", { project: z.string().optional().describe("Only this project") }, ({ project }) => ({
    path: "/api/v1/applicationsets",
    query: { projects: project },
    transform: trimList,
  }));
  get("argocd_get_applicationset", "Retrieve one ApplicationSet with its generators, template, conditions, and generated applications.", { name: z.string().min(1).describe("ApplicationSet name") }, ({ name }) => ({
    path: `/api/v1/applicationsets/${seg(name)}`,
    transform: trimObject,
  }));

  // Projects
  get("argocd_list_projects", "List Argo CD projects: allowed source repositories, destinations, resource allow and deny lists, roles, and sync windows.", {}, () => ({
    path: "/api/v1/projects",
    transform: trimList,
  }));
  get("argocd_get_project", "Retrieve one Argo CD project.", { name: z.string().min(1).describe("Project name") }, ({ name }) => ({
    path: `/api/v1/projects/${seg(name)}`,
    transform: trimObject,
  }));

  // Clusters and repositories: allowlisted fields only, never credentials.
  get("argocd_list_clusters", "List the clusters Argo CD deploys to with their connection state, server version, and cache info. Credentials are never returned.", {}, () => ({
    path: "/api/v1/clusters",
    transform: summarizeClusters,
  }));
  get("argocd_list_repositories", "List the Git, Helm, and OCI repositories Argo CD reads with their connection state. Credentials are never returned.", {}, () => ({
    path: "/api/v1/repositories",
    transform: summarizeRepositories,
  }));
}

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ArgoCdClient } from "./client.js";
import { argoCdModule, argoCdModuleFromEnv } from "./index.js";
import { HIDDEN, parseLogStream, stripCredentials } from "./read.js";

interface Seen {
  method: string;
  path: string;
  authorization?: string;
}

const APPS = {
  items: [
    {
      metadata: { name: "good", managedFields: [{ manager: "x" }] },
      spec: {
        project: "default",
        source: { repoURL: "https://github.com/org/deploy", path: "apps/good", targetRevision: "main" },
        destination: { server: "https://kubernetes.default.svc", namespace: "good" },
        syncPolicy: { automated: { prune: true, selfHeal: true } },
      },
      status: {
        sync: { status: "Synced", revision: "abc" },
        health: { status: "Healthy" },
        operationState: { phase: "Succeeded", message: "ok", syncResult: { resources: [] } },
        summary: { images: ["img:1"] },
        resources: [{ kind: "Deployment", name: "good" }],
      },
    },
    {
      metadata: { name: "drifted" },
      spec: { project: "default", sources: [{ repoURL: "https://github.com/org/deploy", path: "apps/drifted" }], destination: { namespace: "d" } },
      status: { sync: { status: "OutOfSync" }, health: { status: "Healthy" } },
    },
    {
      metadata: { name: "conditioned" },
      spec: { project: "default", source: { repoURL: "r" } },
      status: { sync: { status: "Synced" }, health: { status: "Healthy" }, conditions: [{ type: "SyncError", message: "boom", lastTransitionTime: "t" }] },
    },
  ],
};

const MANAGED = {
  items: [
    {
      kind: "Deployment",
      group: "apps",
      namespace: "n",
      name: "web",
      modified: true,
      targetState: '{"spec":{"replicas":2}}',
      predictedLiveState: '{"spec":{"replicas":2,"paused":false}}',
      normalizedLiveState: '{"spec":{"replicas":1,"paused":false}}',
      liveState: '{"spec":{"replicas":1,"paused":false},"status":{}}',
    },
    { kind: "Service", group: "", namespace: "n", name: "gone", modified: true, targetState: "null", liveState: '{"spec":{}}' },
    { kind: "ConfigMap", group: "", namespace: "n", name: "cfg", modified: false, targetState: '{"data":{"a":"1"}}', normalizedLiveState: '{"data":{"a":"1"}}' },
    { kind: "Secret", group: "", namespace: "n", name: "creds", modified: true, targetState: '{"data":{"password":"cGxhaW4="}}', liveState: '{"data":{"password":"c2VjcmV0"}}' },
  ],
};

const TREE = {
  nodes: [
    { kind: "Deployment", group: "apps", version: "v1", namespace: "n", name: "web", uid: "u1", health: { status: "Healthy" }, resourceVersion: "9" },
    { kind: "Pod", version: "v1", namespace: "n", name: "web-1", uid: "u2", health: { status: "Degraded", message: "CrashLoopBackOff" }, parentRefs: [{ kind: "ReplicaSet", namespace: "n", name: "web-x", uid: "u3" }] },
    { kind: "ConfigMap", version: "v1", namespace: "n", name: "cfg", uid: "u4" },
  ],
};

const EVENTS = {
  items: [
    { type: "Normal", reason: "Pulled", message: "old", lastTimestamp: "2026-01-01T00:00:00Z", involvedObject: { kind: "Pod", name: "web-1", uid: "u2" }, metadata: { name: "e1" } },
    { type: "Warning", reason: "BackOff", message: "new", lastTimestamp: "2026-01-02T00:00:00Z", involvedObject: { kind: "Pod", name: "web-1" } },
  ],
};

const LOGS =
  '{"result":{"content":"line one","timeStamp":"2026-01-01T00:00:00Z","podName":"web-1"}}\n' +
  '{"result":{"content":"line two","timeStamp":"2026-01-01T00:00:01Z","podName":"web-1"}}\n' +
  '{"result":{"content":"","last":true,"podName":"web-1"}}\n';

const CLUSTERS = {
  items: [
    {
      name: "in-cluster",
      server: "https://kubernetes.default.svc",
      config: { bearerToken: "cluster-secret", tlsClientConfig: { keyData: "key" } },
      connectionState: { status: "Successful" },
      info: { serverVersion: "v1.36", applicationsCount: 2, apiVersions: ["apps/v1/Deployment"] },
    },
  ],
};
const REPOS = {
  items: [
    { repo: "https://github.com/org/deploy", type: "git", password: "repo-secret", sshPrivateKey: "ssh-secret", githubAppPrivateKey: "app-secret", connectionState: { status: "Successful" } },
    { repo: "https://bot:url-secret@git.example.com/org/charts", type: "helm", proxy: "socks5://user:proxy-secret@proxy.example:1080" },
  ],
};

// A fake Argo CD API server that records every request and answers the endpoints the tools rewrite.
const seen: Seen[] = [];
const fake: Server = createServer((req, res) => {
  seen.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization });
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (path === "/api/v1/applications/fail") return send(403, { error: "permission denied", code: 7 });
  if (path === "/api/v1/applications") return send(200, APPS);
  if (path === "/api/v1/applications/web") return send(200, APPS.items[0]);
  if (path.endsWith("/managed-resources")) return send(200, MANAGED);
  if (path.endsWith("/resource-tree")) return send(200, TREE);
  if (path.endsWith("/resource")) return send(200, { manifest: '{"kind":"Deployment","metadata":{"name":"web","managedFields":[1]}}' });
  if (path.endsWith("/events")) return send(200, EVENTS);
  if (path.endsWith("/logs")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(LOGS);
  }
  if (path === "/api/v1/clusters") return send(200, CLUSTERS);
  if (path === "/api/v1/repositories") return send(200, REPOS);
  if (path === "/api/v1/projects" || path === "/api/v1/applicationsets") return send(200, { items: [{ metadata: { name: "p", managedFields: [] }, spec: {} }] });
  send(200, { ok: true });
});

let baseUrl: string;
let client: Client;

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(clientTransport);
  return c;
}

before(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const server = new McpServer({ name: "argocd", version: "test" });
  // Even at write level the section registers only read tools.
  argoCdModule(new ArgoCdClient(baseUrl, "argocd-test-token")).register(server, "write", { subject: "s" });
  client = await connect(server);
});
after(async () => {
  await client.close();
  fake.close();
});

function last(): Seen {
  const entry = seen.at(-1);
  assert.ok(entry, "no request reached the fake Argo CD API");
  return entry;
}

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function data(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await call(name, args);
  assert.ok(!result.isError, text(result));
  return JSON.parse(text(result));
}

test("every tool is read-only and none forces a prompt, even at write level", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
  for (const tool of tools) {
    assert.match(tool.name, /^argocd_(list|get)_/);
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.equal(tool._meta?.["anthropic/requiresUserInteraction"], undefined, tool.name);
  }
});

// Every tool: arguments and the exact request path (with query) it must produce. All are GETs.
const READS: { tool: string; args?: Record<string, unknown>; path: string }[] = [
  { tool: "argocd_get_version", path: "/api/version" },
  { tool: "argocd_list_applications", args: { project: "default", selector: "a=b" }, path: "/api/v1/applications?projects=default&selector=a%3Db" },
  { tool: "argocd_get_application", args: { name: "web" }, path: "/api/v1/applications/web" },
  { tool: "argocd_get_resource_tree", args: { name: "web" }, path: "/api/v1/applications/web/resource-tree" },
  { tool: "argocd_get_application_diff", args: { name: "web", kind: "Deployment", resource_name: "web" }, path: "/api/v1/applications/web/managed-resources?kind=Deployment&name=web" },
  {
    tool: "argocd_get_resource",
    args: { name: "web", namespace: "n", group: "apps", version: "v1", kind: "Deployment", resource_name: "web" },
    path: "/api/v1/applications/web/resource?namespace=n&group=apps&version=v1&kind=Deployment&resourceName=web",
  },
  { tool: "argocd_list_events", args: { name: "web", resource_name: "web-1", resource_namespace: "n" }, path: "/api/v1/applications/web/events?resourceName=web-1&resourceNamespace=n" },
  { tool: "argocd_get_revision_metadata", args: { name: "web", revision: "abc", source_index: 1 }, path: "/api/v1/applications/web/revisions/abc/metadata?sourceIndex=1" },
  { tool: "argocd_get_sync_windows", args: { name: "web" }, path: "/api/v1/applications/web/syncwindows" },
  { tool: "argocd_get_logs", args: { name: "web", namespace: "n", pod_name: "web-1" }, path: "/api/v1/applications/web/logs?namespace=n&podName=web-1&tailLines=100&follow=false" },
  { tool: "argocd_list_applicationsets", path: "/api/v1/applicationsets" },
  { tool: "argocd_get_applicationset", args: { name: "set" }, path: "/api/v1/applicationsets/set" },
  { tool: "argocd_list_projects", path: "/api/v1/projects" },
  { tool: "argocd_get_project", args: { name: "default" }, path: "/api/v1/projects/default" },
  { tool: "argocd_list_clusters", path: "/api/v1/clusters" },
  { tool: "argocd_list_repositories", path: "/api/v1/repositories" },
];

test("each tool sends one GET to its endpoint with the bearer token", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(READS.map((r) => r.tool).sort(), tools.map((t) => t.name).sort());
  for (const { tool, args, path } of READS) {
    const before = seen.length;
    const result = await call(tool, args);
    assert.ok(!result.isError, `${tool}: ${text(result)}`);
    assert.equal(seen.length, before + 1, tool);
    assert.deepEqual({ method: last().method, path: last().path }, { method: "GET", path }, tool);
    assert.equal(last().authorization, "Bearer argocd-test-token", tool);
  }
});

test("path segments are encoded", async () => {
  await call("argocd_get_application", { name: "a/b" });
  assert.equal(last().path, "/api/v1/applications/a%2Fb");
});

test("argocd_list_applications summarizes apps and problems_only keeps the ones needing attention", async () => {
  const apps = (await data("argocd_list_applications")) as Record<string, unknown>[];
  assert.equal(apps.length, 3);
  assert.deepEqual(apps[0], {
    name: "good",
    project: "default",
    sources: [{ repoURL: "https://github.com/org/deploy", path: "apps/good", targetRevision: "main" }],
    destination: { server: "https://kubernetes.default.svc", namespace: "good" },
    sync: { status: "Synced", revision: "abc" },
    health: { status: "Healthy" },
    lastOperation: { phase: "Succeeded", message: "ok" },
    autoSync: { prune: true, selfHeal: true },
    images: ["img:1"],
  });
  assert.equal(apps[1]?.autoSync, false);
  const problems = (await data("argocd_list_applications", { problems_only: true })) as { name: string }[];
  assert.deepEqual(
    problems.map((a) => a.name),
    ["drifted", "conditioned"],
  );
});

test("stripCredentials removes embedded passwords and leaves other URLs alone", () => {
  assert.equal(stripCredentials("https://user:pw@git.example.com/repo.git"), "https://git.example.com/repo.git");
  assert.equal(stripCredentials("http://user:pw@proxy:8080"), "http://proxy:8080/");
  assert.equal(stripCredentials("https://github.com/org/deploy"), "https://github.com/org/deploy");
  assert.equal(stripCredentials("ssh://git@github.com/org/deploy.git"), "ssh://git@github.com/org/deploy.git");
  assert.equal(stripCredentials("git@github.com:org/deploy.git"), "git@github.com:org/deploy.git");
});

test("app-scoped tools pass app_namespace as appNamespace", async () => {
  await call("argocd_get_application", { name: "web", app_namespace: "team-a" });
  assert.equal(last().path, "/api/v1/applications/web?appNamespace=team-a");
  await call("argocd_get_logs", { name: "web", app_namespace: "team-a", pod_name: "p" });
  assert.equal(last().path, "/api/v1/applications/web/logs?podName=p&tailLines=100&follow=false&appNamespace=team-a");
  await call("argocd_list_applications", { app_namespace: "team-a" });
  assert.equal(last().path, "/api/v1/applications?appNamespace=team-a");
});

test("argocd_get_application drops managedFields", async () => {
  const app = (await data("argocd_get_application", { name: "web" })) as { metadata: Record<string, unknown> };
  assert.equal(app.metadata.name, "good");
  assert.equal("managedFields" in app.metadata, false);
});

test("argocd_get_application_diff returns modified resources with parsed states and hides Secret values", async () => {
  const diff = (await data("argocd_get_application_diff", { name: "web" })) as Record<string, unknown>[];
  assert.deepEqual(
    diff.map((r) => r.name),
    ["web", "gone", "creds"],
  );
  // Like the Argo CD UI: predicted state against normalized live state, so the drift (replicas 2 vs 1) shows.
  assert.deepEqual(diff[0], {
    group: "apps",
    kind: "Deployment",
    namespace: "n",
    name: "web",
    modified: true,
    target: { spec: { replicas: 2, paused: false } },
    live: { spec: { replicas: 1, paused: false } },
  });
  // A resource to be pruned has no target; the raw states are the fallback.
  assert.deepEqual({ target: diff[1]?.target, live: diff[1]?.live }, { target: null, live: { spec: {} } });
  assert.deepEqual(diff[2]?.target, { data: { password: HIDDEN } });
  assert.deepEqual(diff[2]?.live, { data: { password: HIDDEN } });
  const raw = text(await call("argocd_get_application_diff", { name: "web", include_synced: true }));
  assert.doesNotMatch(raw, /cGxhaW4=|c2VjcmV0/);
  assert.match(raw, /"cfg"/);
});

test("argocd_get_resource_tree compacts nodes and unhealthy_only filters them", async () => {
  const tree = (await data("argocd_get_resource_tree", { name: "web" })) as { nodes: Record<string, unknown>[] };
  assert.equal(tree.nodes.length, 3);
  assert.equal("resourceVersion" in (tree.nodes[0] ?? {}), false);
  assert.deepEqual(tree.nodes[1]?.parents, [{ kind: "ReplicaSet", namespace: "n", name: "web-x" }]);
  const unhealthy = (await data("argocd_get_resource_tree", { name: "web", unhealthy_only: true })) as { nodes: { name: string }[] };
  assert.deepEqual(
    unhealthy.nodes.map((n) => n.name),
    ["web-1"],
  );
});

test("argocd_get_resource parses the manifest and refuses Secrets without calling Argo CD", async () => {
  const manifest = (await data("argocd_get_resource", { name: "web", version: "v1", kind: "Deployment", resource_name: "web" })) as { metadata: Record<string, unknown> };
  assert.deepEqual(manifest.metadata, { name: "web" });
  const before = seen.length;
  const refused = await call("argocd_get_resource", { name: "web", namespace: "n", version: "v1", kind: "Secret", resource_name: "creds" });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /does not return Secrets/);
  assert.equal(seen.length, before);
});

test("argocd_list_events sorts newest first and keeps the essentials", async () => {
  const events = (await data("argocd_list_events", { name: "web" })) as Record<string, unknown>[];
  assert.deepEqual(events[0], { type: "Warning", reason: "BackOff", message: "new", lastTimestamp: "2026-01-02T00:00:00Z", object: { kind: "Pod", name: "web-1" } });
  assert.equal(events[1]?.reason, "Pulled");
});

test("argocd_get_logs parses the stream and needs a pod or a parent resource", async () => {
  assert.deepEqual(await data("argocd_get_logs", { name: "web", kind: "Deployment", group: "apps", resource_name: "web", tail_lines: 5 }), {
    lines: ["2026-01-01T00:00:00Z web-1 line one", "2026-01-01T00:00:01Z web-1 line two"],
  });
  assert.equal(last().path, "/api/v1/applications/web/logs?kind=Deployment&resourceName=web&group=apps&tailLines=5&follow=false");
  const before = seen.length;
  const missing = await call("argocd_get_logs", { name: "web" });
  assert.equal(missing.isError, true);
  assert.equal(seen.length, before);
});

test("parseLogStream turns an error line into a tool error", () => {
  assert.throws(() => parseLogStream('{"error":{"code":7,"message":"permission denied"}}\n'), /permission denied/);
  assert.deepEqual(parseLogStream("\nnot json\n"), []);
});

test("clusters and repositories never include credentials", async () => {
  const clusters = text(await call("argocd_list_clusters"));
  const repos = text(await call("argocd_list_repositories"));
  assert.doesNotMatch(clusters, /cluster-secret|keyData|config/);
  assert.deepEqual(JSON.parse(clusters)[0].info, { serverVersion: "v1.36", applicationsCount: 2 });
  assert.doesNotMatch(repos, /repo-secret|ssh-secret|app-secret|url-secret|proxy-secret|bot|user/);
  assert.deepEqual(JSON.parse(repos), [
    { repo: "https://github.com/org/deploy", type: "git", connectionState: { status: "Successful" } },
    { repo: "https://git.example.com/org/charts", type: "helm", proxy: "socks5://proxy.example:1080" },
  ]);
});

test("Argo CD errors come back as tool errors", async () => {
  const result = await call("argocd_get_application", { name: "fail" });
  assert.equal(result.isError, true);
  assert.match(text(result), /HTTP 403/);
});

test("argoCdModuleFromEnv needs a token and a URL, and keeps the token private", () => {
  assert.equal(argoCdModuleFromEnv({}), undefined);
  assert.throws(() => argoCdModuleFromEnv({ ARGOCD_API_TOKEN: "t" }), /ARGOCD_URL/);
  assert.throws(() => argoCdModuleFromEnv({ ARGOCD_API_TOKEN: "t", ARGOCD_URL: "http://argocd.example.com" }), /https/);
  assert.equal(argoCdModuleFromEnv({ ARGOCD_API_TOKEN: "t", ARGOCD_URL: "https://argocd.example.com" })?.name, "argocd");
  const argocd = new ArgoCdClient("https://argocd.example.com", "argocd-supersecret");
  assert.doesNotMatch(JSON.stringify(argocd), /supersecret/);
});

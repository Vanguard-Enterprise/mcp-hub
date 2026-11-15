import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUrl, NetBirdClient } from "./client.js";

test("buildUrl joins base and path and strips trailing slashes", () => {
  assert.equal(buildUrl("https://api.netbird.io", "/api/peers").href, "https://api.netbird.io/api/peers");
  assert.equal(buildUrl("https://nb.example.com/", "/api/peers").href, "https://nb.example.com/api/peers");
  assert.equal(buildUrl("https://nb.example.com/prefix", "/api/peers").href, "https://nb.example.com/prefix/api/peers");
});

test("buildUrl appends only defined, non-empty query parameters", () => {
  const url = buildUrl("https://api.netbird.io", "/api/peers", { name: "db 1", ip: undefined, mac: "" });
  assert.equal(url.href, "https://api.netbird.io/api/peers?name=db+1");
  assert.equal(buildUrl("https://api.netbird.io", "/api/users", { service_user: false }).search, "?service_user=false");
});

test("NetBirdClient does not expose the token when serialized or inspected", () => {
  const client = new NetBirdClient("https://api.netbird.io", "nbp_supersecret");
  assert.doesNotMatch(JSON.stringify(client), /supersecret/);
  assert.doesNotMatch(String(Object.entries(client)), /supersecret/);
});

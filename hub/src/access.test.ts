import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAccessPolicy, resolveAccess } from "./access.js";

const POLICY = JSON.stringify({ sections: { netbird: { read: ["readers"], write: ["writers"] }, grafana: { read: ["readers"] } } });

test("write groups get write, read groups get read, others nothing", () => {
  const policy = parseAccessPolicy(POLICY, ["netbird", "grafana"]);
  assert.deepEqual([...resolveAccess(policy, ["writers"])], [["netbird", "write"]]);
  assert.deepEqual([...resolveAccess(policy, ["readers"])], [["netbird", "read"], ["grafana", "read"]]);
  assert.deepEqual([...resolveAccess(policy, ["readers", "writers"])], [["netbird", "write"], ["grafana", "read"]]);
  assert.deepEqual([...resolveAccess(policy, [])], []);
  assert.deepEqual([...resolveAccess(policy, ["Writers"])], [], "group names match exactly");
});

test("the policy must be valid JSON, strictly shaped, and name only loaded modules", () => {
  assert.throws(() => parseAccessPolicy("{", ["netbird"]), /not valid JSON/);
  assert.throws(() => parseAccessPolicy(JSON.stringify({ sections: { netbird: { admin: ["x"] } } }), ["netbird"]), /invalid/);
  assert.throws(() => parseAccessPolicy(JSON.stringify({ section: {} }), ["netbird"]), /invalid/);
  assert.throws(() => parseAccessPolicy(POLICY, ["netbird"]), /unknown sections grafana/);
});

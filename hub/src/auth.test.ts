import assert from "node:assert/strict";
import { test } from "node:test";
import { bearerToken } from "./auth.js";

test("bearerToken extracts the token from a Bearer header", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer abc123"), "abc123");
  assert.equal(bearerToken("Bearer   abc123  "), "abc123");
});

test("bearerToken rejects other schemes and malformed headers", () => {
  assert.equal(bearerToken(undefined), undefined);
  assert.equal(bearerToken(""), undefined);
  assert.equal(bearerToken("Bearer"), undefined);
  assert.equal(bearerToken("Bearer "), undefined);
  assert.equal(bearerToken("Basic abc123"), undefined);
  assert.equal(bearerToken("Token abc123"), undefined);
  assert.equal(bearerToken("Bearer a b"), undefined);
});

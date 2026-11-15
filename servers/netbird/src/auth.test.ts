import assert from "node:assert/strict";
import { test } from "node:test";
import { bearerToken, tokensMatch } from "./auth.js";

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

test("tokensMatch accepts only the exact expected token", () => {
  assert.equal(tokensMatch("secret", "secret"), true);
  assert.equal(tokensMatch("secret ", "secret"), false);
  assert.equal(tokensMatch("Secret", "secret"), false);
  assert.equal(tokensMatch("secre", "secret"), false);
  assert.equal(tokensMatch("secret-but-longer", "secret"), false);
  assert.equal(tokensMatch("", "secret"), false);
  assert.equal(tokensMatch(undefined, "secret"), false);
});

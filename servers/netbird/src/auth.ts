import { createHash, timingSafeEqual } from "node:crypto";

/** Extracts the token from an `Authorization: Bearer <token>` header value. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/**
 * Compares a presented token with the expected one in constant time.
 * Both values are hashed first so that inputs of different lengths can be
 * compared without leaking the length through an early return.
 */
export function tokensMatch(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || presented.length === 0) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

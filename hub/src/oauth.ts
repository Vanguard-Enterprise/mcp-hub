import { createHash } from "node:crypto";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isLoopback } from "./url.js";

export interface AuthConfig {
  /** OIDC issuer (Pocket ID), e.g. https://id.example.com. Used for discovery and the `iss` check. */
  issuer: string;
  /** Accepted `aud` values. Normally only the MCP resource URL (tokens requested with RFC 8707 `resource`). */
  audiences: string[];
  /** Canonical public URL of the MCP endpoint, used as the RFC 8707 resource identifier. */
  resourceUrl: URL;
  /** Scopes advertised in the protected resource metadata. */
  scopesSupported: string[];
}

export interface VerifiedToken {
  subject: string;
  audience: string[];
  scopes: string[];
  /** The JWT `typ` header (`at+jwt` or `application/at+jwt`). */
  typ: string;
}

/** Thrown when a bearer token is missing or invalid (HTTP 401) or cannot be checked right now (HTTP 503). */
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 503,
    readonly code: "invalid_token" | "temporarily_unavailable" | undefined,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// Asymmetric algorithms only: a JWKS never carries shared secrets, so HS* must never be accepted.
const ALLOWED_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];
// RFC 9068 section 4: a resource server accepts only JWTs typed as access tokens. This is what
// keeps ID tokens (typ "JWT") or any other JWT the issuer signs from being replayed as bearer tokens.
const ACCESS_TOKEN_TYPES = new Set(["at+jwt", "application/at+jwt"]);

// Group memberships from userinfo are cached per token for this long, so a role change in the
// identity provider takes effect within a minute without a userinfo call on every MCP request.
const GROUPS_CACHE_TTL_MS = 60_000;
const GROUPS_CACHE_MAX_ENTRIES = 1_000;

/**
 * Validates Pocket ID access tokens against the issuer's JWKS, discovered via OIDC discovery,
 * and looks up the caller's group memberships at the issuer's userinfo endpoint.
 */
export class TokenVerifier {
  #jwks: JWTVerifyGetKey | undefined;
  #userinfoUrl: URL | undefined;
  readonly #groups = new Map<string, { groups: string[]; expires: number }>();

  constructor(readonly config: AuthConfig) {}

  /** True once OIDC discovery has succeeded and tokens can be verified. */
  get ready(): boolean {
    return this.#jwks !== undefined;
  }

  /** Loads the issuer's discovery document and prepares the remote JWKS. Throws on failure; callers retry. */
  async init(): Promise<void> {
    const discoveryUrl = `${this.config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const response = await fetch(discoveryUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`OIDC discovery at ${discoveryUrl} returned HTTP ${response.status}`);
    const discovery = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown; userinfo_endpoint?: unknown };
    if (discovery.issuer !== this.config.issuer) {
      throw new Error(`OIDC discovery issuer ${JSON.stringify(discovery.issuer)} does not match configured issuer ${this.config.issuer}`);
    }
    if (typeof discovery.jwks_uri !== "string") throw new Error("OIDC discovery document has no jwks_uri");
    if (typeof discovery.userinfo_endpoint !== "string") throw new Error("OIDC discovery document has no userinfo_endpoint");
    const userinfoUrl = new URL(discovery.userinfo_endpoint);
    // The hub sends bearer tokens to userinfo, so it must be TLS (OIDC Core 16.17); plain HTTP
    // only for loopback, which keeps local development and tests working.
    if (userinfoUrl.protocol !== "https:" && !(userinfoUrl.protocol === "http:" && isLoopback(userinfoUrl))) {
      throw new Error(`OIDC discovery advertises a non-HTTPS userinfo_endpoint ${userinfoUrl.href}`);
    }
    this.#userinfoUrl = userinfoUrl;
    this.#jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  }

  /**
   * Returns the group names of the token's user from the issuer's userinfo endpoint. Pocket ID
   * puts groups in userinfo, not in access tokens, and reads them live, so removing a user from a
   * group takes effect within the cache TTL. Call only with a token that passed verify().
   */
  async groups(token: string, subject: string): Promise<string[]> {
    const userinfoUrl = this.#userinfoUrl;
    if (!userinfoUrl) throw new AuthError(503, "temporarily_unavailable", "OIDC discovery has not completed yet");
    // Keyed by a hash so the cache never holds bearer tokens.
    const key = createHash("sha256").update(token).digest("base64url");
    const now = Date.now();
    const cached = this.#groups.get(key);
    if (cached && cached.expires > now) return cached.groups;

    let response: Response;
    try {
      response = await fetch(userinfoUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AuthError(503, "temporarily_unavailable", "could not reach the issuer's userinfo endpoint");
    }
    if (response.status === 401 || response.status === 403) {
      // The token is valid but the issuer will not describe its user, e.g. it lacks the openid scope.
      throw new AuthError(401, "invalid_token", `userinfo rejected the token (HTTP ${response.status}); log in again with the openid and groups scopes`);
    }
    if (!response.ok) throw new AuthError(503, "temporarily_unavailable", `userinfo returned HTTP ${response.status}`);
    let info: { sub?: unknown; groups?: unknown };
    try {
      info = (await response.json()) as { sub?: unknown; groups?: unknown };
    } catch {
      // A truncated or unparseable body is an issuer-side problem, not a bad token: retry, don't re-login.
      throw new AuthError(503, "temporarily_unavailable", "could not read the userinfo response");
    }
    if (info.sub !== subject) throw new AuthError(401, "invalid_token", "userinfo subject does not match the token subject");
    const groups = Array.isArray(info.groups) ? info.groups.filter((g): g is string => typeof g === "string") : [];

    if (this.#groups.size >= GROUPS_CACHE_MAX_ENTRIES) {
      for (const [k, v] of this.#groups) if (v.expires <= now) this.#groups.delete(k);
      if (this.#groups.size >= GROUPS_CACHE_MAX_ENTRIES) this.#groups.delete(this.#groups.keys().next().value as string);
    }
    this.#groups.set(key, { groups, expires: now + GROUPS_CACHE_TTL_MS });
    return groups;
  }

  async verify(token: string): Promise<VerifiedToken> {
    const jwks = this.#jwks;
    if (!jwks) throw new AuthError(503, "temporarily_unavailable", "OIDC discovery has not completed yet");
    try {
      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        issuer: this.config.issuer,
        audience: this.config.audiences,
        algorithms: ALLOWED_ALGORITHMS,
      });
      if (!ACCESS_TOKEN_TYPES.has(protectedHeader.typ ?? "")) {
        throw new AuthError(401, "invalid_token", "token is not an RFC 9068 access token (typ header)");
      }
      if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new AuthError(401, "invalid_token", "token has no subject");
      return {
        subject: payload.sub,
        audience: Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [],
        scopes: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
        typ: protectedHeader.typ as string,
      };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      // Issuer-side failures while fetching the JWKS: a timeout, a non-200 response or
      // unparseable JSON (both surface as the generic JOSEError), or a body that is not a
      // key set. Token faults use dedicated subclasses (JWTExpired, JWSSignatureVerificationFailed,
      // JWKSNoMatchingKey, ...) and stay 401.
      if (
        error instanceof joseErrors.JWKSTimeout ||
        error instanceof joseErrors.JWKSInvalid ||
        (error instanceof joseErrors.JOSEError && error.code === "ERR_JOSE_GENERIC")
      ) {
        throw new AuthError(503, "temporarily_unavailable", "could not fetch the issuer's signing keys");
      }
      if (error instanceof joseErrors.JOSEError) throw new AuthError(401, "invalid_token", error.code);
      // Network failures fetching the JWKS are the only non-JOSE errors jwtVerify surfaces.
      throw new AuthError(503, "temporarily_unavailable", "could not fetch the issuer's signing keys");
    }
  }
}

/** RFC 9728 protected resource metadata document. */
export function protectedResourceMetadata(config: AuthConfig): Record<string, unknown> {
  return {
    resource: config.resourceUrl.href,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: config.scopesSupported,
    resource_name: "MCP hub",
  };
}

/** Path-aware well-known URL for the resource (RFC 9728 section 3), e.g. /.well-known/oauth-protected-resource/mcp. */
export function protectedResourceMetadataUrl(resourceUrl: URL): string {
  const path = resourceUrl.pathname.replace(/\/+$/, "");
  return `${resourceUrl.origin}/.well-known/oauth-protected-resource${path}`;
}

/** Builds the WWW-Authenticate challenge for a 401 response. `error` is omitted when no token was presented. */
export function bearerChallenge(config: AuthConfig, error?: { code: string; description: string }): string {
  const parts = [`realm="mcp-hub"`, `resource_metadata="${protectedResourceMetadataUrl(config.resourceUrl)}"`];
  if (error) {
    parts.push(`error="${error.code}"`, `error_description="${error.description.replaceAll('"', "'")}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}

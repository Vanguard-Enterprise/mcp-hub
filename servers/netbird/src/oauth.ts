import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";

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

/** Validates Pocket ID access tokens against the issuer's JWKS, discovered via OIDC discovery. */
export class TokenVerifier {
  #jwks: JWTVerifyGetKey | undefined;

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
    const discovery = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
    if (discovery.issuer !== this.config.issuer) {
      throw new Error(`OIDC discovery issuer ${JSON.stringify(discovery.issuer)} does not match configured issuer ${this.config.issuer}`);
    }
    if (typeof discovery.jwks_uri !== "string") throw new Error("OIDC discovery document has no jwks_uri");
    this.#jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
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
      if (error instanceof joseErrors.JWKSTimeout) throw new AuthError(503, "temporarily_unavailable", "could not fetch the issuer's signing keys");
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
    resource_name: "NetBird MCP server",
  };
}

/** Path-aware well-known URL for the resource (RFC 9728 section 3), e.g. /.well-known/oauth-protected-resource/mcp. */
export function protectedResourceMetadataUrl(resourceUrl: URL): string {
  const path = resourceUrl.pathname.replace(/\/+$/, "");
  return `${resourceUrl.origin}/.well-known/oauth-protected-resource${path}`;
}

/** Builds the WWW-Authenticate challenge for a 401 response. `error` is omitted when no token was presented. */
export function bearerChallenge(config: AuthConfig, error?: { code: string; description: string }): string {
  const parts = [`realm="netbird-mcp"`, `resource_metadata="${protectedResourceMetadataUrl(config.resourceUrl)}"`];
  if (error) {
    parts.push(`error="${error.code}"`, `error_description="${error.description.replaceAll('"', "'")}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}

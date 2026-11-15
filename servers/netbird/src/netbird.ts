export type Query = Record<string, string | boolean | undefined>;

const USER_AGENT = "netbird-mcp-server/0.1.0";
const REQUEST_TIMEOUT_MS = 30_000;

export class NetBirdApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`NetBird API returned HTTP ${status} for GET ${path}: ${body.slice(0, 2000) || "(empty body)"}`);
    this.name = "NetBirdApiError";
  }
}

/** Joins the base URL and path and appends the defined query parameters. */
export function buildUrl(baseUrl: string, path: string, query?: Query): URL {
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

/** Minimal read-only client for the NetBird Management API. */
export class NetBirdClient {
  // Private field: never serialized by JSON.stringify or console.log.
  readonly #token: string;

  constructor(
    readonly baseUrl: string,
    token: string,
  ) {
    this.#token = token;
  }

  async get(path: string, query?: Query): Promise<unknown> {
    const response = await fetch(buildUrl(this.baseUrl, path, query), {
      headers: {
        // The spec's TokenAuth scheme for Personal Access Tokens.
        Authorization: `Token ${this.#token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) throw new NetBirdApiError(response.status, path, body);
    return body ? JSON.parse(body) : null;
  }
}

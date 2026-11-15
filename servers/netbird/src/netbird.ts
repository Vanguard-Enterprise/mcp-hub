export type Query = Record<string, string | boolean | undefined>;
export type WriteMethod = "POST" | "PUT" | "DELETE";

const USER_AGENT = "netbird-mcp-server/0.3.0";
const REQUEST_TIMEOUT_MS = 30_000;

export class NetBirdApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`NetBird API returned HTTP ${status} for ${method} ${path}: ${body.slice(0, 2000) || "(empty body)"}`);
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

/** Minimal client for the NetBird Management API. */
export class NetBirdClient {
  // Private field: never serialized by JSON.stringify or console.log.
  readonly #token: string;

  constructor(
    readonly baseUrl: string,
    token: string,
  ) {
    this.#token = token;
  }

  get(path: string, query?: Query): Promise<unknown> {
    return this.#send("GET", path, query);
  }

  /** POST, PUT, or DELETE with an optional JSON body. Returns the parsed response body, or null when empty. */
  request(method: WriteMethod, path: string, body?: unknown): Promise<unknown> {
    return this.#send(method, path, undefined, body);
  }

  async #send(method: string, path: string, query?: Query, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      // The spec's TokenAuth scheme for Personal Access Tokens.
      Authorization: `Token ${this.#token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(buildUrl(this.baseUrl, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new NetBirdApiError(response.status, method, path, text);
    return text ? JSON.parse(text) : null;
  }
}

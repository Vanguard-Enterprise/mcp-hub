import { SERVER_VERSION } from "../version.js";

export type Query = Record<string, string | number | boolean | undefined>;
export type WriteMethod = "POST" | "PUT" | "DELETE";

const USER_AGENT = `mcp-hub/${SERVER_VERSION}`;
const REQUEST_TIMEOUT_MS = 30_000;

/** A 4xx or 5xx answer from a section's backend API. Tools report it as a tool error, not a protocol error. */
export class ApiError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`${service} API returned HTTP ${status} for ${method} ${path}: ${body.slice(0, 2000) || "(empty body)"}`);
    this.name = "ApiError";
  }
}

/** Joins the base URL and path and appends the defined, non-empty query parameters. */
export function buildUrl(baseUrl: string, path: string, query?: Query): URL {
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

/** Minimal JSON client for a backend REST API that authenticates every request with fixed headers. */
export class JsonApiClient {
  // Private field: never serialized by JSON.stringify or console.log.
  readonly #authHeaders: Record<string, string>;

  constructor(
    /** Name used in error messages, e.g. "NetBird". */
    readonly service: string,
    readonly baseUrl: string,
    authHeaders: Record<string, string>,
  ) {
    this.#authHeaders = authHeaders;
  }

  get(path: string, query?: Query): Promise<unknown> {
    return this.#send("GET", path, query);
  }

  /** POST, PUT, or DELETE with an optional JSON body. Returns the parsed response body, or null when empty. */
  request(method: WriteMethod, path: string, body?: unknown): Promise<unknown> {
    return this.#send(method, path, undefined, body);
  }

  async #send(method: string, path: string, query?: Query, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { ...this.#authHeaders, Accept: "application/json", "User-Agent": USER_AGENT };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(buildUrl(this.baseUrl, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new ApiError(this.service, response.status, method, path, text);
    return text ? JSON.parse(text) : null;
  }
}

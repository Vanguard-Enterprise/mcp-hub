import { isLoopback } from "../url.js";
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

/**
 * Minimal JSON client for a backend REST API that authenticates every request with fixed headers.
 * The base URL must be HTTPS (plain HTTP only on loopback), so credentials never travel in clear text.
 */
export class JsonApiClient {
  // Private field: never serialized by JSON.stringify or console.log.
  readonly #authHeaders: Record<string, string>;

  constructor(
    /** Name used in error messages, e.g. "NetBird". */
    readonly service: string,
    readonly baseUrl: string,
    authHeaders: Record<string, string>,
  ) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(`${service} API URL must be an absolute URL, got ${JSON.stringify(baseUrl)}`);
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
      throw new Error(`${service} API URL must use https:// (plain http only on loopback), got ${url.origin}`);
    }
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
      // Never follow redirects: fetch keeps custom credential headers such as X-API-Key on a
      // cross-origin redirect, and a 303 would turn a write into a GET. A 3xx becomes an ApiError.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      const location = response.headers.get("location");
      throw new ApiError(this.service, response.status, method, path, location ? `redirect to ${location}` : text);
    }
    return text ? JSON.parse(text) : null;
  }
}

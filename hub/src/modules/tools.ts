import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, type JsonApiClient, type Query, type WriteMethod } from "./http.js";

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations;
// Creates add objects without touching existing ones; updates and deletes change or remove
// live configuration, so clients should confirm them with the user.
export const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations;
export const UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations;
export const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations;
/** An action that has an effect each time it runs (send an email, start a sync) but changes no stored object. */
export const ACTION = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations;

// Claude Code honours this flag in every permission mode (auto, acceptEdits, bypassPermissions):
// it prompts on each call and offers no "don't ask again". Annotations alone do not gate approval.
export const REQUIRES_USER_INTERACTION = { "anthropic/requiresUserInteraction": true };

export const id = (what: string) => z.string().min(1).describe(`ID of the ${what}`);
export const seg = encodeURIComponent;

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** Input that passed the schema but cannot be applied, found while preparing a request. Reported as a tool error. */
export class ToolInputError extends Error {
  override name = "ToolInputError";
}

/** Runs a backend call and turns API and input errors into tool errors instead of protocol errors. */
export async function apiResult(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await call());
  } catch (error) {
    if (error instanceof ApiError || error instanceof ToolInputError) return { isError: true, content: [{ type: "text", text: error.message }] };
    throw error;
  }
}

function isEmpty(data: unknown): boolean {
  return data === null || data === undefined || (typeof data === "object" && !Array.isArray(data) && Object.keys(data as object).length === 0);
}

type Args<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

export interface ReadRequest {
  path: string;
  query?: Query;
  /** Rewrites the response before it is returned, e.g. to hide credentials. */
  transform?: (data: unknown) => unknown;
}

export interface WriteRequest {
  method: WriteMethod;
  path: string;
  body?: unknown;
  /** Rewrites a non-empty response before it is returned, e.g. to hide credentials. */
  transform?: (data: unknown) => unknown;
}

/** Registers tools for one section's API client. Read tools are single GETs; write tools are audited and force a client prompt. */
export class ToolRegistrar {
  constructor(
    private readonly server: McpServer,
    private readonly client: JsonApiClient,
    /** OAuth subject of the caller, logged with every write. */
    private readonly subject?: string,
  ) {}

  read<Shape extends z.ZodRawShape>(name: string, description: string, inputSchema: Shape, request: (args: Args<Shape>) => ReadRequest): void {
    const callback = (args: Args<Shape>): Promise<CallToolResult> =>
      // `request` runs inside apiResult so that a ToolInputError it throws becomes a tool error.
      apiResult(async () => {
        const { path, query, transform } = request(args);
        const data = await this.client.get(path, query);
        return transform ? transform(data) : data;
      });
    // ToolCallback<Shape> is a conditional type that TypeScript cannot resolve
    // for a generic Shape, so the (already validated) argument type is asserted.
    this.server.registerTool(name, { description, inputSchema, annotations: READ_ONLY }, callback as unknown as ToolCallback<Shape>);
  }

  /**
   * A write tool. `request` may read from the API first (for example to merge a partial change);
   * failures there are tool errors too. Every call is logged with the caller's subject, never the body.
   */
  write<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    annotations: ToolAnnotations,
    inputSchema: Shape,
    request: (args: Args<Shape>, client: JsonApiClient) => WriteRequest | Promise<WriteRequest>,
  ): void {
    const callback = async (args: Args<Shape>): Promise<CallToolResult> => {
      let target = "-";
      // "error" also covers failures after the request was sent (a timeout or reset while reading the
      // answer), where the backend may still have applied the change.
      let outcome = "error";
      try {
        const result = await apiResult(async () => {
          const { method, path, body, transform } = await request(args, this.client);
          target = `${method} ${path}`;
          const data = await this.client.request(method, path, body);
          // Deletes answer with an empty body or "{}"; report what happened instead.
          if (isEmpty(data)) return { status: "ok", method, path };
          return transform ? transform(data) : data;
        });
        if (!result.isError) outcome = "ok";
        return result;
      } finally {
        // Audit line: who changed what, written even when the call throws. Never the body.
        console.log(`${new Date().toISOString()} write ${name} ${target} sub=${this.subject ?? "-"} ${outcome}`);
      }
    };
    this.server.registerTool(
      name,
      { description, inputSchema, annotations, _meta: REQUIRES_USER_INTERACTION },
      callback as unknown as ToolCallback<Shape>,
    );
  }
}

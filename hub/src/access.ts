import { z } from "zod";
import type { Level } from "./modules/types.js";

const groupList = z.array(z.string().min(1)).default([]);

const policySchema = z
  .object({
    sections: z.record(z.string().min(1), z.object({ read: groupList, write: groupList }).strict()),
  })
  .strict();

/**
 * Which identity-provider groups may use which section. Members of a section's `write`
 * groups get its read and write tools; members of its `read` groups get the read tools.
 */
export type AccessPolicy = z.infer<typeof policySchema>;

/** Parses and validates the policy JSON. Every section must name a loaded module, so typos fail at startup. */
export function parseAccessPolicy(json: string, moduleNames: string[]): AccessPolicy {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new Error(`access policy is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = policySchema.safeParse(data);
  if (!result.success) throw new Error(`access policy is invalid: ${z.prettifyError(result.error)}`);
  const unknown = Object.keys(result.data.sections).filter((name) => !moduleNames.includes(name));
  if (unknown.length > 0) {
    throw new Error(`access policy names unknown sections ${unknown.join(", ")}; loaded modules: ${moduleNames.join(", ") || "none"}`);
  }
  return result.data;
}

/** Resolves a caller's groups to the access level per section. Sections the caller cannot use are absent. */
export function resolveAccess(policy: AccessPolicy, groups: readonly string[]): Map<string, Level> {
  const member = new Set(groups);
  const access = new Map<string, Level>();
  for (const [section, rule] of Object.entries(policy.sections)) {
    if (rule.write.some((g) => member.has(g))) access.set(section, "write");
    else if (rule.read.some((g) => member.has(g))) access.set(section, "read");
  }
  return access;
}

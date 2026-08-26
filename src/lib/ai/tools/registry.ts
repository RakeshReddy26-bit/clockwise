import "server-only";

import { z } from "zod";
import type { ToolDefinition } from "@/lib/ai/anthropic";
import { AiError } from "@/lib/ai/errors";
import type { AiContext } from "@/lib/ai/context";
import type { Permission } from "@/lib/permissions";

/**
 * The closed set of things the assistant may do.
 *
 * "Closed" is the whole design. The model cannot write SQL, cannot name a
 * table, and cannot reach anything not registered here. A tool call for a name
 * that is not in this map is an error, not an improvisation — see `AiError
 * ("unknown_tool")`.
 *
 * Each tool declares:
 *   - a Zod schema, which is the trust boundary for model-produced arguments;
 *   - an optional permission, checked against the caller's REAL role before
 *     the handler runs;
 *   - a handler that receives the validated input and the server-resolved
 *     context, in that order, and can therefore never be handed a tenant.
 */

export type ToolKind = "read" | "propose";

export type AiTool<Schema extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  kind: ToolKind;
  /** Shown to the model. Describes intent, not implementation. */
  description: string;
  schema: Schema;
  /**
   * Permission required to run it. Omit for tools every authenticated member
   * may use about themselves. Checked server-side against the session role.
   */
  permission?: Permission;
  handler: (input: z.infer<Schema>, ctx: AiContext) => Promise<unknown>;
};

/**
 * Declare a tool with its input type inferred from its own schema.
 *
 * Annotating `const t: AiTool = {…}` instead would erase the generic and hand
 * every handler an `unknown` input, which is exactly the type safety this
 * boundary exists to provide.
 */
export function defineTool<Schema extends z.ZodTypeAny>(tool: AiTool<Schema>): AiTool {
  return tool as unknown as AiTool;
}

/** Build the JSON Schema the Messages API expects from our Zod schema. */
function toInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // z.toJSONSchema is available in zod v4, which this repository already uses.
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  // The API requires an object schema at the top level; every tool here uses
  // one, but be explicit rather than assume.
  return { type: "object", properties: {}, ...json };
}

export function toolDefinitions(tools: readonly AiTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toInputSchema(tool.schema),
  }));
}

/** Tools this caller is allowed to be offered at all. */
export function toolsForContext(tools: readonly AiTool[], ctx: AiContext): AiTool[] {
  return tools.filter((tool) => !tool.permission || ctx.can(tool.permission));
}

export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

/**
 * Run one model-requested tool call.
 *
 * Order matters and is the security story in five lines: find the tool, check
 * the caller's permission, validate the arguments, only then execute. A
 * failure at any step becomes a structured refusal the model is told about,
 * rather than an exception that ends the conversation — the assistant should
 * be able to say "I can't do that" and carry on.
 */
export async function runTool(
  tools: readonly AiTool[],
  name: string,
  rawInput: unknown,
  ctx: AiContext
): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new AiError("unknown_tool", `model requested unregistered tool "${name}"`, name);
  }

  if (tool.permission && !ctx.can(tool.permission)) {
    return {
      ok: false,
      code: "forbidden",
      message: `You do not have permission to use ${name}.`,
    };
  }

  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_tool_input",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; "),
    };
  }

  try {
    return { ok: true, result: await tool.handler(parsed.data, ctx) };
  } catch (error) {
    // A handler blowing up must not leak a Postgres message to the model,
    // which would then repeat it to the user.
    console.error(`ai tool ${name} failed:`, error);
    return { ok: false, code: "tool_failed", message: `${name} could not be completed.` };
  }
}

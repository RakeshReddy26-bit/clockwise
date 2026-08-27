import "server-only";

import {
  createMessage,
  type AnthropicClientOptions,
  type AnthropicMessage,
  type ToolResultBlock,
} from "@/lib/ai/anthropic";
import { AiError } from "@/lib/ai/errors";
import type { AiContext } from "@/lib/ai/context";
import { systemPrompt } from "@/lib/ai/prompt";
import { operatingDate } from "@/lib/ai/dates";
import {
  runTool,
  toolDefinitions,
  toolsForContext,
  type AiTool,
} from "@/lib/ai/tools/registry";
import { READ_TOOLS } from "@/lib/ai/tools/read";
import { PROPOSE_TOOLS } from "@/lib/ai/tools/propose";
import { BRIEFING_TOOLS } from "@/lib/ai/tools/briefing";
import { MODULE_TOOLS } from "@/lib/ai/tools/modules";

/**
 * The conversation loop: ask, run whatever tools the model asked for, ask again.
 *
 * Bounded on purpose. `MAX_TURNS` stops a model that keeps calling tools from
 * running up a bill, and it is low because these questions need one or two
 * lookups, not exploration. Hitting the ceiling is reported as a failure rather
 * than answered from whatever was gathered so far — a half-researched answer
 * about who is working tonight is worse than an honest "I could not finish".
 */

const MAX_TURNS = 6;

/** Tool payloads are trimmed before they go upstream; see `capResult`. */
const MAX_TOOL_RESULT_CHARS = 12_000;

export const ALL_TOOLS: readonly AiTool[] = [
  // Briefing leads so it is the obvious answer to "how is today going" — one
  // call instead of five, assembled by the same engines the board uses.
  ...BRIEFING_TOOLS,
  ...READ_TOOLS,
  ...MODULE_TOOLS,
  ...PROPOSE_TOOLS,
];

/** One thing the assistant produced that the UI has to render. */
export type AssistantTurn = {
  text: string;
  /** Signed plans awaiting confirmation. Empty for a pure question. */
  proposals: Array<{ token: string; expiresAt: number; summary: unknown; kind: string }>;
};

export type RunOptions = AnthropicClientOptions & {
  /** Override the registry. Tests use it; nothing in production does. */
  tools?: readonly AiTool[];
  maxTurns?: number;
};

/**
 * Run one user message to completion.
 *
 * `history` is the prior transcript. It is carried by the client and replayed
 * here, which is safe because it can only contain text and tool results the
 * server itself produced — and because every identifier inside it is re-checked
 * against the tenant the next time a tool touches it. A browser that edits its
 * own history can make the model believe something false; it cannot make the
 * database do anything.
 */
export async function runAssistantTurn(
  ctx: AiContext,
  history: AnthropicMessage[],
  userMessage: string,
  options: RunOptions = {}
): Promise<{ turn: AssistantTurn; messages: AnthropicMessage[] }> {
  const registry = options.tools ?? ALL_TOOLS;
  const available = toolsForContext(registry, ctx);
  const definitions = toolDefinitions(available);

  const system = systemPrompt({
    companyName: ctx.companyName,
    todayIso: operatingDate(new Date()),
    canSchedule: ctx.can("scheduling.manage"),
    isEmployee: ctx.employeeId !== null,
  });

  const messages: AnthropicMessage[] = [...history, { role: "user", content: userMessage }];
  const proposals: AssistantTurn["proposals"] = [];
  const textParts: string[] = [];

  const maxTurns = options.maxTurns ?? MAX_TURNS;
  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await createMessage({ system, messages, tools: definitions }, options);

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) textParts.push(block.text.trim());
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });

    if (toolUses.length === 0) {
      return { turn: { text: textParts.join("\n\n"), proposals }, messages };
    }

    const results: ToolResultBlock[] = [];
    for (const call of toolUses) {
      if (call.type !== "tool_use") continue;

      // Dispatch against the FULL registry, not the filtered offer list.
      //
      // The model is only ever shown `available`, but if it names a tool its
      // role cannot use, that should come back as a refusal it can explain —
      // "this account cannot make scheduling changes" — rather than an
      // exception that kills the turn. `unknown_tool` then means what it says:
      // a name that exists nowhere, which is a protocol violation and fatal.
      const outcome = await runTool(registry, call.name, call.input, ctx);

      if (outcome.ok) {
        const value = outcome.result as Record<string, unknown> | null;
        // A proposal is lifted out for the UI. The model still sees it so it
        // can describe the plan in prose.
        if (value && typeof value === "object" && value.status === "proposed") {
          proposals.push({
            token: String(value.token),
            expiresAt: Number(value.expiresAt),
            summary: value.summary,
            kind: call.name,
          });
        }
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: capResult(outcome.ok ? stripToken(value) : value),
        });
      } else {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify({ error: outcome.code, message: outcome.message }),
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: results });
  }

  throw new AiError("turn_limit", `assistant exceeded ${maxTurns} turns`);
}

/**
 * The signing token never goes back upstream.
 *
 * It authorises a database write. There is no reason for it to sit in a model
 * context window, be echoed in generated text, or appear in a provider log.
 */
function stripToken(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const { token, ...rest } = value as Record<string, unknown>;
  return token === undefined ? value : { ...rest, token: "[held server-side]" };
}

/**
 * Keep one tool result from dominating the context window.
 *
 * Truncation is announced rather than silent: a model that is told the list was
 * cut can say so, whereas one handed a quietly shortened list will report the
 * shortened count as fact.
 */
function capResult(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
  return JSON.stringify({
    truncated: true,
    note: "Result was too large and has been cut. Narrow the query and try again.",
    preview: json.slice(0, MAX_TOOL_RESULT_CHARS),
  });
}

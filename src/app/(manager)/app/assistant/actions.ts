"use server";

import { z } from "zod";
import { validatedAction } from "@/lib/validation";
import { resolveAiContext } from "@/lib/ai/context";
import { runAssistantTurn } from "@/lib/ai/run";
import { executeConfirmedProposal, type ExecutionOutcome } from "@/lib/ai/execute";
import { isAiConfigured } from "@/lib/ai/anthropic";
import { AiError, type AiFailureCode } from "@/lib/ai/errors";
import { writeAudit } from "@/lib/audit";
import type { AnthropicMessage } from "@/lib/ai/anthropic";

/**
 * The two Server Actions the assistant UI calls.
 *
 * Both resolve identity from the session through `resolveAiContext()`. Neither
 * accepts a company, a user or a role from the browser — the schemas below have
 * no field for one, which is the cheapest possible way to guarantee it.
 */

/* ------------------------------------------------------------------ */
/* Ask                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The transcript the client replays.
 *
 * Only shapes the server itself emitted are accepted. Anything else fails the
 * schema, so a browser cannot inject a fabricated "tool result" of an
 * unexpected shape — and even a well-formed forgery only misleads the model,
 * because tools re-check every identifier against the tenant before use.
 */
const historyMessage = z.union([
  z.object({ role: z.literal("user"), content: z.string().max(8000) }),
  z.object({
    role: z.literal("user"),
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({
          type: z.literal("tool_result"),
          tool_use_id: z.string(),
          content: z.string(),
          is_error: z.boolean().optional(),
        }),
      ])
    ),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({
          type: z.literal("tool_use"),
          id: z.string(),
          name: z.string(),
          input: z.unknown(),
        }),
      ])
    ),
  }),
]);

/**
 * The transcript shape the client holds and replays. Exported so the UI does
 * not have to reach into `validatedAction`'s erased parameter type.
 */
export type AssistantHistory = z.infer<typeof historyMessage>[];

export type AskOutcome =
  | {
      kind: "answered";
      text: string;
      proposals: Array<{ token: string; expiresAt: number; summary: unknown; kind: string }>;
      history: AnthropicMessage[];
    }
  | { kind: "unavailable"; code: AiFailureCode };

export const askAssistant = validatedAction(
  z.object({
    message: z.string().trim().min(1).max(2000),
    /** Bounded so a long session cannot grow the request without limit. */
    history: z.array(historyMessage).max(40).optional(),
  }),
  async (input): Promise<AskOutcome> => {
    if (!isAiConfigured()) return { kind: "unavailable", code: "not_configured" };

    const ctx = await resolveAiContext();

    try {
      const { turn, messages } = await runAssistantTurn(
        ctx,
        (input.history ?? []) as AnthropicMessage[],
        input.message
      );

      // A proposal is a consequential thing to have offered, so it is recorded
      // even if the manager never confirms it. Questions are not audited: they
      // change nothing, and logging what a manager asked about their staff is
      // surveillance we have no reason to perform.
      for (const proposal of turn.proposals) {
        await writeAudit(ctx.auth, {
          action: `ai.${proposal.kind}.proposed`,
          entity: "ai_proposal",
          diff: { summary: proposal.summary },
        });
      }

      return {
        kind: "answered",
        text: turn.text,
        proposals: turn.proposals,
        // Trimmed to the tail: older turns rarely matter and every message is
        // re-sent upstream on the next question.
        history: messages.slice(-24),
      };
    } catch (error) {
      const code = error instanceof AiError ? error.code : "internal";
      // The message can carry upstream text; it belongs in the server log only.
      console.error("assistant turn failed:", error);
      return { kind: "unavailable", code };
    }
  }
);

/* ------------------------------------------------------------------ */
/* Confirm                                                             */
/* ------------------------------------------------------------------ */

export const confirmProposal = validatedAction(
  z.object({ token: z.string().min(1).max(8000) }),
  async (input): Promise<ExecutionOutcome> => {
    // Permission, verification, re-validation and the write itself all live in
    // executeConfirmedProposal — deliberately, so there is exactly one place to
    // read when asking "what can the assistant actually change?".
    return executeConfirmedProposal(input.token);
  }
);

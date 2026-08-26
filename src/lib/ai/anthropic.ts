import "server-only";

import { AiError, codeForStatus } from "@/lib/ai/errors";

/**
 * Minimal typed client for the Anthropic Messages API.
 *
 * Deliberately a thin fetch wrapper rather than the vendor SDK. Three reasons,
 * in order of weight:
 *
 *   1. Zero new dependencies. This repository pins Next 15 and has repeatedly
 *      declined dependency churn; an HTTP call to one documented endpoint does
 *      not justify a new supply-chain surface.
 *   2. `fetchImpl` is injectable, so every failure mode the tests must cover —
 *      malformed body, 429, 500, timeout — is expressible without a network or
 *      a mocking framework.
 *   3. We use exactly one endpoint and one response shape. The SDK's value is
 *      streaming, retries and pagination, none of which this feature uses.
 *
 * The key is read from the environment at call time and never leaves the
 * server. This module carries the "server-only" guard, so importing it from a
 * client component fails the build rather than shipping the key to a bundle.
 */

/** Documented default. Overridable per deployment via ANTHROPIC_MODEL. */
const DEFAULT_MODEL = "claude-sonnet-4-5";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Ceiling on one upstream call. A manager will not wait longer than this. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Output ceiling. Answers are short; proposals are structured, not prose. */
const DEFAULT_MAX_TOKENS = 1_500;

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ContentBlock = TextBlock | ToolUseBlock;

/** A tool result we hand back to the model on the next turn. */
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type AssistantMessage = {
  role: "assistant";
  content: ContentBlock[];
};

export type UserMessage = {
  role: "user";
  content: string | Array<TextBlock | ToolResultBlock>;
};

export type AnthropicMessage = UserMessage | AssistantMessage;

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type MessagesResponse = {
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type AnthropicClientOptions = {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Test seam. Production passes nothing and the global fetch is used. */
  fetchImpl?: FetchLike;
};

export type CreateMessageRequest = {
  system: string;
  messages: AnthropicMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
};

export function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

/** True when the deployment is configured to talk to Anthropic at all. */
export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * One round trip to the Messages API.
 *
 * Throws AiError for every failure path so callers never see an upstream body.
 * The raw text is attached to the Error message for the server log only.
 */
export async function createMessage(
  request: CreateMessageRequest,
  options: AnthropicClientOptions = {}
): Promise<MessagesResponse> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new AiError("not_configured", "ANTHROPIC_API_KEY is not set");
  }

  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // AbortController rather than Promise.race: racing leaves the request in
  // flight and still billing, which is the wrong behaviour for a paid API.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let status = 0;
  let bodyText = "";
  try {
    const response = await doFetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": API_VERSION,
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: options.model ?? anthropicModel(),
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: request.system,
        messages: request.messages,
        ...(request.tools?.length ? { tools: request.tools } : {}),
      }),
      signal: controller.signal,
    });
    status = response.status;
    bodyText = await response.text();

    if (!response.ok) {
      throw new AiError(codeForStatus(status), `anthropic ${status}: ${truncate(bodyText)}`);
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    // An aborted fetch surfaces as AbortError in every runtime we target.
    if (isAbort(error)) {
      throw new AiError("timeout", `anthropic call exceeded ${timeoutMs}ms`);
    }
    throw new AiError(
      "upstream_unavailable",
      error instanceof Error ? error.message : "network failure"
    );
  } finally {
    clearTimeout(timer);
  }

  return parseMessagesResponse(bodyText);
}

/**
 * Exported so the malformed-response tests can exercise it without a fetch.
 * A 200 with an unusable body is a distinct failure from a 500 and the
 * manager-facing message differs, so it gets its own code.
 */
export function parseMessagesResponse(bodyText: string): MessagesResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new AiError("malformed_response", `non-JSON body: ${truncate(bodyText)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new AiError("malformed_response", "body was not an object");
  }
  const candidate = parsed as { content?: unknown; stop_reason?: unknown; usage?: unknown };
  if (!Array.isArray(candidate.content)) {
    throw new AiError("malformed_response", "content was not an array");
  }

  const content: ContentBlock[] = [];
  for (const block of candidate.content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      content.push({ type: "text", text: b.text });
    } else if (
      b.type === "tool_use" &&
      typeof b.id === "string" &&
      typeof b.name === "string"
    ) {
      content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
    // Unknown block types are dropped rather than fatal: the API may add
    // block kinds we do not consume, and that is not a failure of this call.
  }

  // Every non-empty response must carry something we can act on. An empty
  // content array after filtering means we understood none of it.
  if (content.length === 0) {
    throw new AiError("malformed_response", "no usable content blocks");
  }

  return {
    content,
    stop_reason: typeof candidate.stop_reason === "string" ? candidate.stop_reason : null,
    usage: (candidate.usage as MessagesResponse["usage"]) ?? undefined,
  };
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** Keep upstream text out of unbounded log lines. */
function truncate(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

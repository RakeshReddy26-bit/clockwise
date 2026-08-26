/**
 * Everything that can go wrong between Clockwise and the model, named.
 *
 * Pure and dependency-free so both the client module and the tests can use it.
 * The point of a closed set of codes is that the UI maps each one to a sentence
 * a manager can act on — "the assistant is busy, try again" is useful, a raw
 * upstream error body is not, and may carry request ids or key fragments.
 */

export type AiFailureCode =
  /** No ANTHROPIC_API_KEY configured. Deployment problem, not a user problem. */
  | "not_configured"
  /** Upstream rejected our credentials. */
  | "unauthorized"
  /** 429 — too many requests, ours or the account's. */
  | "rate_limited"
  /** The request exceeded our own deadline. */
  | "timeout"
  /** 5xx or a network failure reaching the API. */
  | "upstream_unavailable"
  /** 200 with a body we cannot parse into the shape we expect. */
  | "malformed_response"
  /** The model asked for a tool that is not in the registry. */
  | "unknown_tool"
  /** The model called a known tool with arguments that failed its schema. */
  | "invalid_tool_input"
  /** The conversation hit the turn ceiling without settling. */
  | "turn_limit"
  /** Anything else. Never carries upstream text. */
  | "internal";

export class AiError extends Error {
  constructor(
    public readonly code: AiFailureCode,
    /**
     * Operator-facing detail. Logged, never returned to the browser — an
     * upstream body can contain request identifiers and echoed headers.
     */
    message?: string,
    /** Extra context for the UI that is safe to show, e.g. the tool name. */
    public readonly safeDetail?: string
  ) {
    super(message ?? code);
    this.name = "AiError";
  }
}

/** Retrying the same request could plausibly succeed. */
export function isRetryable(code: AiFailureCode): boolean {
  return code === "rate_limited" || code === "timeout" || code === "upstream_unavailable";
}

/**
 * Map an HTTP status from the Messages API onto our taxonomy.
 * 408/409/500+ are the retryable band; 401/403 are a deployment mistake.
 */
export function codeForStatus(status: number): AiFailureCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status >= 500) return "upstream_unavailable";
  return "internal";
}

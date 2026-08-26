import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createMessage,
  parseMessagesResponse,
  anthropicModel,
  isAiConfigured,
  type FetchLike,
} from "@/lib/ai/anthropic";
import { AiError, isRetryable, codeForStatus } from "@/lib/ai/errors";

/**
 * Failure handling for the upstream call.
 *
 * Requirements 14–17 (malformed response, API failure, timeout, rate limit)
 * live here. Every one is exercised through the injected fetch, so the suite
 * needs no network and no mocking framework.
 */

const KEY = "test-key-not-a-real-secret";

function respondWith(status: number, body: string): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

const OK_BODY = JSON.stringify({
  content: [{ type: "text", text: "Three shifts are understaffed." }],
  stop_reason: "end_turn",
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createMessage — success", () => {
  it("returns the parsed content blocks", async () => {
    const response = await createMessage(
      { system: "s", messages: [{ role: "user", content: "hi" }] },
      { apiKey: KEY, fetchImpl: respondWith(200, OK_BODY) }
    );
    expect(response.content).toEqual([
      { type: "text", text: "Three shifts are understaffed." },
    ]);
  });

  it("sends the key as a header and never in the body", async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null;
    const spy: FetchLike = async (_url, init) => {
      seen = { headers: init.headers, body: init.body };
      return { ok: true, status: 200, text: async () => OK_BODY };
    };

    await createMessage(
      { system: "s", messages: [{ role: "user", content: "hi" }] },
      { apiKey: KEY, fetchImpl: spy }
    );

    const captured = seen as unknown as { headers: Record<string, string>; body: string };
    expect(captured.headers["x-api-key"]).toBe(KEY);
    expect(captured.body).not.toContain(KEY);
  });

  it("refuses to call at all without a key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(
      createMessage({ system: "s", messages: [] }, { fetchImpl: respondWith(200, OK_BODY) })
    ).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("createMessage — failures", () => {
  it("maps 429 to rate_limited", async () => {
    await expect(
      createMessage(
        { system: "s", messages: [] },
        { apiKey: KEY, fetchImpl: respondWith(429, '{"error":"slow down"}') }
      )
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("maps 500 to upstream_unavailable", async () => {
    await expect(
      createMessage(
        { system: "s", messages: [] },
        { apiKey: KEY, fetchImpl: respondWith(500, "boom") }
      )
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("maps 401 to unauthorized", async () => {
    await expect(
      createMessage(
        { system: "s", messages: [] },
        { apiKey: KEY, fetchImpl: respondWith(401, "nope") }
      )
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("treats an aborted request as a timeout", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    await expect(
      createMessage({ system: "s", messages: [] }, { apiKey: KEY, fetchImpl: hang, timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("treats a network failure as upstream_unavailable", async () => {
    const boom: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      createMessage({ system: "s", messages: [] }, { apiKey: KEY, fetchImpl: boom })
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("never puts the upstream body in a user-safe field", async () => {
    try {
      await createMessage(
        { system: "s", messages: [] },
        { apiKey: KEY, fetchImpl: respondWith(500, "secret-internal-trace") }
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).safeDetail).toBeUndefined();
    }
  });
});

describe("parseMessagesResponse — malformed bodies", () => {
  it("rejects non-JSON", () => {
    expect(() => parseMessagesResponse("<html>502</html>")).toThrowError(
      expect.objectContaining({ code: "malformed_response" })
    );
  });

  it("rejects JSON that is not an object", () => {
    expect(() => parseMessagesResponse("[1,2,3]")).toThrowError(
      expect.objectContaining({ code: "malformed_response" })
    );
  });

  it("rejects a body with no content array", () => {
    expect(() => parseMessagesResponse('{"stop_reason":"end_turn"}')).toThrowError(
      expect.objectContaining({ code: "malformed_response" })
    );
  });

  it("rejects a response whose blocks are all unusable", () => {
    expect(() =>
      parseMessagesResponse('{"content":[{"type":"future_block","data":1}]}')
    ).toThrowError(expect.objectContaining({ code: "malformed_response" }));
  });

  it("keeps usable blocks and drops unknown ones alongside them", () => {
    const parsed = parseMessagesResponse(
      JSON.stringify({
        content: [
          { type: "future_block" },
          { type: "text", text: "ok" },
          { type: "tool_use", id: "tu_1", name: "list_shifts", input: { from: "2027-01-01" } },
        ],
      })
    );
    expect(parsed.content).toHaveLength(2);
    expect(parsed.content[1]).toMatchObject({ type: "tool_use", name: "list_shifts" });
  });

  it("drops a tool_use block missing its id rather than trusting it", () => {
    expect(() =>
      parseMessagesResponse('{"content":[{"type":"tool_use","name":"list_shifts"}]}')
    ).toThrowError(expect.objectContaining({ code: "malformed_response" }));
  });
});

describe("configuration", () => {
  it("reports whether a key is present", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(isAiConfigured()).toBe(false);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(isAiConfigured()).toBe(true);
  });

  it("uses a current default model and lets the deployment override it", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    const fallback = anthropicModel();
    expect(fallback).toMatch(/^claude-/);
    // Guard against a deprecated model creeping back in as the default.
    expect(fallback).not.toMatch(/claude-(1|2|instant)/);

    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-4-1");
    expect(anthropicModel()).toBe("claude-opus-4-1");
  });
});

describe("error taxonomy", () => {
  it("marks only the transient codes retryable", () => {
    expect(isRetryable("rate_limited")).toBe(true);
    expect(isRetryable("timeout")).toBe(true);
    expect(isRetryable("upstream_unavailable")).toBe(true);
    expect(isRetryable("unauthorized")).toBe(false);
    expect(isRetryable("invalid_tool_input")).toBe(false);
  });

  it("maps statuses onto codes", () => {
    expect(codeForStatus(401)).toBe("unauthorized");
    expect(codeForStatus(429)).toBe("rate_limited");
    expect(codeForStatus(408)).toBe("timeout");
    expect(codeForStatus(503)).toBe("upstream_unavailable");
    expect(codeForStatus(418)).toBe("internal");
  });
});

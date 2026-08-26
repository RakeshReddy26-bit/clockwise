import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { runAssistantTurn } from "@/lib/ai/run";
import { defineTool, type AiTool } from "@/lib/ai/tools/registry";
import type { AiContext } from "@/lib/ai/context";
import type { FetchLike } from "@/lib/ai/anthropic";
import { roleHas, type Permission, type Role } from "@/lib/permissions";

/**
 * The conversation loop.
 *
 * Requirements 13 (follow-up context) and the turn ceiling live here, plus the
 * rule that a signing token never travels back upstream.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const KEY = "test-key";

function contextFor(role: Role = "DISPATCHER"): AiContext {
  return {
    auth: {
      userId: USER,
      membership: { id: "m", company_id: COMPANY, role, status: "active" },
      supabase: null as never,
    },
    companyId: COMPANY,
    userId: USER,
    employeeId: null,
    companyName: "KSK",
    can: (permission: Permission) => roleHas(role, permission),
  };
}

/** A scripted upstream: each call returns the next body in the list. */
function scriptedFetch(bodies: unknown[]): { fetchImpl: FetchLike; sent: string[] } {
  const sent: string[] = [];
  let call = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    sent.push(init.body);
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, sent };
}

const textReply = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

const toolReply = (name: string, input: unknown, id = "tu_1") => ({
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
});

describe("runAssistantTurn", () => {
  it("returns the model's text when no tool is needed", async () => {
    const { fetchImpl } = scriptedFetch([textReply("Nothing needs attention.")]);
    const { turn } = await runAssistantTurn(contextFor(), [], "anything wrong?", {
      apiKey: KEY,
      fetchImpl,
      tools: [],
    });
    expect(turn.text).toBe("Nothing needs attention.");
    expect(turn.proposals).toEqual([]);
  });

  it("runs a tool, feeds the result back, and returns the follow-up answer", async () => {
    const listShifts = defineTool({
      name: "list_understaffed_shifts",
      kind: "read",
      description: "",
      permission: "employees.read",
      schema: z.object({ days: z.number().int().optional() }),
      handler: async () => ({
        count: 1,
        shifts: [{ shiftId: "shift-1", site: "Ostseekai", openSeats: 1 }],
      }),
    });

    const { fetchImpl, sent } = scriptedFetch([
      toolReply("list_understaffed_shifts", { days: 2 }),
      textReply("Ostseekai needs 1 more person."),
    ]);

    const { turn, messages } = await runAssistantTurn(
      contextFor(),
      [],
      "what needs attention?",
      { apiKey: KEY, fetchImpl, tools: [listShifts] }
    );

    expect(turn.text).toBe("Ostseekai needs 1 more person.");
    // The tool result was sent upstream on the second call.
    expect(sent[1]).toContain("Ostseekai");
    // …and the transcript carries it, which is what makes "fill the first one"
    // resolvable on the next turn without guessing an id.
    expect(JSON.stringify(messages)).toContain("shift-1");
  });

  /**
   * Requirement 13. The follow-up says "the first one"; the id it resolves to
   * has to come from the previous tool result, not from the model's memory.
   */
  it("carries prior tool results into the next question", async () => {
    const getDetails = defineTool({
      name: "get_shift_details",
      kind: "read",
      description: "",
      permission: "employees.read",
      schema: z.object({ shiftId: z.string() }),
      handler: async (input) => ({ shiftId: input.shiftId, site: "Ostseekai" }),
    });

    const history = [
      { role: "user" as const, content: "show understaffed shifts" },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "tu_0",
            name: "list_understaffed_shifts",
            input: {},
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "tu_0",
            content: JSON.stringify({ shifts: [{ shiftId: "shift-42", site: "Ostseekai" }] }),
          },
        ],
      },
    ];

    const { fetchImpl, sent } = scriptedFetch([
      toolReply("get_shift_details", { shiftId: "shift-42" }),
      textReply("That shift is at Ostseekai."),
    ]);

    const { turn } = await runAssistantTurn(contextFor(), history, "fill the first one", {
      apiKey: KEY,
      fetchImpl,
      tools: [getDetails],
    });

    expect(turn.text).toBe("That shift is at Ostseekai.");
    // The prior transcript reached the model, which is how the reference resolved.
    expect(sent[0]).toContain("shift-42");
  });

  it("lifts a proposal out for the UI and never sends its token upstream", async () => {
    const propose = defineTool({
      name: "propose_create_shifts",
      kind: "propose",
      description: "",
      permission: "scheduling.manage",
      schema: z.object({ requiredCount: z.number() }),
      handler: async () => ({
        status: "proposed",
        token: "SIGNED.TOKEN.VALUE",
        expiresAt: Date.now() + 60_000,
        summary: { site: "Ostseekai", shiftCount: 4 },
      }),
    });

    const { fetchImpl, sent } = scriptedFetch([
      toolReply("propose_create_shifts", { requiredCount: 3 }),
      textReply("Four shifts prepared. Nothing has been created yet."),
    ]);

    const { turn } = await runAssistantTurn(contextFor(), [], "create 4 shifts", {
      apiKey: KEY,
      fetchImpl,
      tools: [propose],
    });

    expect(turn.proposals).toHaveLength(1);
    expect(turn.proposals[0].token).toBe("SIGNED.TOKEN.VALUE");
    expect(turn.proposals[0].summary).toEqual({ site: "Ostseekai", shiftCount: 4 });

    // The token authorises a write; it must not sit in a provider's context.
    expect(sent.join("")).not.toContain("SIGNED.TOKEN.VALUE");
    expect(sent[1]).toContain("held server-side");
  });

  it("reports a refused tool to the model instead of ending the conversation", async () => {
    const gated = defineTool({
      name: "propose_create_shifts",
      kind: "propose",
      description: "",
      permission: "scheduling.manage",
      schema: z.object({}),
      handler: async () => ({ status: "proposed", token: "t", expiresAt: 0, summary: {} }),
    });

    const { fetchImpl, sent } = scriptedFetch([
      toolReply("propose_create_shifts", {}),
      textReply("This account cannot make scheduling changes."),
    ]);

    // HR_MANAGER lacks scheduling.manage, so the tool is not even offered —
    // and if the model names it anyway, dispatch refuses.
    const { turn } = await runAssistantTurn(contextFor("HR_MANAGER"), [], "create shifts", {
      apiKey: KEY,
      fetchImpl,
      tools: [gated],
    });

    expect(turn.text).toBe("This account cannot make scheduling changes.");
    expect(turn.proposals).toEqual([]);
    expect(sent[1]).toContain("forbidden");
  });

  it("stops rather than looping forever when the model keeps calling tools", async () => {
    const loop = defineTool({
      name: "list_shifts",
      kind: "read",
      description: "",
      permission: "employees.read",
      schema: z.object({}),
      handler: async () => ({ count: 0 }),
    });

    // The scripted fetch repeats its last body, so this never settles.
    const { fetchImpl } = scriptedFetch([toolReply("list_shifts", {})]);

    await expect(
      runAssistantTurn(contextFor(), [], "loop", {
        apiKey: KEY,
        fetchImpl,
        tools: [loop],
        maxTurns: 3,
      })
    ).rejects.toMatchObject({ code: "turn_limit" });
  });

  it("surfaces an unknown tool as a failure rather than improvising", async () => {
    const { fetchImpl } = scriptedFetch([toolReply("run_raw_sql", { q: "select 1" })]);
    await expect(
      runAssistantTurn(contextFor(), [], "hack", { apiKey: KEY, fetchImpl, tools: [] })
    ).rejects.toMatchObject({ code: "unknown_tool" });
  });

  it("propagates an upstream rate limit unchanged", async () => {
    const limited: FetchLike = async () => ({
      ok: false,
      status: 429,
      text: async () => "slow down",
    });
    await expect(
      runAssistantTurn(contextFor(), [], "hello", { apiKey: KEY, fetchImpl: limited, tools: [] })
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("only offers the model tools the caller's role may use", async () => {
    const tools: AiTool[] = [
      defineTool({
        name: "read_only",
        kind: "read",
        description: "",
        permission: "employees.read",
        schema: z.object({}),
        handler: async () => null,
      }),
      defineTool({
        name: "scheduling_only",
        kind: "propose",
        description: "",
        permission: "scheduling.manage",
        schema: z.object({}),
        handler: async () => null,
      }),
    ];

    const { fetchImpl, sent } = scriptedFetch([textReply("ok")]);
    await runAssistantTurn(contextFor("HR_MANAGER"), [], "hi", { apiKey: KEY, fetchImpl, tools });

    const request = JSON.parse(sent[0]) as { tools: Array<{ name: string }> };
    expect(request.tools.map((t) => t.name)).toEqual(["read_only"]);
  });

  it("truncates an oversized tool result and says so", async () => {
    const huge = defineTool({
      name: "list_employees",
      kind: "read",
      description: "",
      permission: "employees.read",
      schema: z.object({}),
      handler: async () => ({ employees: Array.from({ length: 5000 }, (_, i) => ({ i, n: "x".repeat(20) })) }),
    });

    const { fetchImpl, sent } = scriptedFetch([
      toolReply("list_employees", {}),
      textReply("Too many to list."),
    ]);

    await runAssistantTurn(contextFor(), [], "everyone", { apiKey: KEY, fetchImpl, tools: [huge] });
    expect(sent[1]).toContain("truncated");
  });
});

describe("secret hygiene", () => {
  /** Requirement 20, enforced at the source rather than the bundle. */
  it("never names the API key with a NEXT_PUBLIC_ prefix anywhere in src/", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) {
          const source = readFileSync(full, "utf8");
          if (source.includes("NEXT_PUBLIC_ANTHROPIC")) offenders.push(full);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  it("keeps the key readable only from modules carrying the server-only guard", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/ai/anthropic.ts", "utf8");
    expect(source).toContain('import "server-only"');
    // The env read happens in this module and nowhere in a client component.
    expect(source).toContain("process.env.ANTHROPIC_API_KEY");
  });

  it("does not read the API key from any client component", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) {
          const source = readFileSync(full, "utf8");
          const isClient = source.trimStart().startsWith('"use client"');
          if (isClient && source.includes("ANTHROPIC_API_KEY")) offenders.push(full);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});

// Keeps vitest from complaining about an unused import in some configurations.
void vi;

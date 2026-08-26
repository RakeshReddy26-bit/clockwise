import { describe, it, expect } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { runAssistantTurn } from "@/lib/ai/run";
import { defineTool } from "@/lib/ai/tools/registry";
import { toolDefinitions } from "@/lib/ai/tools/registry";
import type { AiContext } from "@/lib/ai/context";
import type { FetchLike } from "@/lib/ai/anthropic";
import { roleHas, type Permission, type Role } from "@/lib/permissions";
import { systemPrompt } from "@/lib/ai/prompt";

/**
 * Grounding: the assistant answers about this company from this company's data,
 * or it says it cannot.
 *
 * The behaviour that must never regress is the one the brief singles out: asked
 * about a site that does not exist, it declines and lists the real ones rather
 * than inventing a plausible terminal. That is enforced structurally — a site
 * name only becomes an id through a tenant-scoped lookup — and reinforced by
 * the prompt. Both are tested.
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

describe("a site that does not exist is never invented", () => {
  /**
   * The whole point: the model asked for "Gepack", the resolver found nothing,
   * and the refusal it hands back carries the REAL site list. There is no path
   * by which a made-up name becomes a job id.
   */
  it("returns a refusal naming the real sites when the resolver finds nothing", async () => {
    const propose = defineTool({
      name: "propose_create_shifts",
      kind: "propose",
      description: "",
      permission: "scheduling.manage",
      schema: z.object({ site: z.string() }),
      // Stands in for resolveJob's not_found branch, which is what really runs.
      handler: async (input) => ({
        status: "needs_input",
        missing: ["site"],
        hint: `No job matches "${input.site}". Available: Ostseekai, Schwedenkai, Norwegenkai.`,
      }),
    });

    const { fetchImpl, sent } = scriptedFetch([
      toolReply("propose_create_shifts", { site: "Gepack" }),
      textReply("No site called Gepack in this company. Sites: Ostseekai, Schwedenkai, Norwegenkai."),
    ]);

    const { turn } = await runAssistantTurn(contextFor(), [], "create shifts at Gepack", {
      apiKey: KEY,
      fetchImpl,
      tools: [propose],
    });

    // Nothing was proposed, so nothing can be confirmed.
    expect(turn.proposals).toEqual([]);
    // The model was told what really exists.
    expect(sent[1]).toContain("Ostseekai");
    expect(sent[1]).toContain("needs_input");
  });

  it("the resolver refuses rather than guessing when a name is ambiguous", async () => {
    const propose = defineTool({
      name: "propose_create_shifts",
      kind: "propose",
      description: "",
      permission: "scheduling.manage",
      schema: z.object({ site: z.string() }),
      handler: async (input) => ({
        status: "needs_input",
        missing: ["site"],
        hint: `"${input.site}" matches several jobs: A, B. Which one?`,
      }),
    });

    const { fetchImpl } = scriptedFetch([
      toolReply("propose_create_shifts", { site: "Kai" }),
      textReply("That matches more than one site. Which one?"),
    ]);

    const { turn } = await runAssistantTurn(contextFor(), [], "shifts at Kai", {
      apiKey: KEY,
      fetchImpl,
      tools: [propose],
    });
    expect(turn.proposals).toEqual([]);
  });

  /** Structural: a site name cannot become an id except through the tenant. */
  it("no proposal tool accepts a job or location id from the model", async () => {
    const { PROPOSE_TOOLS } = await import("@/lib/ai/tools/propose");
    const create = PROPOSE_TOOLS.find((t) => t.name === "propose_create_shifts");
    expect(create).toBeDefined();
    const properties = Object.keys(
      (toolDefinitions([create!])[0].input_schema.properties ?? {}) as object
    );
    expect(properties).toContain("site");
    for (const forbidden of ["jobId", "job_id", "locationId", "location_id"]) {
      expect(properties).not.toContain(forbidden);
    }
  });

  it("the site resolver only ever looks inside the caller's company", () => {
    const source = readFileSync("src/lib/ai/tools/propose.ts", "utf8");
    const start = source.indexOf("async function resolveJob(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain('.eq("company_id", ctx.companyId)');
    // And it never falls back to a fuzzy pick when nothing matched.
    expect(body).toContain('reason: "not_found"');
    expect(body).toContain('reason: "ambiguous"');
  });
});

describe("company questions are answered from company data", () => {
  it("the prompt forbids answering from general knowledge", () => {
    const prompt = systemPrompt({
      companyName: "KSK",
      todayIso: "2027-06-01",
      canSchedule: true,
      isEmployee: false,
    });
    expect(prompt).toMatch(/only from tool results/i);
    expect(prompt).toMatch(/Never invent a name, a count, a time/i);
    expect(prompt).toMatch(/list what does exist/i);
  });

  it("the prompt tells it to lead with the answer rather than narrate", () => {
    const prompt = systemPrompt({
      companyName: "KSK",
      todayIso: "2027-06-01",
      canSchedule: true,
      isEmployee: false,
    });
    expect(prompt).toMatch(/Lead with the answer/i);
    expect(prompt).toMatch(/Never narrate your own process/i);
  });

  it("tells a read-only role plainly that it cannot schedule", () => {
    const prompt = systemPrompt({
      companyName: "KSK",
      todayIso: "2027-06-01",
      canSchedule: false,
      isEmployee: false,
    });
    expect(prompt).toMatch(/cannot make scheduling changes/i);
    expect(prompt).not.toMatch(/propose_\* tools draft a plan/);
  });

  it("routes summary questions to the single briefing call", () => {
    const prompt = systemPrompt({
      companyName: "KSK",
      todayIso: "2027-06-01",
      canSchedule: true,
      isEmployee: false,
    });
    expect(prompt).toContain("get_operations_briefing");
    expect(prompt).toMatch(/leave it out rather than estimating/i);
  });
});

describe("the briefing tool", () => {
  it("is registered, permission-gated, and takes only a date", async () => {
    const { BRIEFING_TOOLS } = await import("@/lib/ai/tools/briefing");
    const [briefing] = BRIEFING_TOOLS;
    expect(briefing.name).toBe("get_operations_briefing");
    expect(briefing.permission).toBe("employees.read");

    const properties = Object.keys(
      (toolDefinitions([briefing])[0].input_schema.properties ?? {}) as object
    );
    expect(properties).toEqual(["date"]);
  });

  it("is offered ahead of the narrower read tools", async () => {
    const { ALL_TOOLS } = await import("@/lib/ai/run");
    expect(ALL_TOOLS[0].name).toBe("get_operations_briefing");
  });

  it("derives its numbers from the shared engines, not its own arithmetic", () => {
    const source = readFileSync("src/lib/ai/tools/briefing.ts", "utf8");
    for (const engine of ["attendanceStatus", "summarize", "shiftAttention", "buildAttentionItems"]) {
      expect(source).toContain(engine);
    }
    // No hand-rolled status thresholds.
    expect(source).not.toMatch(/graceMinutes\s*[=<>]/);
  });

  it("bounds every query it makes", () => {
    const source = readFileSync("src/lib/ai/tools/briefing.ts", "utf8");
    const selects = source.match(/\.from\(/g)?.length ?? 0;
    const bounds =
      (source.match(/\.limit\(/g)?.length ?? 0) + (source.match(/maybeSingle\(\)/g)?.length ?? 0);
    expect(bounds).toBeGreaterThanOrEqual(selects);
  });

  it("never writes", () => {
    const source = readFileSync("src/lib/ai/tools/briefing.ts", "utf8");
    for (const write of [".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(source).not.toContain(write);
    }
  });
});

describe("Ask AI from the dashboard", () => {
  /**
   * The attention card links to a question in words, not to a shift id. That
   * keeps internal identifiers out of a URL a manager might paste somewhere,
   * and means the assistant resolves the shift through the same tenant-scoped
   * path it would for a typed sentence.
   */
  it("passes a question, never an identifier", () => {
    const source = readFileSync("src/components/attention-panel.tsx", "utf8");
    expect(source).toContain("/app/assistant?ask=");
    expect(source).toContain("encodeURIComponent");
    // The Ask-AI link is built from a translation key, not from item.shiftId.
    const askLink = source.slice(source.indexOf("/app/assistant?ask="));
    expect(askLink.slice(0, 200)).not.toContain("shiftId");
  });

  it("caps the incoming question so a URL cannot become a long prompt", () => {
    const source = readFileSync("src/app/(manager)/app/assistant/page.tsx", "utf8");
    expect(source).toMatch(/ask\?\.slice\(0,\s*\d+\)/);
  });

  it("asks the carried question exactly once", () => {
    const source = readFileSync("src/app/(manager)/app/assistant/assistant-chat.tsx", "utf8");
    expect(source).toContain("askedInitial");
    expect(source).toContain("askedInitial.current = true");
  });
});

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  defineTool,
  runTool,
  toolDefinitions,
  toolsForContext,
  type AiTool,
} from "@/lib/ai/tools/registry";
import { AiError } from "@/lib/ai/errors";
import type { AiContext } from "@/lib/ai/context";
import type { Permission, Role } from "@/lib/permissions";
import { roleHas } from "@/lib/permissions";

/**
 * The tool boundary.
 *
 * Requirements 4, 5, 6, 18 and 19 are here: model-supplied identity is ignored,
 * bad ids are rejected, there is no SQL surface, an unknown tool is an error,
 * and arguments that fail Zod never reach a handler.
 */

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";

/** A context that behaves like a real one for permissions and tenancy. */
function contextFor(role: Role, companyId = COMPANY_A): AiContext {
  return {
    auth: {
      userId: USER_A,
      membership: { id: "m", company_id: companyId, role, status: "active" },
      // Handlers under test here never touch the database.
      supabase: null as never,
    },
    companyId,
    userId: USER_A,
    employeeId: null,
    companyName: "KSK",
    can: (permission: Permission) => roleHas(role, permission),
  };
}

/** Records what the handler was actually given. */
function spyTool(permission?: Permission) {
  const seen: Array<{ input: unknown; companyId: string; userId: string }> = [];
  const tool = defineTool({
    name: "spy_tool",
    kind: "read",
    description: "test",
    ...(permission ? { permission } : {}),
    schema: z.object({ shiftId: z.string().uuid(), limit: z.number().int().min(1).max(10) }),
    handler: async (input, ctx) => {
      seen.push({ input, companyId: ctx.companyId, userId: ctx.userId });
      return { ok: true };
    },
  });
  return { tool, seen };
}

describe("runTool — dispatch and validation", () => {
  it("runs a registered tool and hands it the validated input", async () => {
    const { tool, seen } = spyTool();
    const outcome = await runTool(
      [tool],
      "spy_tool",
      { shiftId: "44444444-4444-4444-8444-444444444444", limit: 3 },
      contextFor("DISPATCHER")
    );
    expect(outcome).toEqual({ ok: true, result: { ok: true } });
    expect(seen[0].input).toEqual({
      shiftId: "44444444-4444-4444-8444-444444444444",
      limit: 3,
    });
  });

  /** Requirement 18. */
  it("throws on a tool the registry does not contain", async () => {
    const { tool } = spyTool();
    await expect(
      runTool([tool], "run_sql", { query: "select * from employees" }, contextFor("COMPANY_ADMIN"))
    ).rejects.toBeInstanceOf(AiError);

    await expect(
      runTool([tool], "run_sql", {}, contextFor("COMPANY_ADMIN"))
    ).rejects.toMatchObject({ code: "unknown_tool" });
  });

  /** Requirement 19. */
  it("refuses arguments that fail the schema, without calling the handler", async () => {
    const { tool, seen } = spyTool();
    const outcome = await runTool(
      [tool],
      "spy_tool",
      { shiftId: "not-a-uuid", limit: 3 },
      contextFor("DISPATCHER")
    );
    expect(outcome).toMatchObject({ ok: false, code: "invalid_tool_input" });
    expect(seen).toHaveLength(0);
  });

  /** Requirement 5. */
  it("rejects an out-of-range numeric argument", async () => {
    const { tool, seen } = spyTool();
    const outcome = await runTool(
      [tool],
      "spy_tool",
      { shiftId: "44444444-4444-4444-8444-444444444444", limit: 9999 },
      contextFor("DISPATCHER")
    );
    expect(outcome).toMatchObject({ ok: false, code: "invalid_tool_input" });
    expect(seen).toHaveLength(0);
  });

  /**
   * Requirement 4 — the load-bearing one.
   *
   * The model can put whatever it likes in the arguments. It cannot change who
   * the caller is, because the schema strips unknown keys and the handler reads
   * the tenant from the context instead.
   */
  it("ignores company_id, user_id and role supplied by the model", async () => {
    const { tool, seen } = spyTool();
    const outcome = await runTool(
      [tool],
      "spy_tool",
      {
        shiftId: "44444444-4444-4444-8444-444444444444",
        limit: 1,
        company_id: COMPANY_B,
        companyId: COMPANY_B,
        user_id: "99999999-9999-4999-8999-999999999999",
        role: "SUPER_ADMIN",
      },
      contextFor("DISPATCHER", COMPANY_A)
    );

    expect(outcome.ok).toBe(true);
    // The injected keys did not survive validation…
    expect(seen[0].input).toEqual({
      shiftId: "44444444-4444-4444-8444-444444444444",
      limit: 1,
    });
    // …and the handler still saw the session's tenant.
    expect(seen[0].companyId).toBe(COMPANY_A);
    expect(seen[0].userId).toBe(USER_A);
  });

  it("refuses a tool the caller's role may not use", async () => {
    const { tool, seen } = spyTool("scheduling.manage");
    // HR_MANAGER deliberately lacks scheduling.manage in permissions.ts.
    const outcome = await runTool(
      [tool],
      "spy_tool",
      { shiftId: "44444444-4444-4444-8444-444444444444", limit: 1 },
      contextFor("HR_MANAGER")
    );
    expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
    expect(seen).toHaveLength(0);
  });

  it("turns a handler crash into a refusal, without leaking the message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exploding = defineTool({
      name: "boom",
      kind: "read",
      description: "test",
      schema: z.object({}),
      handler: async () => {
        throw new Error('relation "employees" does not exist');
      },
    });

    const outcome = await runTool([exploding], "boom", {}, contextFor("COMPANY_ADMIN"));
    expect(outcome).toMatchObject({ ok: false, code: "tool_failed" });
    if (!outcome.ok) expect(outcome.message).not.toContain("employees");
    vi.restoreAllMocks();
  });
});

describe("toolsForContext", () => {
  it("hides tools a role cannot use from the model entirely", () => {
    const tools: AiTool[] = [
      defineTool({
        name: "read_thing",
        kind: "read",
        description: "",
        permission: "employees.read",
        schema: z.object({}),
        handler: async () => null,
      }),
      defineTool({
        name: "schedule_thing",
        kind: "propose",
        description: "",
        permission: "scheduling.manage",
        schema: z.object({}),
        handler: async () => null,
      }),
    ];

    const hr = toolsForContext(tools, contextFor("HR_MANAGER")).map((t) => t.name);
    expect(hr).toEqual(["read_thing"]);

    const dispatcher = toolsForContext(tools, contextFor("DISPATCHER")).map((t) => t.name);
    expect(dispatcher).toEqual(["read_thing", "schedule_thing"]);

    const employee = toolsForContext(tools, contextFor("EMPLOYEE")).map((t) => t.name);
    expect(employee).toEqual([]);
  });
});

describe("tool surface", () => {
  it("produces an object JSON Schema for every tool", () => {
    const tools: AiTool[] = [
      defineTool({
        name: "t",
        kind: "read",
        description: "d",
        schema: z.object({ from: z.string(), limit: z.number().optional() }),
        handler: async () => null,
      }),
    ];
    const [definition] = toolDefinitions(tools);
    expect(definition.name).toBe("t");
    expect(definition.input_schema.type).toBe("object");
    expect(Object.keys(definition.input_schema.properties as object)).toContain("from");
  });

  /** Requirement 6: there is no free-form query surface to reach. */
  it("exposes no tool that accepts SQL or a table name", async () => {
    const { READ_TOOLS } = await import("@/lib/ai/tools/read");
    const { PROPOSE_TOOLS } = await import("@/lib/ai/tools/propose");
    const all = [...READ_TOOLS, ...PROPOSE_TOOLS];

    for (const tool of all) {
      const schema = JSON.stringify(toolDefinitions([tool])[0].input_schema).toLowerCase();
      for (const forbidden of ["sql", "query_text", "table", "raw", "statement"]) {
        expect(schema).not.toContain(`"${forbidden}"`);
      }
    }
  });

  /** Requirement 4, at the schema level rather than the dispatch level. */
  it("declares no tenant or identity argument anywhere in the registry", async () => {
    const { READ_TOOLS } = await import("@/lib/ai/tools/read");
    const { PROPOSE_TOOLS } = await import("@/lib/ai/tools/propose");

    for (const tool of [...READ_TOOLS, ...PROPOSE_TOOLS]) {
      const properties = Object.keys(
        (toolDefinitions([tool])[0].input_schema.properties ?? {}) as object
      );
      for (const forbidden of ["companyId", "company_id", "profileId", "profile_id", "role", "userId", "user_id"]) {
        expect(properties).not.toContain(forbidden);
      }
    }
  });

  it("registers every read and proposal tool under a unique name", async () => {
    const { READ_TOOLS } = await import("@/lib/ai/tools/read");
    const { PROPOSE_TOOLS } = await import("@/lib/ai/tools/propose");
    const names = [...READ_TOOLS, ...PROPOSE_TOOLS].map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /** Requirement 8: nothing that writes is reachable from the model. */
  it("has no tool whose kind is execution", async () => {
    const { READ_TOOLS } = await import("@/lib/ai/tools/read");
    const { PROPOSE_TOOLS } = await import("@/lib/ai/tools/propose");
    for (const tool of [...READ_TOOLS, ...PROPOSE_TOOLS]) {
      expect(["read", "propose"]).toContain(tool.kind);
      expect(tool.name).not.toMatch(/^execute_/);
    }
  });
});

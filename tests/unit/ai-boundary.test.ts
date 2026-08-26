import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The architectural boundary, asserted against the source.
 *
 * These read like an odd sort of test, so it is worth saying why they exist.
 * The rules this feature has to hold — Claude never writes, eligibility comes
 * from one engine, nothing bypasses the existing Server Actions — are
 * properties of the *shape* of the code. A behavioural test can show that
 * today's path is safe; only a structural one notices when somebody adds a
 * second path next year.
 *
 * Each assertion below corresponds to a sentence in the design that a reviewer
 * would otherwise have to take on trust.
 */

const read = (path: string) => readFileSync(path, "utf8");

const EXECUTE = "src/lib/ai/execute.ts";
const PROPOSE = "src/lib/ai/tools/propose.ts";
const READ_TOOLS = "src/lib/ai/tools/read.ts";
const RUN = "src/lib/ai/run.ts";
const ACTIONS = "src/app/(manager)/app/assistant/actions.ts";

describe("Claude is not the mutation engine", () => {
  /** Requirement 8: a write is only reachable through a confirmed proposal. */
  it("execution verifies a signed proposal before doing anything", () => {
    const source = read(EXECUTE);
    const verifyAt = source.indexOf("verifyProposal(");
    const firstWriteAt = Math.min(
      ...["createShift(", "sendShiftOffer(", "approveOfferResponse(", "updateShift("]
        .map((call) => source.indexOf(call))
        .filter((index) => index >= 0)
    );
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(firstWriteAt);
  });

  it("execution re-checks the permission from the session, not from the token", () => {
    const source = read(EXECUTE);
    expect(source).toContain('requirePermission("scheduling.manage")');
    // The identity compared against the token comes from that call.
    expect(source).toContain("userId: ctx.userId");
    expect(source).toContain("companyId: ctx.membership.company_id");
  });

  it("execution delegates to the existing Server Actions instead of its own SQL", () => {
    const source = read(EXECUTE);
    for (const action of ["createShift", "sendShiftOffer", "approveOfferResponse", "updateShift"]) {
      expect(source).toContain(action);
    }
    // No direct table access anywhere in the execution path.
    expect(source).not.toMatch(/\.from\(["'`]/);
    expect(source).not.toMatch(/\brpc\(/);
  });

  /** Requirement 6: the model has no SQL surface, at any layer. */
  it("no AI module builds SQL from model input", () => {
    for (const path of [EXECUTE, PROPOSE, READ_TOOLS, RUN]) {
      const source = read(path);
      expect(source).not.toMatch(/\bselect\s+\*\s+from\b/i);
      expect(source).not.toMatch(/\.rpc\(\s*[a-zA-Z_$][\w$]*\s*[,)]/);
    }
  });

  it("proposal tools never write", () => {
    const source = read(PROPOSE);
    for (const write of [".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(source).not.toContain(write);
    }
  });

  it("read tools never write", () => {
    const source = read(READ_TOOLS);
    for (const write of [".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(source).not.toContain(write);
    }
  });
});

describe("eligibility has exactly one source", () => {
  /** Requirement 9: the engine decides, the assistant only relays. */
  it("the candidate tool calls the shared engine", () => {
    const source = read(READ_TOOLS);
    expect(source).toContain("rankCandidates");
    expect(source).toContain("loadCandidateInputsForShift");
    expect(source).toContain("toShiftContext");
  });

  it("the offer proposal re-runs the engine rather than trusting the model's picks", () => {
    const source = read(PROPOSE);
    expect(source).toContain("rankCandidates");
    // A candidate the engine did not mark eligible must be dropped.
    expect(source).toContain("verdict.eligible");
  });

  /**
   * The AI layer must not grow its own idea of who is suitable. Any of these
   * words appearing here would mean a second, unreviewed ranking exists.
   */
  it("no AI module invents its own scoring or suitability vocabulary", () => {
    for (const path of [PROPOSE, READ_TOOLS, RUN, EXECUTE]) {
      const source = read(path).toLowerCase();
      for (const forbidden of [
        "performancescore",
        "reliabilityscore",
        "suitabilityscore",
        "rankbyperformance",
        "personality",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  /** EU employment safety: no opaque judgements about people. */
  it("the prompt forbids performance and personality judgements", () => {
    const prompt = read("src/lib/ai/prompt.ts");
    expect(prompt).toContain("performance");
    expect(prompt).toMatch(/never (comment on|produce reasons)/i);
    expect(prompt).toContain("availability, conflicts, qualifications");
  });
});

describe("identity is resolved server-side", () => {
  /** Requirement 4, structurally rather than behaviourally. */
  it("the ask action takes no tenant, user or role from the request", () => {
    const source = read(ACTIONS);
    // The schema declares exactly these fields and nothing identity-shaped.
    expect(source).toContain("message: z.string()");
    expect(source).toContain("resolveAiContext()");

    // Identity-shaped names must never appear as an accepted input field.
    // `role` is excluded from this list deliberately: the transcript schema
    // uses it for a MESSAGE role ("user" / "assistant"), which is not identity.
    for (const forbidden of ["companyId", "company_id", "profileId", "profile_id", "userId", "user_id", "employeeId"]) {
      expect(source).not.toMatch(new RegExp(`\\n\\s+${forbidden}\\s*:\\s*z\\.`));
    }
    // And the only `role` field is the literal union of message roles.
    const roleFields = source.match(/\n\s+role:\s*z\.[^\n]*/g) ?? [];
    for (const field of roleFields) {
      expect(field).toMatch(/z\.literal\("(user|assistant)"\)/);
    }
  });

  it("the context is derived from requireContext, the same chain the app uses", () => {
    const source = read("src/lib/ai/context.ts");
    expect(source).toContain("requireContext()");
    expect(source).toContain('import "server-only"');
    // employeeId is looked up, never accepted.
    expect(source).toContain('.eq("profile_id", auth.userId)');
  });

  it("every AI server module carries the server-only guard", () => {
    for (const path of [EXECUTE, PROPOSE, READ_TOOLS, RUN, "src/lib/ai/context.ts", "src/lib/ai/anthropic.ts", "src/lib/ai/proposals.ts"]) {
      expect(read(path).startsWith('import "server-only"')).toBe(true);
    }
  });
});

describe("auditability", () => {
  /** Proposals and executions are traceable; transcripts are not stored. */
  it("records proposed, confirmed and the execution outcome", () => {
    expect(read(ACTIONS)).toContain(".proposed");
    const source = read(EXECUTE);
    expect(source).toContain(".confirmed");
    expect(source).toContain("writeAudit");
  });

  it("reuses the existing audit trail rather than a new table", () => {
    const source = read(EXECUTE);
    expect(source).toContain('from "@/lib/audit"');
    // No migration was added for this feature.
    expect(source).not.toContain("ai_audit");
  });

  it("does not put the conversation or the model's reasoning in the audit diff", () => {
    // Assert on the code that builds the diff, not on the prose around it.
    const source = read(EXECUTE);
    const start = source.indexOf("function auditDiff(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start);

    for (const leak of ["messages", "transcript", "reasoning", "content", "prompt"]) {
      expect(body).not.toContain(leak);
    }
    // What it does emit is ids, kinds and counts.
    expect(body).toContain("kind: payload.kind");
  });
});

describe("cost and payload control", () => {
  it("caps turns, output tokens and tool result size", () => {
    expect(read(RUN)).toContain("MAX_TURNS");
    expect(read(RUN)).toContain("MAX_TOOL_RESULT_CHARS");
    expect(read("src/lib/ai/anthropic.ts")).toContain("DEFAULT_MAX_TOKENS");
  });

  it("bounds every list a read tool can return", () => {
    const source = read(READ_TOOLS);
    expect(source).toContain("const PAGE =");
    // Every Supabase query in the read tools ends in a bound.
    const selects = source.match(/\.from\(/g)?.length ?? 0;
    const bounds = (source.match(/\.limit\(/g)?.length ?? 0) + (source.match(/maybeSingle\(\)/g)?.length ?? 0);
    expect(bounds).toBeGreaterThanOrEqual(selects);
  });

  it("bounds the transcript the client may replay", () => {
    expect(read(ACTIONS)).toMatch(/\.max\(40\)/);
  });
});

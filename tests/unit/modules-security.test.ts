import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { toolDefinitions } from "@/lib/ai/tools/registry";
import { MODULE_TOOLS } from "@/lib/ai/tools/modules";

/**
 * The modules completed in this phase, checked at the boundary.
 *
 * Messages, calendar, jobs and news all sit on tables whose RLS was written in
 * migration 0002 and is genuinely good — participant-scoped chat, HR-only
 * documents, published-only news. So the risk is not the policies; it is a page
 * or an action quietly working around them. These tests pin the shape that
 * keeps the database in charge.
 */

const MESSAGES_ACTIONS = readFileSync("src/app/(manager)/app/messages/actions.ts", "utf8");
const NEWS_ACTIONS = readFileSync("src/app/(manager)/app/news/actions.ts", "utf8");
const CONVERSATIONS = readFileSync("src/lib/conversations.ts", "utf8");
const MODULE_TOOLS_SOURCE = readFileSync("src/lib/ai/tools/modules.ts", "utf8");
const RLS = readFileSync("supabase/migrations/0002_rls.sql", "utf8");

describe("the policies these features rely on still exist", () => {
  /**
   * If somebody weakens one of these in a later migration, the feature keeps
   * working and quietly stops being safe — which is exactly the failure a test
   * should catch rather than a reviewer.
   */
  it("chat is participant-scoped, not company-scoped", () => {
    expect(RLS).toContain("create policy conversations_select on public.conversations");
    expect(RLS).toContain("using (app.is_participant(id))");
    expect(RLS).toContain("create policy messages_select on public.messages");
    expect(RLS).toContain("using (app.is_participant(conversation_id))");
  });

  it("a message can only be posted by its own sender, into a thread they are in", () => {
    const start = RLS.indexOf("create policy messages_insert");
    const body = RLS.slice(start, start + 400);
    expect(body).toContain("app.is_participant(conversation_id)");
    expect(body).toContain("sender_id = auth.uid()");
  });

  it("only a participant's own read marker is updatable", () => {
    const start = RLS.indexOf("create policy participants_self_update");
    const body = RLS.slice(start, start + 200);
    expect(body).toContain("profile_id = auth.uid()");
  });

  it("members see only published announcements", () => {
    const start = RLS.indexOf("create policy news_select");
    const body = RLS.slice(start, start + 200);
    expect(body).toContain("app.is_member(company_id)");
    expect(body).toContain("published_at is not null");
  });

  it("documents stay HR-only, with employees reading just their own", () => {
    expect(RLS).toContain("create policy documents_hr on public.documents");
    expect(RLS).toContain("using (app.is_hr(company_id))");
    const selfSelect = RLS.slice(RLS.indexOf("create policy documents_self_select"), RLS.indexOf("create policy documents_self_insert"));
    expect(selfSelect).toContain("employee_id = app.current_employee_id(company_id)");
  });

  it("calendar events are member-readable and staff-writable", () => {
    expect(RLS).toContain("create policy calendar_select on public.calendar_events");
    expect(RLS).toContain("using (app.is_member(company_id))");
    expect(RLS).toContain("create policy calendar_write on public.calendar_events");
  });
});

describe("the messaging actions do not work around those policies", () => {
  it("resolves the sender from the session, never from the request", () => {
    expect(MESSAGES_ACTIONS).toContain("sender_id: ctx.userId");
    expect(MESSAGES_ACTIONS).not.toMatch(/senderId:\s*z\./);
    expect(MESSAGES_ACTIONS).not.toMatch(/profileId:\s*z\./);
  });

  it("takes the tenant from the membership, never from the request", () => {
    expect(MESSAGES_ACTIONS).toContain("company_id: ctx.membership.company_id");
    expect(MESSAGES_ACTIONS).not.toMatch(/companyId:\s*z\./);
  });

  it("resolves shift recipients from assignment rows, not from the browser", () => {
    const start = MESSAGES_ACTIONS.indexOf("export const messageShiftCrew");
    const body = MESSAGES_ACTIONS.slice(start, MESSAGES_ACTIONS.indexOf("/* ---", start));
    expect(body).toContain('.from("shift_assignments")');
    expect(body).toContain("OCCUPYING_ASSIGNMENT_STATUSES");
    // Only a shift id is accepted; the recipient list is derived.
    expect(body).not.toMatch(/profileIds:\s*z\./);
    expect(body).not.toMatch(/employeeIds:\s*z\./);
  });

  it("gates the staff-only entry points on a real permission", () => {
    expect(MESSAGES_ACTIONS).toContain('requirePermission("employees.read")');
    expect(MESSAGES_ACTIONS).toContain('requirePermission("scheduling.manage")');
  });

  it("only marks the caller's own participant row as read", () => {
    const start = MESSAGES_ACTIONS.indexOf("async function markRead");
    const body = MESSAGES_ACTIONS.slice(start);
    expect(body).toContain('.eq("profile_id", ctx.userId)');
  });

  it("uses an existing enum value rather than needing a migration", () => {
    // conversation_topic has no 'shift' member; 'schedule' does the job.
    expect(MESSAGES_ACTIONS).toContain('topic: "schedule"');
    expect(MESSAGES_ACTIONS).not.toContain('topic: "shift"');
  });

  it("bounds every conversation query", () => {
    const selects = CONVERSATIONS.match(/\.from\(/g)?.length ?? 0;
    const bounds = CONVERSATIONS.match(/\.limit\(/g)?.length ?? 0;
    expect(bounds).toBeGreaterThanOrEqual(selects);
  });
});

describe("announcements", () => {
  it("require news.manage on both write paths", () => {
    const gates = NEWS_ACTIONS.match(/requirePermission\("news\.manage"\)/g) ?? [];
    expect(gates.length).toBe(2);
  });

  it("publish state is a timestamp, so withdrawing genuinely hides it", () => {
    expect(NEWS_ACTIONS).toContain("published_at: input.published ? new Date().toISOString() : null");
  });

  it("scopes the update to the caller's company", () => {
    expect(NEWS_ACTIONS).toContain('.eq("company_id", ctx.membership.company_id)');
  });

  it("records what was published", () => {
    expect(NEWS_ACTIONS).toContain("writeAudit");
    expect(NEWS_ACTIONS).toContain("news.published");
    expect(NEWS_ACTIONS).toContain("news.unpublished");
  });
});

describe("the new AI tools", () => {
  it("declare no tenant or identity argument", () => {
    for (const tool of MODULE_TOOLS) {
      const properties = Object.keys(
        (toolDefinitions([tool])[0].input_schema.properties ?? {}) as object
      );
      for (const forbidden of ["companyId", "company_id", "profileId", "profile_id", "userId", "role"]) {
        expect(properties).not.toContain(forbidden);
      }
    }
  });

  it("are all permission-gated", () => {
    for (const tool of MODULE_TOOLS) {
      expect(tool.permission).toBeTruthy();
    }
  });

  it("keep documents behind the HR permission, not the general read one", () => {
    const documents = MODULE_TOOLS.find((t) => t.name === "get_employee_document_status");
    expect(documents?.permission).toBe("documents.manage");
  });

  it("never write", () => {
    for (const write of [".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(MODULE_TOOLS_SOURCE).not.toContain(write);
    }
  });

  it("bound every query", () => {
    const selects = MODULE_TOOLS_SOURCE.match(/\.from\(/g)?.length ?? 0;
    const bounds = MODULE_TOOLS_SOURCE.match(/\.limit\(/g)?.length ?? 0;
    expect(bounds).toBeGreaterThanOrEqual(selects);
  });

  it("scope every query to the resolved company", () => {
    const selects = MODULE_TOOLS_SOURCE.match(/\.from\("(\w+)"\)/g)?.length ?? 0;
    const scoped = MODULE_TOOLS_SOURCE.match(/\.eq\("company_id", ctx\.companyId\)/g)?.length ?? 0;
    expect(scoped).toBe(selects);
  });

  it("do not expose document contents or storage paths", () => {
    expect(MODULE_TOOLS_SOURCE).not.toContain("storage_path");
    expect(MODULE_TOOLS_SOURCE).not.toContain("signedUrl");
  });

  it("are registered so the assistant can actually reach them", async () => {
    const { ALL_TOOLS } = await import("@/lib/ai/run");
    const names = ALL_TOOLS.map((t) => t.name);
    for (const tool of MODULE_TOOLS) expect(names).toContain(tool.name);
    // And every registry name is still unique.
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the employee calendar shows only permitted personal data", () => {
  const SOURCE = readFileSync("src/app/(portal)/me/calendar/page.tsx", "utf8");

  it("filters shifts and absences to the resolved employee", () => {
    const employeeFilters = SOURCE.match(/\.eq\("employee_id", employee\.id\)/g) ?? [];
    // Assignments, holiday and sick leave — three self-scoped queries.
    expect(employeeFilters.length).toBeGreaterThanOrEqual(3);
  });

  it("resolves that employee from the session, not from a parameter", () => {
    expect(SOURCE).toContain('.eq("profile_id", ctx.userId)');
    expect(SOURCE).not.toMatch(/searchParams.*employeeId/);
  });

  it("reads company events company-wide, which is the one shared source", () => {
    expect(SOURCE).toContain('.from("calendar_events")');
    expect(SOURCE).toContain('.eq("company_id", ctx.membership.company_id)');
  });

  it("never queries another employee's absences", () => {
    // No unfiltered absence read: every one carries the employee predicate.
    const absenceReads = SOURCE.match(/\.from\("(vacation_requests|sick_leaves)"\)/g)?.length ?? 0;
    expect(absenceReads).toBe(2);
    expect(SOURCE).not.toContain("employees(full_name)");
  });
});

describe("secrets stay out of the browser bundle", () => {
  /**
   * `publicEnv()` is imported by real client components, so env.ts is bundled
   * for the browser. Defining the service-role schema in the same module put
   * its key NAME into a client chunk — no value, but enough to make a routine
   * "no secret in the bundle" grep report a hit, and a check that cries wolf is
   * one people stop reading. The server half now sits behind server-only.
   */
  it("env.ts mentions no server secret, not even as a schema key", () => {
    const source = readFileSync("src/lib/env.ts", "utf8");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(source).not.toContain("ANTHROPIC_API_KEY");
  });

  it("the server half carries the server-only guard", () => {
    const source = readFileSync("src/lib/env-server.ts", "utf8");
    expect(source.startsWith('import "server-only"')).toBe(true);
    expect(source).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("no client component imports the server env module", () => {


    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const source = readFileSync(full, "utf8");
          if (source.trimStart().startsWith('"use client"') && source.includes("env-server")) {
            offenders.push(full);
          }
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});

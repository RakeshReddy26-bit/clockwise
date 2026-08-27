import "server-only";

import { z } from "zod";
import { defineTool, type AiTool } from "@/lib/ai/tools/registry";
import { operatingDate, addDays } from "@/lib/ai/dates";
import { OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/eligibility";
import { shiftAttention } from "@/lib/shift-attention";

/**
 * Read tools for the modules completed in this phase.
 *
 * Same contract as every other tool: no tenant argument, permission-gated,
 * bounded, read-only, and queried through the caller's own client so RLS
 * decides first. Announcements are the clearest example — `news_select` returns
 * only published posts to a member, so an unpublished draft cannot reach the
 * model even if it asked for one.
 *
 * Nothing here writes. Messaging in particular is read-only to the assistant:
 * sending a message on somebody's behalf is a consequential action and would
 * need the propose-then-confirm path, which is a separate piece of work.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const PAGE = 30;

const listAnnouncements = defineTool({
  name: "list_announcements",
  kind: "read",
  permission: "employees.read",
  description:
    "Company announcements that are currently published. Use for 'what " +
    "announcements are active', 'what did we tell staff' and similar.",
  schema: z.object({
    limit: z.number().int().min(1).max(20).optional().describe("defaults to 5"),
  }),
  handler: async (input, ctx) => {
    const { data } = await ctx.auth.supabase
      .from("news_posts")
      .select("id, title, body, category, published_at")
      .eq("company_id", ctx.companyId)
      .order("published_at", { ascending: false })
      .limit(input.limit ?? 5);

    const posts = (data ?? []) as Array<{
      id: string;
      title: string;
      body: string;
      category: string | null;
      published_at: string | null;
    }>;

    return {
      count: posts.length,
      announcements: posts.map((p) => ({
        title: p.title,
        category: p.category,
        publishedAt: p.published_at,
        // Trimmed: the model needs the gist, not the whole notice.
        excerpt: p.body.length > 300 ? `${p.body.slice(0, 300)}…` : p.body,
      })),
    };
  },
});

const listCalendarEvents = defineTool({
  name: "list_calendar_events",
  kind: "read",
  permission: "employees.read",
  description:
    "Company calendar events in a date range — meetings, training, inspections. " +
    "Not shifts: use list_shifts for those.",
  schema: z.object({ from: isoDate, to: isoDate }),
  handler: async (input, ctx) => {
    const { data } = await ctx.auth.supabase
      .from("calendar_events")
      .select("id, type, title, starts_at, ends_at, locations(name)")
      .eq("company_id", ctx.companyId)
      .gte("starts_at", `${input.from}T00:00:00Z`)
      .lte("starts_at", `${input.to}T23:59:59Z`)
      .order("starts_at", { ascending: true })
      .limit(PAGE);

    const events = (data ?? []) as unknown as Array<{
      type: string;
      title: string;
      starts_at: string;
      ends_at: string;
      locations: { name: string } | null;
    }>;

    return {
      range: { from: input.from, to: input.to },
      count: events.length,
      events: events.map((e) => ({
        title: e.title,
        type: e.type,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        site: e.locations?.name ?? null,
      })),
    };
  },
});

const listJobs = defineTool({
  name: "list_jobs",
  kind: "read",
  permission: "employees.read",
  description:
    "Client work orders with the site they run at and how much upcoming work " +
    "they still need staffing for. Use for 'what jobs are at X' and 'which " +
    "client work is short'.",
  schema: z.object({
    site: z.string().trim().max(120).optional().describe("filter by site or client name"),
  }),
  handler: async (input, ctx) => {
    const { data: jobRows } = await ctx.auth.supabase
      .from("jobs")
      .select("id, client_name, status, description, locations(name)")
      .eq("company_id", ctx.companyId)
      .order("client_name")
      .limit(PAGE);

    let jobs = (jobRows ?? []) as unknown as Array<{
      id: string;
      client_name: string;
      status: string;
      description: string | null;
      locations: { name: string } | null;
    }>;

    if (input.site) {
      const needle = input.site.toLowerCase();
      jobs = jobs.filter(
        (j) =>
          (j.locations?.name ?? "").toLowerCase().includes(needle) ||
          j.client_name.toLowerCase().includes(needle)
      );
    }
    if (jobs.length === 0) return { count: 0, jobs: [] };

    const today = operatingDate(new Date());
    const [{ data: shifts }, { data: assignments }] = await Promise.all([
      ctx.auth.supabase
        .from("shifts")
        .select("id, job_id, required_count")
        .eq("company_id", ctx.companyId)
        .in("job_id", jobs.map((j) => j.id))
        .in("status", ["open", "staffed"])
        .gte("date", today)
        .limit(300),
      ctx.auth.supabase
        .from("shift_assignments")
        .select("shift_id")
        .eq("company_id", ctx.companyId)
        .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES])
        .limit(600),
    ]);

    const filled = new Map<string, number>();
    for (const row of (assignments ?? []) as Array<{ shift_id: string }>) {
      filled.set(row.shift_id, (filled.get(row.shift_id) ?? 0) + 1);
    }

    const perJob = new Map<string, { shifts: number; openSeats: number }>();
    for (const shift of (shifts ?? []) as Array<{
      id: string;
      job_id: string;
      required_count: number;
    }>) {
      const verdict = shiftAttention({
        filled: filled.get(shift.id) ?? 0,
        requiredCount: shift.required_count,
        hasOpenOffer: false,
      });
      const current = perJob.get(shift.job_id) ?? { shifts: 0, openSeats: 0 };
      perJob.set(shift.job_id, {
        shifts: current.shifts + 1,
        openSeats: current.openSeats + verdict.openSeats,
      });
    }

    return {
      count: jobs.length,
      jobs: jobs.map((j) => ({
        client: j.client_name,
        site: j.locations?.name ?? null,
        status: j.status,
        upcomingShifts: perJob.get(j.id)?.shifts ?? 0,
        openSeats: perJob.get(j.id)?.openSeats ?? 0,
      })),
    };
  },
});

const getEmployeeDocumentStatus = defineTool({
  name: "get_employee_document_status",
  kind: "read",
  // Documents are HR-only by policy (`documents_hr`), and a dispatcher gets no
  // access at all — payroll material stays with HR. The permission here matches
  // that, so a dispatcher asking is refused rather than shown an empty list.
  permission: "documents.manage",
  description:
    "Which document categories an employee has on file. Titles and categories " +
    "only — never file contents, and never another employee unless you name them.",
  schema: z.object({
    employeeId: z.string().uuid().optional().describe("omit for a company-wide count"),
  }),
  handler: async (input, ctx) => {
    let query = ctx.auth.supabase
      .from("documents")
      .select("id, category, title, created_at, employees(full_name)")
      .eq("company_id", ctx.companyId)
      .order("created_at", { ascending: false })
      .limit(PAGE);
    if (input.employeeId) query = query.eq("employee_id", input.employeeId);

    const { data } = await query;
    const docs = (data ?? []) as unknown as Array<{
      category: string;
      title: string;
      created_at: string;
      employees: { full_name: string } | null;
    }>;

    const byCategory = new Map<string, number>();
    for (const doc of docs) byCategory.set(doc.category, (byCategory.get(doc.category) ?? 0) + 1);

    return {
      count: docs.length,
      byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
      documents: docs.map((d) => ({
        title: d.title,
        category: d.category,
        employee: d.employees?.full_name ?? null,
        addedAt: d.created_at,
      })),
    };
  },
});

const listAbsencesOnDate = defineTool({
  name: "list_absences_on_date",
  kind: "read",
  permission: "employees.read",
  description:
    "Who is away on one specific day. Use for 'who is absent next Monday' — " +
    "narrower and cheaper than get_absences over a range.",
  schema: z.object({ date: isoDate }),
  handler: async (input, ctx) => {
    const [{ data: vacation }, { data: sick }] = await Promise.all([
      ctx.auth.supabase
        .from("vacation_requests")
        .select("employees(full_name)")
        .eq("company_id", ctx.companyId)
        .eq("status", "approved")
        .lte("start_date", input.date)
        .gte("end_date", input.date)
        .limit(PAGE),
      ctx.auth.supabase
        .from("sick_leaves")
        .select("expected_end_date, employees(full_name)")
        .eq("company_id", ctx.companyId)
        .in("status", ["reported", "confirmed"])
        .lte("start_date", input.date)
        .limit(PAGE),
    ]);

    const onHoliday = ((vacation ?? []) as unknown as Array<{
      employees: { full_name: string } | null;
    }>).map((v) => v.employees?.full_name ?? "—");

    // An open-ended sick leave has no end date, so it still covers the day.
    const offSick = ((sick ?? []) as unknown as Array<{
      expected_end_date: string | null;
      employees: { full_name: string } | null;
    }>)
      .filter((s) => s.expected_end_date === null || s.expected_end_date >= input.date)
      .map((s) => s.employees?.full_name ?? "—");

    return {
      date: input.date,
      totalAway: onHoliday.length + offSick.length,
      onHoliday,
      offSick,
      nextDay: addDays(input.date, 1),
    };
  },
});

export const MODULE_TOOLS: readonly AiTool[] = [
  listAnnouncements,
  listCalendarEvents,
  listJobs,
  listAbsencesOnDate,
  getEmployeeDocumentStatus,
];

import "server-only";

import { z } from "zod";
import { defineTool, type AiTool } from "@/lib/ai/tools/registry";
import type { AiContext } from "@/lib/ai/context";
import { operatingDate, addDays } from "@/lib/ai/dates";
import {
  OCCUPYING_ASSIGNMENT_STATUSES,
  rankCandidates,
  type IneligibleReason,
} from "@/lib/eligibility";
import { loadCandidateInputsForShift, toShiftContext, type ShiftRow } from "@/lib/candidates";
import { shiftAttention } from "@/lib/shift-attention";
import { attendanceThresholds, attendanceStatus, summarize } from "@/lib/attendance";

/**
 * Read tools: the assistant's only window onto Clockwise data.
 *
 * Every query below runs through `ctx.auth.supabase`, the caller's own client,
 * so RLS has already restricted the rows before this code sees them. The
 * explicit `.eq("company_id", ctx.companyId)` on top is belt and braces — it
 * makes the tenant boundary visible to a reader, and it means a future policy
 * mistake degrades to "no rows" rather than "another company's rows".
 *
 * Results are shaped small on purpose. The model is given names, times and
 * counts, not whole rows: it costs less, and a field the model never receives
 * is a field it can never leak.
 */

/* ------------------------------------------------------------------ */
/* Shared shapes and limits                                            */
/* ------------------------------------------------------------------ */

/** Nothing here returns an unbounded list. */
const PAGE = 40;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a calendar date as YYYY-MM-DD");

/** Today in the operating timezone, so "today" means what the manager means. */
function today(): string {
  return operatingDate(new Date());
}

type ShiftListRow = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  status: string;
  required_count: number;
  required_role: string | null;
  required_qualification: string | null;
  jobs: { client_name: string; locations: { name: string } | null } | null;
};

const SHIFT_SELECT =
  "id, company_id, date, start_time, end_time, status, required_count, required_role, required_qualification, jobs(client_name, locations(name))";

function siteOf(row: ShiftListRow): string {
  return row.jobs?.locations?.name ?? row.jobs?.client_name ?? "—";
}

/** Occupied seats per shift, in one query rather than one per row. */
async function occupancyFor(ctx: AiContext, shiftIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (shiftIds.length === 0) return counts;
  const { data } = await ctx.auth.supabase
    .from("shift_assignments")
    .select("shift_id")
    .eq("company_id", ctx.companyId)
    .in("shift_id", shiftIds)
    .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES])
    // PAGE shifts x a generous crew each: bounded, and far above any real day.
    .limit(PAGE * 25);
  for (const row of (data ?? []) as Array<{ shift_id: string }>) {
    counts.set(row.shift_id, (counts.get(row.shift_id) ?? 0) + 1);
  }
  return counts;
}

async function loadShifts(
  ctx: AiContext,
  opts: { from: string; to: string; limit?: number }
): Promise<ShiftListRow[]> {
  const { data } = await ctx.auth.supabase
    .from("shifts")
    .select(SHIFT_SELECT)
    .eq("company_id", ctx.companyId)
    .gte("date", opts.from)
    .lte("date", opts.to)
    .in("status", ["open", "staffed"])
    .order("start_time", { ascending: true })
    .limit(opts.limit ?? PAGE);
  return (data ?? []) as unknown as ShiftListRow[];
}

/** One shift, shaped for the model, with its staffing verdict attached. */
function describeShift(row: ShiftListRow, filled: number, hasOpenOffer = false) {
  const attention = shiftAttention({
    filled,
    requiredCount: row.required_count,
    hasOpenOffer,
  });
  return {
    shiftId: row.id,
    date: row.date,
    site: siteOf(row),
    client: row.jobs?.client_name ?? null,
    startTime: row.start_time,
    endTime: row.end_time,
    role: row.required_role,
    requiredQualification: row.required_qualification,
    required: row.required_count,
    filled,
    openSeats: attention.openSeats,
    staffing: attention.level,
    shiftStatus: row.status,
  };
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const listShifts = defineTool({
  name: "list_shifts",
  kind: "read",
  permission: "employees.read",
  description:
    "List shifts in a date range with staffing counts. Use for questions about " +
    "what is scheduled, who is needed, or what is happening on a given day. " +
    "Dates are calendar dates in the company's local timezone.",
  schema: z.object({
    from: isoDate.describe("first calendar date, inclusive"),
    to: isoDate.describe("last calendar date, inclusive"),
    site: z.string().trim().max(120).optional().describe("filter by site or client name"),
    onlyUnderstaffed: z.boolean().optional(),
  }),
  handler: async (input, ctx) => {
    const rows = await loadShifts(ctx, { from: input.from, to: input.to });
    const filtered = input.site
      ? rows.filter((r) => siteOf(r).toLowerCase().includes(input.site!.toLowerCase()))
      : rows;
    const occupancy = await occupancyFor(ctx, filtered.map((r) => r.id));

    const described = filtered.map((r) => describeShift(r, occupancy.get(r.id) ?? 0));
    const result = input.onlyUnderstaffed
      ? described.filter((s) => s.staffing === "understaffed")
      : described;

    return { range: { from: input.from, to: input.to }, count: result.length, shifts: result };
  },
});

const listUnderstaffedShifts = defineTool({
  name: "list_understaffed_shifts",
  kind: "read",
  permission: "employees.read",
  description:
    "Shifts that still have unfilled seats, soonest first. This is the answer to " +
    "'what needs attention' and 'which shifts are understaffed'.",
  schema: z.object({
    from: isoDate.optional().describe("defaults to today"),
    days: z.number().int().min(1).max(31).optional().describe("defaults to 7"),
  }),
  handler: async (input, ctx) => {
    const from = input.from ?? today();
    const to = addDays(from, (input.days ?? 7) - 1);
    const rows = await loadShifts(ctx, { from, to });
    const occupancy = await occupancyFor(ctx, rows.map((r) => r.id));

    const understaffed = rows
      .map((r) => describeShift(r, occupancy.get(r.id) ?? 0))
      .filter((s) => s.staffing === "understaffed");

    return { range: { from, to }, count: understaffed.length, shifts: understaffed };
  },
});

const getShiftDetails = defineTool({
  name: "get_shift_details",
  kind: "read",
  permission: "employees.read",
  description:
    "Full detail for one shift including who is assigned. Use after list_shifts " +
    "when the manager asks about a specific shift.",
  schema: z.object({ shiftId: z.string().uuid() }),
  handler: async (input, ctx) => {
    const { data: shift } = await ctx.auth.supabase
      .from("shifts")
      .select(`${SHIFT_SELECT}, instructions, contact_person`)
      .eq("company_id", ctx.companyId)
      .eq("id", input.shiftId)
      .maybeSingle();
    if (!shift) return { found: false as const };

    const row = shift as unknown as ShiftListRow;
    const { data: assignments } = await ctx.auth.supabase
      .from("shift_assignments")
      .select("id, status, employees(full_name, employee_no)")
      .eq("company_id", ctx.companyId)
      .eq("shift_id", input.shiftId)
      .limit(200);

    const people = ((assignments ?? []) as unknown as Array<{
      id: string;
      status: string;
      employees: { full_name: string; employee_no: string } | null;
    }>).map((a) => ({
      assignmentId: a.id,
      name: a.employees?.full_name ?? "—",
      employeeNo: a.employees?.employee_no ?? null,
      assignmentStatus: a.status,
    }));

    const filled = people.filter((p) =>
      (OCCUPYING_ASSIGNMENT_STATUSES as readonly string[]).includes(p.assignmentStatus)
    ).length;

    return { found: true as const, ...describeShift(row, filled), assigned: people };
  },
});

/**
 * The replacement tool. Its whole job is to call the existing engine.
 *
 * Note what is NOT here: no scoring the model invents, no "best fit" heuristic
 * written for the assistant. `rankCandidates` is the same function the manual
 * shift-planning page uses, and the reason codes come back verbatim. The model
 * may phrase them; it may not produce them.
 */
const findReplacementCandidates = defineTool({
  name: "find_replacement_candidates",
  kind: "read",
  permission: "scheduling.manage",
  description:
    "Who can work a given shift, ranked, with the reason each person is eligible " +
    "or excluded. This is the ONLY source of eligibility — never decide yourself " +
    "whether someone can work.",
  schema: z.object({
    shiftId: z.string().uuid(),
    limit: z.number().int().min(1).max(20).optional().describe("defaults to 5"),
    includeIneligible: z
      .boolean()
      .optional()
      .describe("also return excluded people and why; use when asked 'why not X'"),
  }),
  handler: async (input, ctx) => {
    const { data: shift } = await ctx.auth.supabase
      .from("shifts")
      .select(
        "id, company_id, date, start_time, end_time, required_role, required_qualification"
      )
      .eq("company_id", ctx.companyId)
      .eq("id", input.shiftId)
      .maybeSingle();
    if (!shift) return { found: false as const };

    const shiftRow = shift as unknown as ShiftRow;
    const inputs = await loadCandidateInputsForShift(ctx.auth.supabase, shiftRow);
    const ranked = rankCandidates(inputs, toShiftContext(shiftRow));

    const eligible = ranked
      .filter((r) => r.eligible)
      .slice(0, input.limit ?? 5)
      .map((r) => ({
        employeeId: r.employeeId,
        employeeNo: r.employeeNo,
        name: r.fullName,
        score: r.score,
        eligible: true as const,
      }));

    const excluded = input.includeIneligible
      ? ranked
          .filter((r) => !r.eligible)
          .slice(0, 20)
          .map((r) => ({
            employeeId: r.employeeId,
            name: r.fullName,
            eligible: false as const,
            reasons: r.reasons as IneligibleReason[],
          }))
      : undefined;

    return {
      found: true as const,
      shiftId: shiftRow.id,
      eligibleCount: ranked.filter((r) => r.eligible).length,
      candidates: eligible,
      ...(excluded ? { excluded } : {}),
    };
  },
});

const listEmployees = defineTool({
  name: "list_employees",
  kind: "read",
  permission: "employees.read",
  description:
    "Search the workforce by name, employment status or qualification. Returns " +
    "operational fields only — never pay, never contract terms.",
  schema: z.object({
    query: z.string().trim().max(120).optional().describe("name or employee number"),
    status: z
      .enum(["active", "probation", "on_leave", "terminated"])
      .optional(),
    qualification: z.string().trim().max(120).optional(),
  }),
  handler: async (input, ctx) => {
    let query = ctx.auth.supabase
      .from("employees")
      .select("id, employee_no, full_name, position, employment_status, departments(name), locations(name)")
      .eq("company_id", ctx.companyId)
      .order("employee_no")
      .limit(PAGE);
    if (input.status) query = query.eq("employment_status", input.status);
    if (input.query) {
      query = query.or(`full_name.ilike.%${input.query}%,employee_no.ilike.%${input.query}%`);
    }
    const { data } = await query;

    let rows = (data ?? []) as unknown as Array<{
      id: string;
      employee_no: string;
      full_name: string;
      position: string | null;
      employment_status: string;
      departments: { name: string } | null;
      locations: { name: string } | null;
    }>;

    if (input.qualification && rows.length > 0) {
      const { data: quals } = await ctx.auth.supabase
        .from("employee_qualifications")
        .select("employee_id, name, status")
        .eq("company_id", ctx.companyId)
        .in("employee_id", rows.map((r) => r.id))
        .ilike("name", `%${input.qualification}%`)
        .limit(PAGE * 10);
      const holders = new Set(
        ((quals ?? []) as Array<{ employee_id: string; status: string }>)
          .filter((q) => q.status === "valid")
          .map((q) => q.employee_id)
      );
      rows = rows.filter((r) => holders.has(r.id));
    }

    return {
      count: rows.length,
      employees: rows.map((r) => ({
        employeeId: r.id,
        employeeNo: r.employee_no,
        name: r.full_name,
        position: r.position,
        employmentStatus: r.employment_status,
        department: r.departments?.name ?? null,
        site: r.locations?.name ?? null,
      })),
    };
  },
});

const getAbsences = defineTool({
  name: "get_absences",
  kind: "read",
  permission: "employees.read",
  description:
    "Approved holiday and open sick leave overlapping a date range. Use for " +
    "'who is on vacation' and 'who is off next week'.",
  schema: z.object({ from: isoDate, to: isoDate }),
  handler: async (input, ctx) => {
    const [{ data: vacation }, { data: sick }] = await Promise.all([
      ctx.auth.supabase
        .from("vacation_requests")
        .select("start_date, end_date, status, employees(full_name)")
        .eq("company_id", ctx.companyId)
        .eq("status", "approved")
        .lte("start_date", input.to)
        .gte("end_date", input.from)
        .limit(PAGE),
      ctx.auth.supabase
        .from("sick_leaves")
        .select("start_date, expected_end_date, status, employees(full_name)")
        .eq("company_id", ctx.companyId)
        .in("status", ["reported", "confirmed"])
        .lte("start_date", input.to)
        .limit(PAGE),
    ]);

    return {
      range: { from: input.from, to: input.to },
      vacation: ((vacation ?? []) as unknown as Array<{
        start_date: string;
        end_date: string;
        employees: { full_name: string } | null;
      }>).map((v) => ({
        name: v.employees?.full_name ?? "—",
        from: v.start_date,
        to: v.end_date,
      })),
      sickLeave: ((sick ?? []) as unknown as Array<{
        start_date: string;
        expected_end_date: string | null;
        status: string;
        employees: { full_name: string } | null;
      }>).map((s) => ({
        name: s.employees?.full_name ?? "—",
        from: s.start_date,
        expectedUntil: s.expected_end_date,
        status: s.status,
      })),
    };
  },
});

const getTodayOperations = defineTool({
  name: "get_today_operations",
  kind: "read",
  permission: "employees.read",
  description:
    "Live picture of the current day: who is on duty, late, missing, and how " +
    "many clock-ins were outside the site. Use for 'how is today going' and " +
    "'how many people are late right now'.",
  schema: z.object({}),
  handler: async (_input, ctx) => {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const { data: company } = await ctx.auth.supabase
      .from("companies")
      .select("settings")
      .eq("id", ctx.companyId)
      .maybeSingle();
    const thresholds = attendanceThresholds(
      (company?.settings as Record<string, unknown>) ?? {}
    );

    const { data: assignments } = await ctx.auth.supabase
      .from("shift_assignments")
      .select(
        "id, employee_id, status, shifts!inner(start_time, end_time, jobs(client_name, locations(name))), employees(full_name)"
      )
      .eq("company_id", ctx.companyId)
      .in("status", ["assigned", "accepted", "cancellation_requested", "completed"])
      .gte("shifts.start_time", dayStart.toISOString())
      .lt("shifts.start_time", dayEnd.toISOString())
      .limit(200);

    const rows = (assignments ?? []) as unknown as Array<{
      id: string;
      employee_id: string;
      status: string;
      shifts: {
        start_time: string;
        end_time: string;
        jobs: { client_name: string; locations: { name: string } | null } | null;
      } | null;
      employees: { full_name: string } | null;
    }>;

    const { data: entries } = rows.length
      ? await ctx.auth.supabase
          .from("time_entries")
          .select("shift_assignment_id, clock_in, clock_out, clock_in_location_status")
          .eq("company_id", ctx.companyId)
          .in("shift_assignment_id", rows.map((r) => r.id))
          .limit(400)
      : { data: [] };

    const entryBy = new Map(
      ((entries ?? []) as Array<{
        shift_assignment_id: string | null;
        clock_in: string;
        clock_out: string | null;
        clock_in_location_status: string | null;
      }>)
        .filter((e) => e.shift_assignment_id)
        .map((e) => [e.shift_assignment_id as string, e])
    );

    const evaluated = rows
      .filter((r) => r.shifts)
      .map((r) => {
        const entry = entryBy.get(r.id);
        const status = attendanceStatus(
          {
            assignmentId: r.id,
            employeeId: r.employee_id,
            assignmentStatus: r.status,
            scheduledStart: new Date(r.shifts!.start_time),
            scheduledEnd: new Date(r.shifts!.end_time),
            clockIn: entry ? new Date(entry.clock_in) : null,
            clockOut: entry?.clock_out ? new Date(entry.clock_out) : null,
            clockInLocationStatus: entry?.clock_in_location_status ?? null,
          },
          thresholds,
          now
        );
        return {
          name: r.employees?.full_name ?? "—",
          site: r.shifts!.jobs?.locations?.name ?? r.shifts!.jobs?.client_name ?? "—",
          status,
        };
      });

    const kpis = summarize(evaluated.map((e) => e.status));

    return {
      date: today(),
      totals: kpis,
      // Only the people who need a decision are named; the rest are a count.
      needsAttention: evaluated.filter(
        (e) => e.status === "late" || e.status === "no_show" || e.status === "outside_geofence"
      ),
    };
  },
});

const getCompanyLocations = defineTool({
  name: "get_company_locations",
  kind: "read",
  permission: "employees.read",
  description:
    "Sites this company operates, with the jobs booked at each. Call this to " +
    "turn a site name a manager typed into the job a shift can be created under.",
  schema: z.object({}),
  handler: async (_input, ctx) => {
    const [{ data: locations }, { data: jobs }] = await Promise.all([
      ctx.auth.supabase
        .from("locations")
        .select("id, name, address")
        .eq("company_id", ctx.companyId)
        .order("name")
        .limit(PAGE),
      ctx.auth.supabase
        .from("jobs")
        .select("id, client_name, location_id, status")
        .eq("company_id", ctx.companyId)
        .in("status", ["open", "partially_staffed", "fully_staffed"])
        .limit(PAGE),
    ]);

    const jobRows = (jobs ?? []) as Array<{
      id: string;
      client_name: string;
      location_id: string | null;
      status: string;
    }>;

    return {
      locations: ((locations ?? []) as Array<{ id: string; name: string; address: string | null }>).map(
        (l) => ({
          locationId: l.id,
          name: l.name,
          address: l.address,
          jobs: jobRows
            .filter((j) => j.location_id === l.id)
            .map((j) => ({ jobId: j.id, client: j.client_name })),
        })
      ),
      jobsWithoutLocation: jobRows
        .filter((j) => !j.location_id)
        .map((j) => ({ jobId: j.id, client: j.client_name })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* Self-scoped tools — available to every member, about themselves     */
/* ------------------------------------------------------------------ */

const getMyNextShift = defineTool({
  name: "get_my_next_shift",
  kind: "read",
  description:
    "The signed-in person's own next shift. Takes no arguments: the employee is " +
    "resolved from the session, never from an argument.",
  schema: z.object({}),
  handler: async (_input, ctx) => {
    if (!ctx.employeeId) return { hasEmployeeRecord: false as const };
    const { data } = await ctx.auth.supabase
      .from("shift_assignments")
      .select("status, shifts!inner(start_time, end_time, jobs(client_name, locations(name)))")
      .eq("employee_id", ctx.employeeId)
      .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES])
      .gte("shifts.end_time", new Date().toISOString())
      .order("start_time", { referencedTable: "shifts", ascending: true })
      .limit(1);

    const row = ((data ?? []) as unknown as Array<{
      status: string;
      shifts: {
        start_time: string;
        end_time: string;
        jobs: { client_name: string; locations: { name: string } | null } | null;
      } | null;
    }>)[0];
    if (!row?.shifts) return { hasEmployeeRecord: true as const, nextShift: null };

    return {
      hasEmployeeRecord: true as const,
      nextShift: {
        startTime: row.shifts.start_time,
        endTime: row.shifts.end_time,
        site: row.shifts.jobs?.locations?.name ?? row.shifts.jobs?.client_name ?? "—",
        assignmentStatus: row.status,
      },
    };
  },
});

const getMyTimeSummary = defineTool({
  name: "get_my_time_summary",
  kind: "read",
  description:
    "Hours the signed-in person recorded in a date range. Resolved from the " +
    "session; it cannot report on anybody else.",
  schema: z.object({ from: isoDate, to: isoDate }),
  handler: async (input, ctx) => {
    if (!ctx.employeeId) return { hasEmployeeRecord: false as const };
    const { data } = await ctx.auth.supabase
      .from("time_entries")
      .select("clock_in, clock_out")
      .eq("employee_id", ctx.employeeId)
      .gte("clock_in", `${input.from}T00:00:00Z`)
      .lte("clock_in", `${input.to}T23:59:59Z`)
      .limit(200);

    const rows = (data ?? []) as Array<{ clock_in: string; clock_out: string | null }>;
    const minutes = rows
      .filter((r) => r.clock_out)
      .reduce(
        (sum, r) =>
          sum + (new Date(r.clock_out!).getTime() - new Date(r.clock_in).getTime()) / 60_000,
        0
      );

    return {
      hasEmployeeRecord: true as const,
      range: { from: input.from, to: input.to },
      completedEntries: rows.filter((r) => r.clock_out).length,
      openEntries: rows.filter((r) => !r.clock_out).length,
      totalMinutes: Math.round(minutes),
    };
  },
});

export const READ_TOOLS: readonly AiTool[] = [
  getTodayOperations,
  listShifts,
  listUnderstaffedShifts,
  getShiftDetails,
  findReplacementCandidates,
  listEmployees,
  getAbsences,
  getCompanyLocations,
  getMyNextShift,
  getMyTimeSummary,
];

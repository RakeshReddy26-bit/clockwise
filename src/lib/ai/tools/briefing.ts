import "server-only";

import { z } from "zod";
import { defineTool, type AiTool } from "@/lib/ai/tools/registry";
import { operatingDate, addDays } from "@/lib/ai/dates";
import { OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/eligibility";
import { shiftAttention } from "@/lib/shift-attention";
import { attendanceThresholds, attendanceStatus, summarize } from "@/lib/attendance";
import { buildAttentionItems, type BoardShift, type PendingRequest } from "@/lib/live-ops";

/**
 * "Summarise today" in one tool call.
 *
 * A briefing built from five separate tool calls costs five round trips and
 * gives the model five chances to add up the numbers itself. This assembles the
 * whole picture server-side using the same engines the dashboard uses —
 * `attendanceStatus`, `summarize`, `shiftAttention`, `buildAttentionItems` — so
 * the assistant's briefing and the board cannot disagree.
 *
 * Every figure is counted from rows. Nothing is estimated, and a metric that
 * cannot be derived from the schema is simply absent rather than guessed: an
 * omitted number is a gap, an invented one is a lie a manager may act on.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

type AssignmentRow = {
  id: string;
  employee_id: string;
  status: string;
  shifts: {
    id: string;
    start_time: string;
    end_time: string;
    required_count: number;
    required_role: string | null;
    jobs: { client_name: string; locations: { name: string } | null } | null;
  } | null;
  employees: { full_name: string } | null;
};

export const getOperationsBriefing: AiTool = defineTool({
  name: "get_operations_briefing",
  kind: "read",
  permission: "employees.read",
  description:
    "The whole operational picture for one day in a single call: scheduled " +
    "headcount, who is on duty, late or missing, understaffed shifts, waiting " +
    "manual clock-in requests, and what already resolved. Use this for " +
    "'summarise today', 'morning briefing', 'what should I worry about' and " +
    "'what needs attention'. Prefer it over several narrower calls.",
  schema: z.object({
    date: isoDate.optional().describe("calendar date; defaults to today"),
  }),
  handler: async (input, ctx) => {
    const date = input.date ?? operatingDate(new Date());
    const now = new Date();
    // A calendar day in the operating zone, expressed as an instant window.
    const dayStart = new Date(`${date}T00:00:00Z`);
    const dayEnd = new Date(`${addDays(date, 1)}T00:00:00Z`);
    const isToday = date === operatingDate(now);

    const [{ data: company }, { data: assignments }, { data: requests }, { data: alerts }] =
      await Promise.all([
        ctx.auth.supabase
          .from("companies")
          .select("settings")
          .eq("id", ctx.companyId)
          .maybeSingle(),
        ctx.auth.supabase
          .from("shift_assignments")
          .select(
            "id, employee_id, status, shifts!inner(id, start_time, end_time, required_count, required_role, jobs(client_name, locations(name))), employees(full_name)"
          )
          .eq("company_id", ctx.companyId)
          .in("status", ["assigned", "accepted", "cancellation_requested", "completed"])
          .gte("shifts.start_time", dayStart.toISOString())
          .lt("shifts.start_time", dayEnd.toISOString())
          .limit(300),
        ctx.auth.supabase
          .from("manual_clockin_requests")
          .select("id, created_at, employees(full_name)")
          .eq("company_id", ctx.companyId)
          .eq("status", "pending")
          .limit(25),
        ctx.auth.supabase
          .from("attendance_alerts")
          .select("id, type, status, employees(full_name)")
          .eq("company_id", ctx.companyId)
          .gte("created_at", dayStart.toISOString())
          .limit(50),
      ]);

    const rows = (assignments ?? []) as unknown as AssignmentRow[];
    const thresholds = attendanceThresholds(
      (company?.settings as Record<string, unknown>) ?? {}
    );

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

    const siteOf = (row: AssignmentRow) =>
      row.shifts?.jobs?.locations?.name ?? row.shifts?.jobs?.client_name ?? "—";

    const people = rows
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
          assignmentId: r.id,
          employeeName: r.employees?.full_name ?? "—",
          siteName: siteOf(r),
          shiftId: r.shifts!.id,
          status,
          minutesLate: null as number | null,
          distanceM: null as number | null,
        };
      });

    // Fold per-person rows up into per-shift staffing, the same way the board
    // does, so "understaffed" means one thing across the product.
    const shiftMeta = new Map<string, { siteName: string; required: number; startsAt: Date; role: string | null }>();
    const filledBy = new Map<string, number>();
    for (const row of rows) {
      if (!row.shifts) continue;
      shiftMeta.set(row.shifts.id, {
        siteName: siteOf(row),
        required: row.shifts.required_count,
        startsAt: new Date(row.shifts.start_time),
        role: row.shifts.required_role,
      });
      if ((OCCUPYING_ASSIGNMENT_STATUSES as readonly string[]).includes(row.status)) {
        filledBy.set(row.shifts.id, (filledBy.get(row.shifts.id) ?? 0) + 1);
      }
    }

    const boardShifts: BoardShift[] = [...shiftMeta.entries()].map(([shiftId, meta]) => {
      const filled = filledBy.get(shiftId) ?? 0;
      const verdict = shiftAttention({
        filled,
        requiredCount: meta.required,
        hasOpenOffer: false,
      });
      return {
        shiftId,
        siteName: meta.siteName,
        required: meta.required,
        filled,
        openSeats: verdict.openSeats,
        startsAt: meta.startsAt,
      };
    });

    const pending: PendingRequest[] = (
      (requests ?? []) as unknown as Array<{
        id: string;
        created_at: string;
        employees: { full_name: string } | null;
      }>
    ).map((r) => ({
      requestId: r.id,
      employeeName: r.employees?.full_name ?? "—",
      siteName: "—",
      shiftId: null,
      createdAt: new Date(r.created_at),
    }));

    const kpis = summarize(people.map((p) => p.status));
    const attention = buildAttentionItems(
      { people, shifts: boardShifts, requests: pending, now },
      8
    );

    const alertRows = (alerts ?? []) as unknown as Array<{
      type: string;
      status: string;
      employees: { full_name: string } | null;
    }>;

    return {
      date,
      isToday,
      totals: {
        shiftsScheduled: shiftMeta.size,
        peopleAssigned: kpis.scheduled,
        onDuty: kpis.onDuty,
        late: kpis.late,
        noShow: kpis.noShow,
        outsideSite: kpis.outsideSite,
        clockedOut: kpis.clockedOut,
        stillToStart: kpis.upcoming,
        openSeats: boardShifts.reduce((sum, s) => sum + s.openSeats, 0),
        pendingManualRequests: pending.length,
      },
      // Already ranked. The model should present these in the order given.
      needsAttention: attention.items.map((item) => ({
        kind: item.kind,
        site: item.siteName,
        shiftId: item.shiftId,
        ...("employeeName" in item ? { employee: item.employeeName } : {}),
        ...("openSeats" in item ? { openSeats: item.openSeats, filled: item.filled, required: item.required } : {}),
        ...("minutesLate" in item ? { minutesLate: item.minutesLate } : {}),
        ...("waitingMinutes" in item ? { waitingMinutes: item.waitingMinutes } : {}),
        ...("distanceM" in item ? { metresOutside: item.distanceM } : {}),
      })),
      attentionTotal: attention.total,
      /** Alerts a manager already closed — the "resolved" half of a briefing. */
      resolvedAlerts: alertRows
        .filter((a) => a.status === "resolved")
        .map((a) => ({ type: a.type, employee: a.employees?.full_name ?? "—" })),
      openAlerts: alertRows.filter((a) => a.status === "open").length,
      fullyStaffedShifts: boardShifts.filter((s) => s.openSeats === 0).length,
    };
  },
});

export const BRIEFING_TOOLS: readonly AiTool[] = [getOperationsBriefing];

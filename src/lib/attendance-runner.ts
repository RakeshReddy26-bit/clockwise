import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  attendanceThresholds,
  evaluateAlerts,
  formatMinutes,
  type AlertDecision,
  type AssignmentSnapshot,
} from "@/lib/attendance";

/**
 * Attendance evaluation runner.
 *
 * Idempotent and side-effect-safe: it upserts alerts on the unique
 * (shift_assignment_id, type) key and only sends a notification the first
 * time a given alert row is created. Running it every minute, once an hour,
 * or twice concurrently produces the same database state.
 *
 * Invocation is deliberately decoupled from the UI — the same function backs
 * the /api/cron/attendance route (Railway cron) and any manual trigger.
 * Managers opening /app never cause alert creation.
 */

const ALERT_ROLES = ["COMPANY_ADMIN", "DISPATCHER", "HR_MANAGER"] as const;
const NOTIFY_ROLES: Record<AlertDecision["type"], readonly string[]> = {
  late_clock_in: ["COMPANY_ADMIN", "DISPATCHER"],
  no_show: ALERT_ROLES,
  early_clock_out: ["COMPANY_ADMIN", "DISPATCHER"],
};

/** Window of shifts worth evaluating: yesterday through the next few hours. */
const LOOKBACK_HOURS = 24;
const LOOKAHEAD_HOURS = 2;

export type EvaluationResult = {
  companiesEvaluated: number;
  assignmentsEvaluated: number;
  alertsCreated: number;
  alertsExisting: number;
  notificationsSent: number;
};

type AssignmentRow = {
  id: string;
  company_id: string;
  employee_id: string;
  status: string;
  shifts: { start_time: string; end_time: string } | null;
  employees: { full_name: string } | null;
};

type EntryRow = {
  id: string;
  shift_assignment_id: string | null;
  clock_in: string;
  clock_out: string | null;
  clock_in_location_status: string | null;
};

/**
 * Evaluate attendance for one company (or every company when omitted).
 * `now` is injectable so tests and backfills are deterministic.
 */
export async function evaluateAttendance(
  db: SupabaseClient,
  options: { companyId?: string; now?: Date } = {}
): Promise<EvaluationResult> {
  const now = options.now ?? new Date();
  const result: EvaluationResult = {
    companiesEvaluated: 0,
    assignmentsEvaluated: 0,
    alertsCreated: 0,
    alertsExisting: 0,
    notificationsSent: 0,
  };

  let companyQuery = db.from("companies").select("id, settings");
  if (options.companyId) companyQuery = companyQuery.eq("id", options.companyId);
  const { data: companies, error: companyError } = await companyQuery;
  if (companyError) throw new Error(`companies: ${companyError.message}`);

  for (const company of companies ?? []) {
    result.companiesEvaluated++;
    const thresholds = attendanceThresholds(
      (company.settings ?? null) as Record<string, unknown> | null
    );

    const windowStart = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000).toISOString();
    const windowEnd = new Date(now.getTime() + LOOKAHEAD_HOURS * 3_600_000).toISOString();

    const { data: assignments, error: assignmentError } = await db
      .from("shift_assignments")
      .select(
        "id, company_id, employee_id, status, shifts!inner(start_time, end_time), employees(full_name)"
      )
      .eq("company_id", company.id)
      // 'cancellation_requested' is loaded on purpose: asking to be released is
      // not being released. The employee still holds the seat and is still
      // expected, so late and no-show detection must keep running for them
      // until a manager approves. isInactiveAssignment() filters the rest.
      .in("status", ["assigned", "accepted", "cancellation_requested", "completed"])
      .gte("shifts.start_time", windowStart)
      .lte("shifts.start_time", windowEnd);
    if (assignmentError) throw new Error(`assignments: ${assignmentError.message}`);

    const rows = (assignments ?? []) as unknown as AssignmentRow[];
    if (rows.length === 0) continue;

    const { data: entries } = await db
      .from("time_entries")
      .select("id, shift_assignment_id, clock_in, clock_out, clock_in_location_status")
      .eq("company_id", company.id)
      .in(
        "shift_assignment_id",
        rows.map((r) => r.id)
      );

    const entryByAssignment = new Map<string, EntryRow>();
    for (const e of (entries ?? []) as unknown as EntryRow[]) {
      if (e.shift_assignment_id) entryByAssignment.set(e.shift_assignment_id, e);
    }

    for (const row of rows) {
      if (!row.shifts) continue;
      result.assignmentsEvaluated++;
      const entry = entryByAssignment.get(row.id) ?? null;

      const snapshot: AssignmentSnapshot = {
        assignmentId: row.id,
        employeeId: row.employee_id,
        assignmentStatus: row.status,
        scheduledStart: new Date(row.shifts.start_time),
        scheduledEnd: new Date(row.shifts.end_time),
        clockIn: entry ? new Date(entry.clock_in) : null,
        clockOut: entry?.clock_out ? new Date(entry.clock_out) : null,
        clockInLocationStatus: entry?.clock_in_location_status ?? null,
      };

      for (const decision of evaluateAlerts(snapshot, thresholds, now)) {
        // Insert-if-absent: the unique key makes repeat runs no-ops.
        const { data: inserted, error } = await db
          .from("attendance_alerts")
          .upsert(
            {
              company_id: company.id,
              employee_id: row.employee_id,
              shift_assignment_id: row.id,
              time_entry_id: entry?.id ?? null,
              type: decision.type,
              minutes_delta: decision.minutesDelta,
              scheduled_start: row.shifts.start_time,
              scheduled_end: row.shifts.end_time,
            },
            { onConflict: "shift_assignment_id,type", ignoreDuplicates: true }
          )
          .select("id");

        if (error) {
          console.error("attendance alert upsert failed:", error.message);
          continue;
        }
        if (!inserted || inserted.length === 0) {
          result.alertsExisting++;
          continue; // already alerted — no duplicate notification
        }

        result.alertsCreated++;
        result.notificationsSent += await notifyManagers(db, company.id, decision, {
          employeeName: row.employees?.full_name ?? null,
          assignmentId: row.id,
          scheduledStart: row.shifts.start_time,
          scheduledEnd: row.shifts.end_time,
        });
      }
    }
  }

  return result;
}

async function notifyManagers(
  db: SupabaseClient,
  companyId: string,
  decision: AlertDecision,
  context: {
    employeeName: string | null;
    assignmentId: string;
    scheduledStart: string;
    scheduledEnd: string;
  }
): Promise<number> {
  const { data: staff } = await db
    .from("company_memberships")
    .select("profile_id, role")
    .eq("company_id", companyId)
    .eq("status", "active")
    .in("role", [...NOTIFY_ROLES[decision.type]]);
  if (!staff?.length) return 0;

  const { error } = await db.from("notifications").insert(
    staff.map((s) => ({
      company_id: companyId,
      profile_id: s.profile_id,
      type: decision.type,
      payload: {
        shift_assignment_id: context.assignmentId,
        employee_name: context.employeeName,
        minutes_delta: decision.minutesDelta,
        minutes_label: formatMinutes(decision.minutesDelta),
        scheduled_start: context.scheduledStart,
        scheduled_end: context.scheduledEnd,
      },
    }))
  );
  if (error) {
    console.error("attendance notification insert failed:", error.message);
    return 0;
  }
  return staff.length;
}

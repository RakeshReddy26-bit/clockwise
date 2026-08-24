"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireContext, AuthzError, type AuthContext } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { validatedAction, uuid, isoDate } from "@/lib/validation";
import {
  classifyVacationRequest,
  classifyVacationWithdrawal,
  daysBetweenInclusive,
  type RequestRefusal,
} from "@/lib/absence";

/**
 * The employee's own absence actions: ask for holiday, withdraw that ask,
 * report sickness.
 *
 * The asymmetry from src/lib/absence.ts is visible here and is the point:
 *
 *   requestVacation() can be refused — for a reversed range, a date in the
 *   past, or days already covered by a live request.
 *
 *   reportSickLeave() cannot be refused for holding a shift. It writes the row
 *   and then TELLS the managers what it collides with. Nobody is released
 *   automatically; a human decides, through the Phase C.1 removal.
 */

const ABSENCE_ROLES = ["COMPANY_ADMIN", "HR_MANAGER"] as const;

async function resolveEmployee(ctx: AuthContext) {
  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("id, full_name")
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();
  if (!employee) throw new AuthzError("forbidden", "no employee record");
  return employee as { id: string; full_name: string };
}

/**
 * Absence notifications go to the people who decide them — COMPANY_ADMIN and
 * HR_MANAGER. Dispatch is deliberately not on this list: they cannot act on it,
 * and the conflict they DO need to know about reaches them through the shift.
 */
async function notifyDeciders(
  companyId: string,
  type: string,
  payload: Record<string, unknown>
) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("notifyDeciders skipped: SUPABASE_SERVICE_ROLE_KEY not set");
    return;
  }
  try {
    const admin = createAdminClient();
    const { data: staff } = await admin
      .from("company_memberships")
      .select("profile_id")
      .eq("company_id", companyId)
      .eq("status", "active")
      .in("role", [...ABSENCE_ROLES]);
    if (!staff?.length) return;
    await admin.from("notifications").insert(
      staff.map((s) => ({ company_id: companyId, profile_id: s.profile_id, type, payload }))
    );
  } catch (e) {
    console.error("notifyDeciders failed:", e);
  }
}

/** The employee's live assignments inside a date range, for conflict reporting. */
async function assignmentsInRange(
  ctx: AuthContext,
  employeeId: string,
  start: string,
  end: string | null
) {
  let query = ctx.supabase
    .from("shift_assignments")
    .select("id, shift_id, status, shifts!inner(date, start_time)")
    .eq("company_id", ctx.membership.company_id)
    .eq("employee_id", employeeId)
    .in("status", ["assigned", "accepted", "cancellation_requested"])
    .gte("shifts.date", start);
  if (end) query = query.lte("shifts.date", end);

  const { data } = await query;
  return (data ?? []) as unknown as Array<{
    id: string;
    shift_id: string;
    status: string;
    shifts: { date: string; start_time: string } | null;
  }>;
}

/* ------------------------------------------------------------------------- */
/* Vacation                                                                   */
/* ------------------------------------------------------------------------- */

export type RequestVacationOutcome =
  | { kind: "submitted"; requestId: string; days: number }
  | { kind: "refused"; reason: RequestRefusal };

export const requestVacation = validatedAction(
  z.object({
    startDate: isoDate,
    endDate: isoDate,
    note: z.string().trim().max(500).optional(),
  }),
  async (input): Promise<RequestVacationOutcome> => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);

    // Every live request of this employee's, so the overlap rule is decided
    // against fresh rows rather than against whatever the page was showing.
    const { data: existing } = await ctx.supabase
      .from("vacation_requests")
      .select("start_date, end_date, status")
      .eq("company_id", ctx.membership.company_id)
      .eq("employee_id", employee.id)
      .in("status", ["pending", "approved"]);

    const verdict = classifyVacationRequest({
      start: input.startDate,
      end: input.endDate,
      today: new Date().toISOString().slice(0, 10),
      existing: (existing ?? []).map((row) => ({
        start: row.start_date as string,
        end: row.end_date as string,
        status: row.status as string,
      })),
    });
    if (verdict.kind === "refused") return verdict;

    const days = daysBetweenInclusive(input.startDate, input.endDate);

    const { data: created, error } = await ctx.supabase
      .from("vacation_requests")
      .insert({
        company_id: ctx.membership.company_id,
        employee_id: employee.id,
        start_date: input.startDate,
        end_date: input.endDate,
        days_count: days,
        note: input.note ?? null,
        status: "pending",
      })
      .select("id")
      .single();

    if (error || !created) {
      // vacation_requests_no_overlap (0015) is the authority; the check above
      // only makes the ordinary case a sentence instead of an exception.
      if (error?.message?.includes("vacation_requests_no_overlap")) {
        return { kind: "refused", reason: "overlaps_existing" };
      }
      throw new Error(`vacation request failed: ${error?.message}`);
    }

    await notifyDeciders(ctx.membership.company_id, "vacation_requested", {
      request_id: created.id,
      employee_id: employee.id,
      employee_name: employee.full_name,
      start_date: input.startDate,
      end_date: input.endDate,
      days_count: days,
    });

    revalidatePath("/me/absences");
    revalidatePath("/app/absences");
    return { kind: "submitted", requestId: created.id, days };
  }
);

export type WithdrawVacationOutcome =
  | { kind: "withdrawn" }
  | { kind: "refused"; reason: "not_pending" };

/**
 * Withdraw a request nobody has decided yet.
 *
 * A plain UPDATE rather than an RPC: vacation_self_withdraw (0015) already
 * expresses the whole rule — own row, still pending, and only ever to
 * 'cancelled'. Wrapping that in a function would add a second place for it to
 * be wrong. RLS filters rather than raises, so zero rows updated IS the
 * refusal.
 */
export const withdrawVacation = validatedAction(
  z.object({ requestId: uuid }),
  async (input): Promise<WithdrawVacationOutcome> => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);

    const { data: request } = await ctx.supabase
      .from("vacation_requests")
      .select("id, company_id, employee_id, status")
      .eq("id", input.requestId)
      .maybeSingle();
    if (
      !request ||
      request.company_id !== ctx.membership.company_id ||
      request.employee_id !== employee.id
    ) {
      throw new AuthzError("wrong_tenant", "request not accessible");
    }

    const verdict = classifyVacationWithdrawal(request.status);
    if (verdict.kind === "refused") return verdict;

    const { data: updated, error } = await ctx.supabase
      .from("vacation_requests")
      .update({ status: "cancelled" })
      .eq("id", request.id)
      .select("id");
    if (error) throw new Error(`withdrawal failed: ${error.message}`);
    if (!updated?.length) return { kind: "refused", reason: "not_pending" };

    revalidatePath("/me/absences");
    revalidatePath("/app/absences");
    return { kind: "withdrawn" };
  }
);

/* ------------------------------------------------------------------------- */
/* Sick leave                                                                 */
/* ------------------------------------------------------------------------- */

export type ReportSickOutcome = {
  kind: "reported";
  sickLeaveId: string;
  /** Shifts the report collides with. Surfaced, never acted on. */
  conflicts: number;
};

/**
 * Report sickness. This has no refusal path by design.
 *
 * An existing assignment inside the period does not stop the report and does
 * not end the assignment. It is counted, returned so the employee knows their
 * manager has been told, and sent to the deciders — who release the person
 * through remove_shift_assignment() if they choose to.
 */
export const reportSickLeave = validatedAction(
  z.object({
    startDate: isoDate,
    expectedEndDate: isoDate.optional(),
    comment: z.string().trim().max(500).optional(),
  }),
  async (input): Promise<ReportSickOutcome> => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);

    const { data: created, error } = await ctx.supabase
      .from("sick_leaves")
      .insert({
        company_id: ctx.membership.company_id,
        employee_id: employee.id,
        start_date: input.startDate,
        expected_end_date: input.expectedEndDate ?? null,
        comment: input.comment ?? null,
        status: "reported",
      })
      .select("id")
      .single();
    if (error || !created) throw new Error(`sick report failed: ${error?.message}`);

    const conflicts = await assignmentsInRange(
      ctx,
      employee.id,
      input.startDate,
      input.expectedEndDate ?? null
    );

    await notifyDeciders(ctx.membership.company_id, "sick_reported", {
      sick_leave_id: created.id,
      employee_id: employee.id,
      employee_name: employee.full_name,
      start_date: input.startDate,
      expected_end_date: input.expectedEndDate ?? null,
      // The count only. Why someone is ill is not staff-wide information.
      conflicting_assignments: conflicts.length,
      conflicting_shift_ids: conflicts.map((c) => c.shift_id),
    });

    revalidatePath("/me/absences");
    revalidatePath("/me/shifts");
    revalidatePath("/app/absences");
    return { kind: "reported", sickLeaveId: created.id, conflicts: conflicts.length };
  }
);

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, AuthzError, type AuthContext } from "@/lib/authz";
import { validatedAction, uuid, isoDate } from "@/lib/validation";
import { classifyVacationDecision, classifySickTransition } from "@/lib/absence";

/**
 * Absence decisions.
 *
 * Both actions require `absence.decide` — COMPANY_ADMIN and HR_MANAGER, not
 * DISPATCHER. That is checked here, again by app.can_decide_absence() inside
 * the SQL function, and a third time by the table policies, so a dispatcher who
 * skips this layer entirely still changes nothing.
 *
 * Neither action ever releases an employee from a shift. Approving holiday for
 * someone who still holds one is REFUSED and the conflicts are handed back;
 * confirming an illness reports them and changes nothing. Taking someone off a
 * shift is a scheduling act with its own permission, its own reason field and
 * its own notification — remove_shift_assignment() (Phase C.1).
 */

/** Statuses decide_vacation_request() can report. */
export type VacationDecisionStatus =
  | "approved"
  | "rejected"
  | "conflicting_assignments"
  | "not_pending"
  | "forbidden"
  | "not_found";

export type ConflictingAssignment = {
  assignment_id: string;
  shift_id: string;
  date: string;
  status: string;
};

export type DecideVacationOutcome =
  | { kind: "decided"; status: "approved" | "rejected"; employeeName: string }
  | { kind: "conflicts"; conflicts: ConflictingAssignment[]; employeeName: string }
  | { kind: "refused"; status: VacationDecisionStatus };

async function loadRequest(ctx: AuthContext, requestId: string) {
  const { data: request } = await ctx.supabase
    .from("vacation_requests")
    .select("id, company_id, status, employee_id, employees(full_name)")
    .eq("id", requestId)
    .maybeSingle();
  if (!request || request.company_id !== ctx.membership.company_id) {
    throw new AuthzError("wrong_tenant", "vacation request not accessible");
  }
  const employee = request.employees as unknown as { full_name: string } | null;
  return { request, employeeName: employee?.full_name ?? "" };
}

export const decideVacationRequest = validatedAction(
  z.object({
    requestId: uuid,
    approve: z.boolean(),
    note: z.string().trim().max(500).optional(),
  }),
  async (input): Promise<DecideVacationOutcome> => {
    const ctx = await requirePermission("absence.decide");
    const { request, employeeName } = await loadRequest(ctx, input.requestId);

    const verdict = classifyVacationDecision(
      request.status,
      input.approve ? "approve" : "reject"
    );
    if (verdict.kind === "refused") return { kind: "refused", status: "not_pending" };

    const { data, error } = await ctx.supabase.rpc("decide_vacation_request", {
      p_request_id: request.id,
      p_approve: input.approve,
      p_note: input.note ?? null,
    });
    if (error) throw new Error(`vacation decision failed: ${error.message}`);

    const result = data as {
      status: VacationDecisionStatus;
      conflicts?: ConflictingAssignment[];
    };

    if (result.status === "conflicting_assignments") {
      return { kind: "conflicts", conflicts: result.conflicts ?? [], employeeName };
    }
    if (result.status !== "approved" && result.status !== "rejected") {
      return { kind: "refused", status: result.status };
    }

    // The audit row is written inside the transaction by the SQL function, so
    // it cannot exist without the decision and vice versa. Nothing is added
    // here; a second audit write would be a second, unsynchronised truth.
    await notifyEmployee(ctx, request.employee_id, {
      type: result.status === "approved" ? "vacation_approved" : "vacation_rejected",
      payload: { request_id: request.id },
    });

    revalidatePath("/app/absences");
    revalidatePath("/me/absences");
    return { kind: "decided", status: result.status, employeeName };
  }
);

/** Statuses decide_sick_leave() can report. */
export type SickDecisionStatus =
  | "confirmed"
  | "closed"
  | "already_closed"
  | "not_a_transition"
  | "forbidden"
  | "not_found";

export type DecideSickOutcome =
  | { kind: "decided"; status: "confirmed" | "closed"; employeeName: string }
  | { kind: "refused"; status: SickDecisionStatus };

export const decideSickLeave = validatedAction(
  z.object({
    sickLeaveId: uuid,
    status: z.enum(["confirmed", "closed"]),
    endDate: isoDate.optional(),
  }),
  async (input): Promise<DecideSickOutcome> => {
    const ctx = await requirePermission("absence.decide");

    const { data: sick } = await ctx.supabase
      .from("sick_leaves")
      .select("id, company_id, status, employee_id, employees(full_name)")
      .eq("id", input.sickLeaveId)
      .maybeSingle();
    if (!sick || sick.company_id !== ctx.membership.company_id) {
      throw new AuthzError("wrong_tenant", "sick leave not accessible");
    }
    const employeeName =
      (sick.employees as unknown as { full_name: string } | null)?.full_name ?? "";

    const verdict = classifySickTransition(sick.status, input.status);
    if (verdict.kind === "refused") return { kind: "refused", status: verdict.reason };

    const { data, error } = await ctx.supabase.rpc("decide_sick_leave", {
      p_sick_leave_id: sick.id,
      p_status: input.status,
      p_end_date: input.endDate ?? null,
    });
    if (error) throw new Error(`sick leave decision failed: ${error.message}`);

    const result = data as { status: SickDecisionStatus };
    if (result.status !== "confirmed" && result.status !== "closed") {
      return { kind: "refused", status: result.status };
    }

    revalidatePath("/app/absences");
    revalidatePath("/me/absences");
    return { kind: "decided", status: result.status, employeeName };
  }
);

/** One notification to the person the decision is about. */
async function notifyEmployee(
  ctx: AuthContext,
  employeeId: string,
  event: { type: string; payload: Record<string, unknown> }
): Promise<void> {
  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("profile_id")
    .eq("company_id", ctx.membership.company_id)
    .eq("id", employeeId)
    .maybeSingle();
  if (!employee?.profile_id) return;

  const { error } = await ctx.supabase.from("notifications").insert({
    company_id: ctx.membership.company_id,
    profile_id: employee.profile_id,
    type: event.type,
    payload: event.payload,
  });
  if (error) console.error("absence notification failed:", error.message);
}

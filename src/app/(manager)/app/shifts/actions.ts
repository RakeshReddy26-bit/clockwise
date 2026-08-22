"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, AuthzError, type AuthContext } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { validatedAction, uuid } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { loadCandidateInputsForShift, toShiftContext, type ShiftRow } from "@/lib/candidates";
import {
  evaluateCandidate,
  OCCUPYING_ASSIGNMENT_STATUSES,
  type IneligibleReason,
} from "@/lib/eligibility";

/**
 * Send an open-shift offer to selected employees.
 *
 * Eligibility is never taken from the client: the candidate ids are the only
 * client input, and each one is re-evaluated against freshly loaded rows here.
 * A candidate who became ineligible since the page rendered is dropped and
 * reported, not offered.
 */

/** Outcomes the UI turns into a manager-facing message. */
export type SendOfferOutcome =
  | { kind: "sent"; offerId: string; invited: number; alreadyInvited: number }
  | { kind: "shift_not_open" }
  | { kind: "shift_fully_staffed" }
  | { kind: "shift_in_past" }
  | { kind: "no_eligible_selection"; rejected: Array<{ employeeId: string; reason: string }> };

const sendOfferSchema = z.object({
  shiftId: uuid,
  employeeIds: z.array(uuid).min(1).max(50),
  message: z.string().trim().max(500).optional(),
});

export const sendShiftOffer = validatedAction(
  sendOfferSchema,
  async (input): Promise<SendOfferOutcome> => {
    const ctx = await requirePermission("scheduling.manage");
    const companyId = ctx.membership.company_id;

    // ---- Resolve the shift server-side; RLS already scopes it to the tenant.
    const { data: shift } = await ctx.supabase
      .from("shifts")
      .select(
        "id, company_id, date, start_time, end_time, status, required_count, required_role, required_qualification"
      )
      .eq("id", input.shiftId)
      .maybeSingle();
    if (!shift || shift.company_id !== companyId) {
      throw new AuthzError("wrong_tenant", "shift not accessible");
    }

    if (new Date(shift.start_time) <= new Date()) return { kind: "shift_in_past" };
    if (shift.status !== "open" && shift.status !== "staffed") return { kind: "shift_not_open" };

    const { count: occupied } = await ctx.supabase
      .from("shift_assignments")
      .select("id", { count: "exact", head: true })
      .eq("shift_id", shift.id)
      .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES]);
    if ((occupied ?? 0) >= shift.required_count) return { kind: "shift_fully_staffed" };

    // ---- Re-evaluate every selected candidate against fresh data.
    const selected = [...new Set(input.employeeIds)]; // duplicate ids collapse here
    const candidates = await loadCandidateInputsForShift(ctx.supabase, shift as ShiftRow);
    const shiftContext = toShiftContext(shift as ShiftRow);

    const eligible: string[] = [];
    const rejected: Array<{ employeeId: string; reason: string }> = [];
    for (const employeeId of selected) {
      const candidate = candidates.find((c) => c.employeeId === employeeId);
      if (!candidate) {
        // Not in the tenant's candidate set at all — treat as unknown, never offer.
        rejected.push({ employeeId, reason: "wrong_company" });
        continue;
      }
      const verdict = evaluateCandidate(candidate, shiftContext);
      if (verdict.eligible) eligible.push(employeeId);
      else rejected.push({ employeeId, reason: verdict.reasons[0] ?? "not_schedulable" });
    }

    if (eligible.length === 0) return { kind: "no_eligible_selection", rejected };

    // ---- One open offer per shift: reuse it rather than refusing.
    // The partial unique index makes a second open offer impossible, and a
    // dispatcher adding one more person should not have to cancel the first.
    const { data: existingOffer } = await ctx.supabase
      .from("shift_offers")
      .select("id")
      .eq("shift_id", shift.id)
      .eq("status", "open")
      .maybeSingle();

    let offerId: string;
    if (existingOffer) {
      offerId = existingOffer.id;
    } else {
      const { data: created, error } = await ctx.supabase
        .from("shift_offers")
        .insert({
          company_id: companyId,
          shift_id: shift.id,
          created_by: ctx.userId,
          message: input.message ?? null,
        })
        .select("id")
        .single();
      if (error || !created) throw new Error(`offer insert failed: ${error?.message}`);
      offerId = created.id;
    }

    // ---- Invite. unique (offer_id, employee_id) makes a repeat send a no-op,
    // so a double click or browser retry adds nobody twice.
    const { data: invitedRows, error: inviteError } = await ctx.supabase
      .from("shift_offer_responses")
      .upsert(
        eligible.map((employeeId) => ({
          company_id: companyId,
          offer_id: offerId,
          employee_id: employeeId,
          response: "pending" as const,
        })),
        { onConflict: "offer_id,employee_id", ignoreDuplicates: true }
      )
      .select("employee_id");
    if (inviteError) throw new Error(`invite failed: ${inviteError.message}`);

    const newlyInvited = (invitedRows ?? []).map((r) => r.employee_id as string);
    await notifyInvited(ctx, shift.id, offerId, newlyInvited);

    await writeAudit(ctx, {
      action: "shift_offer.sent",
      entity: "shift_offers",
      entityId: offerId,
      diff: { invited: newlyInvited.length, rejected: rejected.length },
    });

    revalidatePath("/app/shifts");
    return {
      kind: "sent",
      offerId,
      invited: newlyInvited.length,
      alreadyInvited: eligible.length - newlyInvited.length,
    };
  }
);

/** One notification per newly invited employee; repeat sends notify nobody. */
async function notifyInvited(
  ctx: Awaited<ReturnType<typeof requirePermission>>,
  shiftId: string,
  offerId: string,
  employeeIds: string[]
): Promise<void> {
  if (employeeIds.length === 0) return;

  const { data: employees } = await ctx.supabase
    .from("employees")
    .select("id, profile_id")
    .eq("company_id", ctx.membership.company_id)
    .in("id", employeeIds);

  const recipients = (employees ?? []).filter((e) => e.profile_id);
  if (recipients.length === 0) return;

  const { error } = await ctx.supabase.from("notifications").insert(
    recipients.map((e) => ({
      company_id: ctx.membership.company_id,
      profile_id: e.profile_id,
      type: "open_shift_available",
      payload: { offer_id: offerId, shift_id: shiftId },
    }))
  );
  if (error) console.error("offer notification insert failed:", error.message);
}

/* ------------------------------------------------------------------------- */
/* B4 — approval and rejection                                                */
/* ------------------------------------------------------------------------- */

/**
 * Statuses the SQL function can report. Everything except `approved` is a
 * refusal the manager should read as a sentence, never as a database error.
 */
export type ApprovalStatus =
  | "approved"
  | "already_decided"
  | "not_interested"
  | "offer_closed"
  | "shift_not_open"
  | "shift_in_past"
  | "employee_inactive"
  | "already_assigned"
  | "overlapping_assignment"
  | "no_vacancy"
  | "forbidden"
  | "not_found";

export type ApproveOutcome =
  | { kind: "approved"; assignmentId: string; shiftFilled: boolean }
  | { kind: "refused"; status: ApprovalStatus }
  | { kind: "ineligible"; reason: IneligibleReason };

type ResponseContext = {
  responseId: string;
  employeeId: string;
  employeeName: string;
  offerId: string;
  shift: ShiftRow & { status: string; required_count: number };
  decidedAt: string | null;
  response: string;
};

/**
 * Resolve a response with everything approval needs, entirely server-side.
 * A response outside the caller's tenant does not survive RLS, and the
 * explicit company comparison makes that guarantee visible.
 */
async function resolveResponse(
  ctx: AuthContext,
  responseId: string
): Promise<ResponseContext> {
  const { data } = await ctx.supabase
    .from("shift_offer_responses")
    .select(
      "id, company_id, employee_id, offer_id, response, decided_at, employees(full_name), shift_offers(shift_id, company_id, status)"
    )
    .eq("id", responseId)
    .maybeSingle();

  if (!data || data.company_id !== ctx.membership.company_id) {
    throw new AuthzError("wrong_tenant", "offer response not accessible");
  }

  const offer = data.shift_offers as unknown as {
    shift_id: string;
    company_id: string;
    status: string;
  } | null;
  if (!offer || offer.company_id !== ctx.membership.company_id) {
    throw new AuthzError("wrong_tenant", "offer not accessible");
  }

  const { data: shift } = await ctx.supabase
    .from("shifts")
    .select(
      "id, company_id, date, start_time, end_time, status, required_count, required_role, required_qualification"
    )
    .eq("id", offer.shift_id)
    .maybeSingle();
  if (!shift || shift.company_id !== ctx.membership.company_id) {
    throw new AuthzError("wrong_tenant", "shift not accessible");
  }

  const employee = data.employees as unknown as { full_name: string } | null;
  return {
    responseId: data.id,
    employeeId: data.employee_id,
    employeeName: employee?.full_name ?? "",
    offerId: data.offer_id,
    shift: shift as ResponseContext["shift"],
    decidedAt: data.decided_at,
    response: data.response,
  };
}

/**
 * Approve an interested candidate.
 *
 * Two layers, deliberately: the full scheduling rules are re-evaluated here
 * against freshly loaded rows, then approve_shift_offer() repeats only the
 * handful of checks a concurrent transaction could invalidate, while holding
 * a lock on the shift.
 */
export const approveOfferResponse = validatedAction(
  z.object({ responseId: uuid }),
  async (input): Promise<ApproveOutcome> => {
    const ctx = await requirePermission("scheduling.manage");
    const target = await resolveResponse(ctx, input.responseId);

    if (target.decidedAt) return { kind: "refused", status: "already_decided" };
    if (target.response !== "interested") {
      return { kind: "refused", status: "not_interested" };
    }

    // Fresh eligibility: the candidate list that produced this response may be
    // hours old. Reload everything and re-run the B1 engine.
    const candidates = await loadCandidateInputsForShift(ctx.supabase, target.shift);
    const candidate = candidates.find((c) => c.employeeId === target.employeeId);
    if (!candidate) return { kind: "ineligible", reason: "wrong_company" };

    const verdict = evaluateCandidate(candidate, toShiftContext(target.shift));
    if (!verdict.eligible) {
      return { kind: "ineligible", reason: verdict.reasons[0] ?? "not_schedulable" };
    }

    const { data, error } = await ctx.supabase.rpc("approve_shift_offer", {
      p_response_id: target.responseId,
    });
    if (error) throw new Error(`approval failed: ${error.message}`);

    const result = data as {
      status: ApprovalStatus;
      assignment_id?: string;
      shift_filled?: boolean;
    };

    if (result.status !== "approved") {
      return { kind: "refused", status: result.status };
    }

    await notifyDecision(ctx, {
      employeeId: target.employeeId,
      type: "replacement_approved",
      payload: { offer_id: target.offerId, shift_id: target.shift.id },
    });

    if (result.shift_filled) await notifyOfferClosed(ctx, target.offerId, target.shift.id);

    await writeAudit(ctx, {
      action: "shift_offer.approved",
      entity: "shift_offer_responses",
      entityId: target.responseId,
      diff: { assignment_id: result.assignment_id, shift_filled: result.shift_filled },
    });

    revalidatePath("/app/shifts");
    return {
      kind: "approved",
      assignmentId: result.assignment_id!,
      shiftFilled: result.shift_filled === true,
    };
  }
);

export type RejectOutcome =
  | { kind: "rejected" }
  | { kind: "refused"; status: "already_decided" | "not_interested" };

/**
 * Decline an interested candidate.
 *
 * Recorded as decision metadata rather than a new enum value: decided_at is
 * set and resulting_assignment_id stays null, which is exactly "considered and
 * not selected". The response column keeps saying what the employee said.
 */
export const rejectOfferResponse = validatedAction(
  z.object({ responseId: uuid }),
  async (input): Promise<RejectOutcome> => {
    const ctx = await requirePermission("scheduling.manage");
    const target = await resolveResponse(ctx, input.responseId);

    if (target.decidedAt) return { kind: "refused", status: "already_decided" };
    if (target.response !== "interested") {
      return { kind: "refused", status: "not_interested" };
    }

    // Guarded on decided_at so a double click updates one row, once.
    const { data: updated, error } = await ctx.supabase
      .from("shift_offer_responses")
      .update({ decided_by: ctx.userId, decided_at: new Date().toISOString() })
      .eq("id", target.responseId)
      .is("decided_at", null)
      .select("id");
    if (error) throw new Error(`rejection failed: ${error.message}`);
    if (!updated || updated.length === 0) {
      return { kind: "refused", status: "already_decided" };
    }

    await notifyDecision(ctx, {
      employeeId: target.employeeId,
      type: "replacement_declined",
      payload: { offer_id: target.offerId, shift_id: target.shift.id },
    });

    await writeAudit(ctx, {
      action: "shift_offer.rejected",
      entity: "shift_offer_responses",
      entityId: target.responseId,
    });

    revalidatePath("/app/shifts");
    return { kind: "rejected" };
  }
);

/** Tell one employee what was decided. Reached only on a real state change. */
async function notifyDecision(
  ctx: AuthContext,
  event: { employeeId: string; type: string; payload: Record<string, unknown> }
): Promise<void> {
  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("profile_id")
    .eq("company_id", ctx.membership.company_id)
    .eq("id", event.employeeId)
    .maybeSingle();
  if (!employee?.profile_id) return;

  const { error } = await ctx.supabase.from("notifications").insert({
    company_id: ctx.membership.company_id,
    profile_id: employee.profile_id,
    type: event.type,
    payload: event.payload,
  });
  if (error) console.error("decision notification failed:", error.message);
}

/**
 * When the last seat goes, everyone still waiting is told plainly that the
 * shift is filled. Their responses are left intact as history — closing the
 * offer is what makes them non-actionable.
 */
async function notifyOfferClosed(
  ctx: AuthContext,
  offerId: string,
  shiftId: string
): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("offer-closed notification skipped: SUPABASE_SERVICE_ROLE_KEY not set");
    return;
  }
  const admin = createAdminClient();

  const { data: waiting } = await admin
    .from("shift_offer_responses")
    .select("employee_id, employees(profile_id)")
    .eq("offer_id", offerId)
    .is("decided_at", null)
    .in("response", ["pending", "interested"]);

  const recipients = (waiting ?? [])
    .map((row) => (row.employees as unknown as { profile_id: string | null } | null)?.profile_id)
    .filter((profileId): profileId is string => Boolean(profileId));
  if (recipients.length === 0) return;

  const { error } = await admin.from("notifications").insert(
    recipients.map((profileId) => ({
      company_id: ctx.membership.company_id,
      profile_id: profileId,
      type: "replacement_declined",
      payload: { offer_id: offerId, shift_id: shiftId, reason: "shift_filled" },
    }))
  );
  if (error) console.error("offer-closed notification failed:", error.message);
}

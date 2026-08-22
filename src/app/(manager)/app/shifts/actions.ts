"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, AuthzError } from "@/lib/authz";
import { validatedAction, uuid } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { loadCandidateInputsForShift, toShiftContext, type ShiftRow } from "@/lib/candidates";
import { evaluateCandidate, OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/eligibility";

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

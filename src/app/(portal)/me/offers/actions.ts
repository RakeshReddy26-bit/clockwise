"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireContext, AuthzError, type AuthContext } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { validatedAction, uuid } from "@/lib/validation";
import {
  EMPLOYEE_RESPONSES,
  classifyTransition,
  type EmployeeResponse,
  type ResponseState,
} from "@/lib/offer-transitions";

/**
 * Employee answer to a shift offer.
 *
 * The client sends a response id and an intent — nothing else. Employee,
 * company, offer and current state are all resolved here, and the update
 * touches only `response` and `responded_at`. RLS refuses the same forgeries
 * independently; this is the application boundary, not a substitute for it.
 */

export type RespondOutcome =
  | { kind: "saved"; response: EmployeeResponse }
  | { kind: "unchanged"; response: EmployeeResponse }
  | { kind: "offer_closed" }
  | { kind: "already_decided" }
  | { kind: "not_allowed" };

const STAFF_ROLES = ["COMPANY_ADMIN", "DISPATCHER"] as const;

export const respondToOffer = validatedAction(
  z.object({
    responseId: uuid,
    intent: z.enum(EMPLOYEE_RESPONSES),
  }),
  async (input): Promise<RespondOutcome> => {
    const ctx = await requireContext();
    const companyId = ctx.membership.company_id;

    const { data: employee } = await ctx.supabase
      .from("employees")
      .select("id, full_name")
      .eq("company_id", companyId)
      .eq("profile_id", ctx.userId)
      .maybeSingle();
    if (!employee) throw new AuthzError("forbidden", "no employee record");

    // The row is fetched under the caller's RLS, so a foreign response id
    // simply does not resolve. The explicit checks below make the intent of
    // that guarantee visible rather than implicit.
    const { data: response } = await ctx.supabase
      .from("shift_offer_responses")
      .select(
        "id, company_id, employee_id, offer_id, response, decided_at, shift_offers(id, company_id, shift_id, status)"
      )
      .eq("id", input.responseId)
      .maybeSingle();

    if (
      !response ||
      response.company_id !== companyId ||
      response.employee_id !== employee.id
    ) {
      throw new AuthzError("wrong_tenant", "offer response not accessible");
    }

    const offer = response.shift_offers as unknown as {
      id: string;
      company_id: string;
      shift_id: string;
      status: string;
    } | null;
    if (!offer || offer.company_id !== companyId) {
      throw new AuthzError("wrong_tenant", "offer not accessible");
    }

    if (response.decided_at) return { kind: "already_decided" };
    if (offer.status !== "open") return { kind: "offer_closed" };

    const outcome = classifyTransition(
      response.response as ResponseState,
      input.intent
    );
    if (outcome.kind === "not_allowed") return { kind: "not_allowed" };
    if (outcome.kind === "unchanged") {
      // A retry or a double click: nothing to write, nobody to notify.
      return { kind: "unchanged", response: input.intent };
    }

    const { error } = await ctx.supabase
      .from("shift_offer_responses")
      .update({ response: outcome.to, responded_at: new Date().toISOString() })
      .eq("id", response.id);
    if (error) throw new Error(`response update failed: ${error.message}`);

    await notifyStaff(ctx, {
      offerId: offer.id,
      shiftId: offer.shift_id,
      responseId: response.id,
      employeeName: employee.full_name,
      response: outcome.to,
    });

    revalidatePath("/me");
    revalidatePath("/me/shifts");
    return { kind: "saved", response: outcome.to };
  }
);

/**
 * Tell the schedulers. Only reached on a real state change, so a retry never
 * produces a second notification.
 *
 * Runs through the service-role client because notifications may only be
 * written by staff — an employee has no insert rights on that table, and the
 * alternative would be widening RLS into a spam vector. Same pattern as the
 * geofence and attendance alerts. The company id still comes from the
 * caller's own membership, never from input.
 */
async function notifyStaff(
  ctx: AuthContext,
  event: {
    offerId: string;
    shiftId: string;
    responseId: string;
    employeeName: string;
    response: EmployeeResponse;
  }
): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("offer response notification skipped: SUPABASE_SERVICE_ROLE_KEY not set");
    return;
  }
  const companyId = ctx.membership.company_id;
  const admin = createAdminClient();

  const { data: staff } = await admin
    .from("company_memberships")
    .select("profile_id")
    .eq("company_id", companyId)
    .eq("status", "active")
    .in("role", [...STAFF_ROLES]);
  if (!staff?.length) return;

  const { error } = await admin.from("notifications").insert(
    staff.map((member) => ({
      company_id: companyId,
      profile_id: member.profile_id,
      type: "shift_offer_response",
      payload: {
        offer_id: event.offerId,
        shift_id: event.shiftId,
        response_id: event.responseId,
        employee_name: event.employeeName,
        response: event.response,
      },
    }))
  );
  if (error) console.error("offer response notification failed:", error.message);
}

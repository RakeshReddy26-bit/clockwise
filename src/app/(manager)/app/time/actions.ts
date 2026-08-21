"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, AuthzError } from "@/lib/authz";
import { validatedAction, uuid } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";

/**
 * Manager decision on a manual clock-in request.
 * Chain: auth → active membership → time.manage permission → resource tenant
 * (request row is only readable through the caller's RLS) → RLS.
 * An approved entry is permanently marked manager_override — never hidden.
 */
export const decideManualClockIn = validatedAction(
  z.object({ requestId: uuid, decision: z.enum(["approved", "rejected"]) }),
  async (input) => {
    const ctx = await requirePermission("time.manage");

    const { data: request } = await ctx.supabase
      .from("manual_clockin_requests")
      .select(
        "id, company_id, employee_id, shift_assignment_id, status, reason, latitude, longitude, accuracy_m, distance_m"
      )
      .eq("id", input.requestId)
      .maybeSingle();
    if (!request || request.company_id !== ctx.membership.company_id) {
      throw new AuthzError("wrong_tenant", "request not accessible");
    }
    if (request.status !== "pending") {
      throw new AuthzError("forbidden", "request already decided");
    }

    let timeEntryId: string | null = null;

    if (input.decision === "approved") {
      const { data: entry, error } = await ctx.supabase
        .from("time_entries")
        .insert({
          company_id: ctx.membership.company_id,
          employee_id: request.employee_id,
          shift_assignment_id: request.shift_assignment_id,
          clock_in: new Date().toISOString(),
          source: "manual",
          status: "running",
          clock_in_lat: request.latitude,
          clock_in_lng: request.longitude,
          clock_in_accuracy_m: request.accuracy_m,
          clock_in_distance_m: request.distance_m,
          clock_in_location_status: "manager_override",
        })
        .select("id")
        .single();
      if (error || !entry) throw new Error(`override entry failed: ${error?.message}`);
      timeEntryId = entry.id;
    }

    const { error: updateError } = await ctx.supabase
      .from("manual_clockin_requests")
      .update({
        status: input.decision,
        decided_by: ctx.userId,
        decided_at: new Date().toISOString(),
        time_entry_id: timeEntryId,
      })
      .eq("id", request.id);
    if (updateError) throw new Error(`request update failed: ${updateError.message}`);

    await ctx.supabase.from("location_events").insert({
      company_id: ctx.membership.company_id,
      employee_id: request.employee_id,
      shift_assignment_id: request.shift_assignment_id,
      time_entry_id: timeEntryId,
      event_type:
        input.decision === "approved" ? "manual_clock_in_approved" : "manual_clock_in_rejected",
      latitude: request.latitude,
      longitude: request.longitude,
      accuracy_m: request.accuracy_m,
      distance_m: request.distance_m,
    });

    // Notify the employee (staff may insert notifications for their company)
    const { data: employee } = await ctx.supabase
      .from("employees")
      .select("profile_id")
      .eq("id", request.employee_id)
      .maybeSingle();
    if (employee?.profile_id) {
      await ctx.supabase.from("notifications").insert({
        company_id: ctx.membership.company_id,
        profile_id: employee.profile_id,
        type:
          input.decision === "approved" ? "manual_clockin_approved" : "manual_clockin_rejected",
        payload: { request_id: request.id, shift_assignment_id: request.shift_assignment_id },
      });
    }

    await writeAudit(ctx, {
      action: `manual_clockin.${input.decision}`,
      entity: "manual_clockin_requests",
      entityId: request.id,
      diff: { reason: request.reason, distance_m: request.distance_m },
    });

    revalidatePath("/app/time");
    return { outcome: input.decision, timeEntryId };
  }
);

/** Form bindings for the approval buttons on /app/time. */
export async function approveManualRequest(formData: FormData) {
  await decideManualClockIn({ requestId: String(formData.get("requestId")), decision: "approved" });
}

export async function rejectManualRequest(formData: FormData) {
  await decideManualClockIn({ requestId: String(formData.get("requestId")), decision: "rejected" });
}

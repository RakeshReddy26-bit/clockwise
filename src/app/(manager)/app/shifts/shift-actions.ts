"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, type AuthContext } from "@/lib/authz";
import { validatedAction, uuid } from "@/lib/validation";
import { EDITABLE_FIELDS, type EditableField } from "@/lib/shift-lifecycle";

/**
 * Shift lifecycle — create, edit, cancel (Phase D).
 *
 * Deliberately thin. Every rule lives in one of two places a developer can
 * find: the pure matrix in src/lib/shift-lifecycle.ts, and the three SQL
 * functions in 0011 which are authoritative and re-check everything under the
 * shift lock. These actions validate shapes, call one function, and turn its
 * refusal code into something a manager can read.
 *
 * The client never sends company_id — it comes from the caller's membership,
 * and for creation from the job, which RLS has already scoped to the tenant.
 */

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export type CreateShiftStatus =
  | "created"
  | "invalid_interval"
  | "invalid_count"
  | "start_in_past"
  | "forbidden"
  | "not_found";

export type CreateShiftOutcome =
  | { kind: "created"; shiftId: string }
  | { kind: "refused"; status: CreateShiftStatus };

/** Times arrive as ISO strings from a datetime-local input, in UTC. */
const isoDateTime = z.string().datetime({ offset: true });

export const createShift = validatedAction(
  z.object({
    jobId: uuid,
    startTime: isoDateTime,
    endTime: isoDateTime,
    requiredCount: z.number().int().min(1).max(200),
    requiredRole: z.string().trim().max(120).optional(),
    requiredQualification: z.string().trim().max(120).optional(),
    instructions: z.string().trim().max(2000).optional(),
    contactPerson: z.string().trim().max(200).optional(),
  }),
  async (input): Promise<CreateShiftOutcome> => {
    const ctx = await requirePermission("scheduling.manage");

    const { data, error } = await ctx.supabase.rpc("create_shift", {
      p_job_id: input.jobId,
      p_start_time: input.startTime,
      p_end_time: input.endTime,
      p_required_count: input.requiredCount,
      p_required_role: input.requiredRole ?? null,
      p_required_qualification: input.requiredQualification ?? null,
      p_instructions: input.instructions ?? null,
      p_contact_person: input.contactPerson ?? null,
    });
    if (error) throw new Error(`create shift failed: ${error.message}`);

    const result = data as { status: CreateShiftStatus; shift_id?: string };
    if (result.status !== "created") return { kind: "refused", status: result.status };

    revalidatePath("/app/shifts");
    revalidatePath("/app");
    return { kind: "created", shiftId: result.shift_id! };
  }
);

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

export type UpdateShiftStatus =
  | "updated"
  | "no_changes"
  | "requires_confirmation"
  | "below_occupancy"
  | "has_assignments"
  | "has_time_entries"
  | "job_locked"
  | "shift_ended"
  | "shift_cancelled"
  | "invalid_interval"
  | "invalid_count"
  | "start_in_past"
  | "forbidden"
  | "not_found";

export type UpdateShiftOutcome =
  | { kind: "updated"; changed: EditableField[]; offerClosed: boolean }
  | { kind: "unchanged" }
  | {
      kind: "confirm";
      changed: EditableField[];
      engagement: string;
      interested: number;
    }
  | { kind: "refused"; status: UpdateShiftStatus; occupancy?: number; assignments?: number };

const patchSchema = z.object({
  jobId: uuid.optional(),
  startTime: isoDateTime.optional(),
  endTime: isoDateTime.optional(),
  requiredCount: z.number().int().min(1).max(200).optional(),
  requiredRole: z.string().trim().max(120).nullable().optional(),
  requiredQualification: z.string().trim().max(120).nullable().optional(),
  instructions: z.string().trim().max(2000).nullable().optional(),
  contactPerson: z.string().trim().max(200).nullable().optional(),
});

/**
 * The SQL side takes a jsonb patch because presence and null must be
 * distinguishable: omitting a key means "leave it alone", passing null means
 * "clear it". This maps the camelCase action input onto the column names,
 * dropping keys the caller did not send.
 */
function toPatch(input: z.infer<typeof patchSchema>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.jobId !== undefined) patch.job_id = input.jobId;
  if (input.startTime !== undefined) patch.start_time = input.startTime;
  if (input.endTime !== undefined) patch.end_time = input.endTime;
  if (input.requiredCount !== undefined) patch.required_count = input.requiredCount;
  if (input.requiredRole !== undefined) patch.required_role = input.requiredRole;
  if (input.requiredQualification !== undefined) {
    patch.required_qualification = input.requiredQualification;
  }
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.contactPerson !== undefined) patch.contact_person = input.contactPerson;
  return patch;
}

export const updateShift = validatedAction(
  z.object({ shiftId: uuid, patch: patchSchema, confirm: z.boolean().default(false) }),
  async (input): Promise<UpdateShiftOutcome> => {
    const ctx = await requirePermission("scheduling.manage");

    // Read BEFORE the change: a confirmed risky edit closes the open offer,
    // and the invited employees are then no longer reachable through it.
    const recipients = await engagedProfiles(ctx, input.shiftId);

    const { data, error } = await ctx.supabase.rpc("update_shift", {
      p_shift_id: input.shiftId,
      p_patch: toPatch(input.patch),
      p_confirm: input.confirm,
    });
    if (error) throw new Error(`update shift failed: ${error.message}`);

    const result = data as {
      status: UpdateShiftStatus;
      changed?: string[];
      offer_closed?: boolean;
      notify?: boolean;
      engagement?: string;
      interested?: number;
      occupancy?: number;
      assignments?: number;
    };

    if (result.status === "no_changes") return { kind: "unchanged" };

    if (result.status === "requires_confirmation") {
      return {
        kind: "confirm",
        changed: (result.changed ?? []).filter(isEditable),
        engagement: result.engagement ?? "offered",
        interested: result.interested ?? 0,
      };
    }

    if (result.status !== "updated") {
      return {
        kind: "refused",
        status: result.status,
        occupancy: result.occupancy,
        assignments: result.assignments,
      };
    }

    const changed = (result.changed ?? []).filter(isEditable);

    // Reached only on a committed change, so a retry — which comes back
    // no_changes — tells nobody twice. Capacity alone is deliberately silent:
    // needing one more person changes nothing about the shift the people
    // already involved agreed to.
    if (result.notify) {
      await notifyProfiles(ctx, recipients, "shift_changed", {
        shift_id: input.shiftId,
        changed,
      });
    }

    revalidatePath("/app/shifts");
    revalidatePath("/app");
    return { kind: "updated", changed, offerClosed: result.offer_closed === true };
  }
);

function isEditable(value: string): value is EditableField {
  return (EDITABLE_FIELDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Cancel                                                              */
/* ------------------------------------------------------------------ */

export type CancelShiftStatus =
  | "cancelled"
  | "already_cancelled"
  | "already_worked"
  | "shift_ended"
  | "reason_required"
  | "forbidden"
  | "not_found";

export type CancelShiftOutcome =
  | { kind: "cancelled"; assignmentsCancelled: number; offersClosed: number }
  | { kind: "refused"; status: CancelShiftStatus };

export const cancelShift = validatedAction(
  z.object({ shiftId: uuid, reason: z.string().trim().min(5).max(500) }),
  async (input): Promise<CancelShiftOutcome> => {
    const ctx = await requirePermission("scheduling.manage");

    // Recipients are read BEFORE the cancellation, while the assignments and
    // the open offer still say who was involved.
    const recipients = await engagedProfiles(ctx, input.shiftId);

    const { data, error } = await ctx.supabase.rpc("cancel_shift", {
      p_shift_id: input.shiftId,
      p_reason: input.reason,
    });
    if (error) throw new Error(`cancel shift failed: ${error.message}`);

    const result = data as {
      status: CancelShiftStatus;
      assignments_cancelled?: number;
      offers_closed?: number;
    };

    if (result.status !== "cancelled") return { kind: "refused", status: result.status };

    // Only a real cancellation reaches here; a second attempt returns
    // already_cancelled and notifies nobody.
    await notifyProfiles(ctx, recipients, "shift_cancelled", { shift_id: input.shiftId });

    revalidatePath("/app/shifts");
    revalidatePath("/app");
    return {
      kind: "cancelled",
      assignmentsCancelled: result.assignments_cancelled ?? 0,
      offersClosed: result.offers_closed ?? 0,
    };
  }
);

/* ------------------------------------------------------------------ */
/* Notification helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Everyone with a stake in this shift: people holding a seat, and people
 * sitting on an open invitation. Both need to know when it changes under them.
 */
async function engagedProfiles(ctx: AuthContext, shiftId: string): Promise<string[]> {
  const companyId = ctx.membership.company_id;

  const [{ data: assigned }, { data: invited }] = await Promise.all([
    ctx.supabase
      .from("shift_assignments")
      .select("employees(profile_id)")
      .eq("shift_id", shiftId)
      .in("status", ["assigned", "accepted", "cancellation_requested"]),
    ctx.supabase
      .from("shift_offer_responses")
      .select("employees(profile_id), shift_offers!inner(shift_id, status)")
      .eq("company_id", companyId)
      .eq("shift_offers.shift_id", shiftId)
      .eq("shift_offers.status", "open")
      .is("decided_at", null),
  ]);

  const ids = [...(assigned ?? []), ...(invited ?? [])]
    .map((row) => (row.employees as unknown as { profile_id: string | null } | null)?.profile_id)
    .filter((id): id is string => Boolean(id));

  return [...new Set(ids)];
}

/**
 * One row per person. The manager writes these under their own rights:
 * notifications_insert_staff allows staff inserts, so no service-role client
 * is needed anywhere in this file.
 */
async function notifyProfiles(
  ctx: AuthContext,
  profileIds: string[],
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (profileIds.length === 0) return;

  const { error } = await ctx.supabase.from("notifications").insert(
    profileIds.map((profileId) => ({
      company_id: ctx.membership.company_id,
      profile_id: profileId,
      type,
      payload,
    }))
  );
  if (error) console.error(`${type} notification failed:`, error.message);
}

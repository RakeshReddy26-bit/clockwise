"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireContext, AuthzError, type AuthContext } from "@/lib/authz";
import { validatedAction, uuid } from "@/lib/validation";
import { classifyAvailability, filterEditableFields } from "@/lib/employee";

/**
 * Employee self-service.
 *
 * The whole of it, and the shortness is the point:
 *
 *   employees        — phone, and nothing else. Enforced by
 *                      guard_employee_field_ownership() (0016), which compares
 *                      whole rows as jsonb minus 'phone', so a column added by a
 *                      later migration is protected by default.
 *   profiles         — display name and locale, the account's own settings.
 *   emergency_contacts — their own, which nobody browses.
 *   employee_availability — their own recurring rules.
 *
 * Everything employment-authoritative belongs to HR. Nothing here can change
 * what someone is paid, what their status is, or which shifts they match.
 */

async function resolveEmployee(ctx: AuthContext) {
  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("id")
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();
  if (!employee) throw new AuthzError("forbidden", "no employee record");
  return employee as { id: string };
}

/* ------------------------------------------------------------------------- */
/* Contact                                                                    */
/* ------------------------------------------------------------------------- */

export const updateOwnContact = validatedAction(
  z.object({ phone: z.string().trim().max(60).nullable() }),
  async (input) => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);

    // filterEditableFields is the readable statement of the rule; the trigger is
    // what makes it true. If this ever let something else through, the database
    // would refuse the write rather than accept it.
    const { accepted } = filterEditableFields({ phone: input.phone }, "employee");

    const { error } = await ctx.supabase
      .from("employees")
      .update(accepted)
      .eq("id", employee.id);
    if (error) throw new Error(`contact update failed: ${error.message}`);

    revalidatePath("/me/profile");
    return { outcome: "saved" as const };
  }
);

export const updateOwnAccount = validatedAction(
  z.object({
    full_name: z.string().trim().min(1).max(200),
    locale: z.enum(["de", "en"]),
  }),
  async (input) => {
    const ctx = await requireContext();
    // profiles_update (0002) already pins this to `id = auth.uid()`.
    const { error } = await ctx.supabase
      .from("profiles")
      .update(input)
      .eq("id", ctx.userId);
    if (error) throw new Error(`profile update failed: ${error.message}`);

    revalidatePath("/me/profile");
    return { outcome: "saved" as const };
  }
);

/* ------------------------------------------------------------------------- */
/* Emergency contact                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Their own emergency contact. Deliberately not shown on the manager employee
 * page: HR can technically read these rows, but a next-of-kin phone number has
 * no place on a routine admin screen, and dispatch cannot see them at all.
 *
 * Never audited — the audit trail would be a second, broadly-readable copy of
 * exactly the data this is trying to keep narrow.
 */
export const saveOwnEmergencyContact = validatedAction(
  z.object({
    contactId: uuid.optional(),
    name: z.string().trim().min(1).max(200),
    relationship: z.string().trim().max(120).nullable(),
    phone: z.string().trim().min(1).max(60),
    phone_alt: z.string().trim().max(60).nullable(),
  }),
  async (input) => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);
    const { contactId, ...fields } = input;

    if (contactId) {
      const { data, error } = await ctx.supabase
        .from("emergency_contacts")
        .update(fields)
        .eq("id", contactId)
        .eq("employee_id", employee.id)
        .select("id");
      if (error) throw new Error(`emergency contact update failed: ${error.message}`);
      if (!data?.length) throw new AuthzError("wrong_tenant", "contact not accessible");
    } else {
      const { error } = await ctx.supabase.from("emergency_contacts").insert({
        ...fields,
        company_id: ctx.membership.company_id,
        employee_id: employee.id,
      });
      if (error) throw new Error(`emergency contact insert failed: ${error.message}`);
    }

    revalidatePath("/me/profile");
    return { outcome: "saved" as const };
  }
);

export const deleteOwnEmergencyContact = validatedAction(
  z.object({ contactId: uuid }),
  async (input) => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);
    const { error } = await ctx.supabase
      .from("emergency_contacts")
      .delete()
      .eq("id", input.contactId)
      .eq("employee_id", employee.id);
    if (error) throw new Error(`emergency contact delete failed: ${error.message}`);

    revalidatePath("/me/profile");
    return { outcome: "deleted" as const };
  }
);

/* ------------------------------------------------------------------------- */
/* Availability                                                               */
/* ------------------------------------------------------------------------- */

export type AvailabilityOutcome =
  | { kind: "saved" }
  | { kind: "refused"; reason: "invalid_weekday" | "invalid_type" | "invalid_range" };

/**
 * Add one recurring availability rule.
 *
 * Only an `unavailable` rule actually excludes anybody — the eligibility engine
 * treats "no data" as available, because most people have no rows and the
 * alternative would empty every candidate list. `available` and `preferred` are
 * recorded as intent for a human reading the candidate list.
 *
 * Adding a rule NEVER touches a shift the employee has already accepted. A
 * commitment made is a commitment; if it now clashes, the C2 cancellation
 * request is how they ask to be released.
 */
export const addOwnAvailability = validatedAction(
  z.object({
    weekday: z.number().int().gte(0).lte(6).nullable(),
    start_time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    end_time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    type: z.enum(["available", "unavailable", "preferred"]),
  }),
  async (input): Promise<AvailabilityOutcome> => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);

    const verdict = classifyAvailability({
      weekday: input.weekday,
      startTime: input.start_time,
      endTime: input.end_time,
      type: input.type,
    });
    if (verdict.kind === "refused") return { kind: "refused", reason: verdict.reason };

    const { error } = await ctx.supabase.from("employee_availability").insert({
      company_id: ctx.membership.company_id,
      employee_id: employee.id,
      weekday: input.weekday,
      start_time: input.start_time,
      end_time: input.end_time,
      type: input.type,
    });
    if (error) throw new Error(`availability insert failed: ${error.message}`);

    revalidatePath("/me/profile");
    return { kind: "saved" };
  }
);

export const removeOwnAvailability = validatedAction(
  z.object({ availabilityId: uuid }),
  async (input) => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);
    const { error } = await ctx.supabase
      .from("employee_availability")
      .delete()
      .eq("id", input.availabilityId)
      .eq("employee_id", employee.id);
    if (error) throw new Error(`availability delete failed: ${error.message}`);

    revalidatePath("/me/profile");
    return { outcome: "deleted" as const };
  }
);

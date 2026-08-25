"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, requireContext, AuthzError, type AuthContext } from "@/lib/authz";
import { validatedAction, uuid } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { publicEnv } from "@/lib/env";
import { inviteEmployeeAccount } from "@/lib/supabase/auth-admin";
import { classifyInvite, type InviteRefusal } from "@/lib/account";

/**
 * Account lifecycle actions.
 *
 * The hard part of this file is that Supabase Auth and Postgres cannot share a
 * transaction. The ordering below is chosen so every failure point leaves a
 * state that is either correct or safely retryable:
 *
 *   1. check in the database   → refuse early, nothing written anywhere
 *   2. call Supabase Auth      → the only external effect; creates the identity
 *   3. one SQL function        → membership + link + audit, atomically
 *
 * If step 2 fails, nothing was written. If step 3 fails, the identity exists but
 * is linked to nothing — an orphan. That is a real, irreducible rough edge:
 * there is no email-lookup API in the installed client, so a retry cannot find
 * the orphan and step 2 will simply report account_exists. The interim remedy is
 * to delete the user in the Supabase dashboard and invite again; a repair path
 * is deliberately out of Phase G's scope rather than half-built here.
 */

const ACCOUNT_ERROR = "account action failed";

async function resolveEmployee(ctx: AuthContext, employeeId: string) {
  const { data } = await ctx.supabase
    .from("employees")
    .select("id, company_id, full_name, email, profile_id, employment_status")
    .eq("id", employeeId)
    .maybeSingle();
  if (!data || data.company_id !== ctx.membership.company_id) {
    throw new AuthzError("wrong_tenant", "employee not accessible");
  }
  return data as {
    id: string;
    full_name: string;
    email: string | null;
    profile_id: string | null;
    employment_status: string;
  };
}

/** Where the invitation email sends the recipient. */
function inviteRedirect(): string | null {
  const site = publicEnv().NEXT_PUBLIC_SITE_URL;
  if (!site) return null;
  return `${site.replace(/\/$/, "")}/auth/confirm?next=/welcome`;
}

export type InviteOutcome =
  | { kind: "invited" }
  | { kind: "refused"; reason: InviteRefusal | "not_configured" };

export const inviteEmployee = validatedAction(
  z.object({ employeeId: uuid }),
  async (input): Promise<InviteOutcome> => {
    const ctx = await requirePermission("employees.manage");
    const employee = await resolveEmployee(ctx, input.employeeId);

    const verdict = classifyInvite({
      profileId: employee.profile_id,
      email: employee.email,
      employmentStatus: employee.employment_status,
    });
    if (verdict.kind === "refused") return verdict;

    const redirectTo = inviteRedirect();
    if (!redirectTo) {
      // Refusing beats sending a link that points at the wrong origin.
      return { kind: "refused", reason: "not_configured" };
    }

    const result = await inviteEmployeeAccount({
      email: employee.email!.trim(),
      fullName: employee.full_name,
      redirectTo,
    });

    if (result.kind === "account_exists") {
      // Never attached. Matching email addresses prove nothing about who
      // controls the mailbox now, and this is exactly the takeover case.
      return { kind: "refused", reason: "account_exists" };
    }
    if (result.kind === "failed") throw new Error(`${ACCOUNT_ERROR}: ${result.message}`);

    const { data, error } = await ctx.supabase.rpc("invite_employee", {
      p_employee_id: employee.id,
      p_profile_id: result.profileId,
    });
    if (error) throw new Error(`${ACCOUNT_ERROR}: ${error.message}`);

    const status = (data as { status: string }).status;
    if (status !== "invited") {
      // already_linked is the concurrent-invite case: the other manager won,
      // and the identity we just minted is the orphan described above.
      return { kind: "refused", reason: "already_linked" };
    }

    // The audit row is written inside the SQL function, in the same
    // transaction, so it cannot exist without the link.
    revalidatePath("/app/employees");
    revalidatePath(`/app/employees/${employee.id}`);
    return { kind: "invited" };
  }
);

export type ResendOutcome = { kind: "sent" } | { kind: "refused"; reason: "not_invited" };

/**
 * Re-send the invitation. Supabase re-sends for a user who has not confirmed;
 * no database state changes, so this is safe to press repeatedly.
 */
export const resendInvite = validatedAction(
  z.object({ employeeId: uuid }),
  async (input): Promise<ResendOutcome> => {
    const ctx = await requirePermission("employees.manage");
    const employee = await resolveEmployee(ctx, input.employeeId);
    if (!employee.profile_id || !employee.email) {
      return { kind: "refused", reason: "not_invited" };
    }

    const { data: membership } = await ctx.supabase
      .from("company_memberships")
      .select("status")
      .eq("company_id", ctx.membership.company_id)
      .eq("profile_id", employee.profile_id)
      .maybeSingle();
    if (membership?.status !== "invited") return { kind: "refused", reason: "not_invited" };

    const redirectTo = inviteRedirect();
    if (!redirectTo) return { kind: "refused", reason: "not_invited" };

    const result = await inviteEmployeeAccount({
      email: employee.email.trim(),
      fullName: employee.full_name,
      redirectTo,
    });
    // account_exists is the expected answer here — the account is the one we
    // created. Supabase still re-sends, so it is not an error path.
    if (result.kind === "failed") throw new Error(`${ACCOUNT_ERROR}: ${result.message}`);

    await writeAudit(ctx, {
      action: "employee.invite_resent",
      entity: "employees",
      entityId: employee.id,
      diff: { profile_id: employee.profile_id },
    });

    revalidatePath(`/app/employees/${employee.id}`);
    return { kind: "sent" };
  }
);

export type AccessOutcome =
  | { kind: "changed"; suspended: boolean }
  | { kind: "refused"; reason: "forbidden" | "no_account" | "still_invited" | "unchanged" | "not_found" };

/**
 * Manual suspend / reactivate.
 *
 * Authorization is not checked with requirePermission here: no permission in
 * permissions.ts means "administer access", and inventing one would blur the
 * line Phase G is drawing. set_membership_access() requires COMPANY_ADMIN and
 * is the authority; this layer just carries the call and the message.
 */
export const setAccountAccess = validatedAction(
  z.object({ employeeId: uuid, suspend: z.boolean() }),
  async (input): Promise<AccessOutcome> => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx, input.employeeId);

    const { data, error } = await ctx.supabase.rpc("set_membership_access", {
      p_employee_id: employee.id,
      p_suspend: input.suspend,
    });
    if (error) throw new Error(`${ACCOUNT_ERROR}: ${error.message}`);

    const status = (data as { status: string }).status;
    if (status !== "suspended" && status !== "reactivated") {
      return {
        kind: "refused",
        reason: status as "forbidden" | "no_account" | "still_invited" | "unchanged" | "not_found",
      };
    }

    revalidatePath("/app/employees");
    revalidatePath(`/app/employees/${employee.id}`);
    return { kind: "changed", suspended: status === "suspended" };
  }
);

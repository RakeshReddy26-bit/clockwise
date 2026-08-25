/**
 * Account lifecycle rules (Phase G) — pure, no database, no network.
 *
 * An employment record and an account are two different things, and keeping
 * them separate is what makes this phase safe:
 *
 *   The EMPLOYMENT RECORD exists from the moment HR types a name. It can be
 *   scheduled, paid and terminated without anyone ever logging in.
 *
 *   The ACCOUNT is an identity Supabase Auth owns. Clockwise links to one, once,
 *   and only one it created itself through an invitation.
 *
 * Account state is derived, never stored: employees.profile_id plus
 * company_memberships.status already say everything, so Phase G adds no enum
 * and no column.
 */

import { accountState, type AccountState } from "@/lib/employee";

export { accountState, type AccountState };

/* ------------------------------------------------------------------ */
/* What an operator may do next                                        */
/* ------------------------------------------------------------------ */

export type AccountAction = "invite" | "resend" | "suspend" | "reactivate";

/**
 * The actions offered for a state. One action per state, deliberately — an
 * account panel with four buttons invites mistakes, and every state here has
 * exactly one sensible next move.
 *
 * `suspend`/`reactivate` are listed for the states that permit them; whether
 * the viewer may actually use them is a separate question (see canPerform).
 */
export function availableActions(state: AccountState): AccountAction[] {
  switch (state) {
    case "no_account":
      return ["invite"];
    case "invited":
      return ["resend"];
    case "active":
      return ["suspend"];
    case "suspended":
      return ["reactivate"];
  }
}

/**
 * Who may do what.
 *
 * Inviting is people administration, so HR does it. Suspending and reactivating
 * are security acts, so they stay with COMPANY_ADMIN — HR still reaches the
 * same outcome by terminating someone, which is the HR-shaped way to say it.
 * Narrowing the manual switch means a compromised HR account cannot lock a
 * company out of its own product.
 */
export function canPerform(action: AccountAction, role: string): boolean {
  const admin = role === "SUPER_ADMIN" || role === "COMPANY_ADMIN";
  if (action === "suspend" || action === "reactivate") return admin;
  return admin || role === "HR_MANAGER";
}

/* ------------------------------------------------------------------ */
/* Invitation preconditions                                            */
/* ------------------------------------------------------------------ */

export type InviteRefusal =
  | "already_linked"
  | "no_email"
  | "not_employed"
  | "account_exists";

export type InviteCheck = { kind: "allowed" } | { kind: "refused"; reason: InviteRefusal };

/**
 * May this employee be invited?
 *
 * Checked here so the operator gets a sentence, and again in SQL because a
 * concurrent invite could invalidate it between the two. `account_exists` is
 * not decidable here — only Supabase can answer it, and it answers by failing.
 *
 * A terminated employee is not invited: handing someone credentials on their
 * way out is the opposite of what termination means.
 */
export function classifyInvite(input: {
  profileId: string | null;
  email: string | null;
  employmentStatus: string;
}): InviteCheck {
  if (input.profileId !== null) return { kind: "refused", reason: "already_linked" };
  if (!input.email?.trim()) return { kind: "refused", reason: "no_email" };
  if (input.employmentStatus === "terminated") {
    return { kind: "refused", reason: "not_employed" };
  }
  return { kind: "allowed" };
}

/**
 * Supabase reports an address that already has an account by failing the call.
 *
 * There is no email-lookup API in the installed client — `listUsers` takes only
 * page and perPage — so this string/code match is the only signal available.
 * Phase G refuses every existing-account case rather than attaching one:
 * matching email addresses prove nothing about who controls the mailbox now.
 */
export function isExistingAccountError(error: {
  code?: string;
  status?: number;
  message?: string;
}): boolean {
  if (error.code === "email_exists" || error.code === "user_already_exists") return true;
  return /already( been)? registered|already exists/i.test(error.message ?? "");
}

/* ------------------------------------------------------------------ */
/* Access follows employment                                           */
/* ------------------------------------------------------------------ */

/** Employment statuses that keep portal access. Only termination removes it. */
export const ACCESS_ALLOWED_STATUSES = ["active", "probation", "on_leave"] as const;

export function employmentAllowsAccess(status: string): boolean {
  return (ACCESS_ALLOWED_STATUSES as readonly string[]).includes(status);
}

/**
 * What a status change does to access.
 *
 * On leave keeps access on purpose: someone recovering still needs their
 * roster, their documents and a way to message their manager. Only leaving the
 * company closes the door.
 *
 * Reactivation reopens access only for a membership this mechanism suspended —
 * an admin who suspended somebody deliberately is not overruled by an HR status
 * correction. The database enforces that by matching on the current status.
 */
export function accessEffect(from: string, to: string): "suspend" | "reactivate" | "none" {
  if (to === "terminated" && employmentAllowsAccess(from)) return "suspend";
  if (from === "terminated" && employmentAllowsAccess(to)) return "reactivate";
  return "none";
}

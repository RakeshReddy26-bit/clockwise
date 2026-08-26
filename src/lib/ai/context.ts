import "server-only";

import { requireContext, type AuthContext } from "@/lib/authz";
import { roleHas, type Permission } from "@/lib/permissions";

/**
 * Who is asking — resolved on the server, every request, from the session.
 *
 * The single most important rule in this feature lives here: identity is never
 * an input. Not from the browser, and not from the model. Tool schemas contain
 * no company_id, employee_id, profile_id or role field at all, so there is
 * nothing for a prompt injection to overwrite; a handler that wants the tenant
 * reads it from this object, which came from `requireContext()` — the same
 * chain every page and Server Action already uses.
 *
 * If a future tool needs to act on "the current employee", it uses
 * `employeeId` below, resolved here from the membership. It must not accept an
 * employee id argument for that purpose.
 */

export type AiContext = {
  auth: AuthContext;
  /** Tenant every tool query is scoped to. Not negotiable by the caller. */
  companyId: string;
  /** The signed-in profile. */
  userId: string;
  /** The employee row for this profile in this company, when one exists. */
  employeeId: string | null;
  companyName: string;
  /** Convenience wrapper so handlers read like the rest of the codebase. */
  can: (permission: Permission) => boolean;
};

export async function resolveAiContext(): Promise<AiContext> {
  const auth = await requireContext();
  const companyId = auth.membership.company_id;

  // Both reads go through the caller's own client, so RLS has already scoped
  // them before we look at anything.
  const [{ data: company }, { data: employee }] = await Promise.all([
    auth.supabase.from("companies").select("name").eq("id", companyId).maybeSingle(),
    auth.supabase
      .from("employees")
      .select("id")
      .eq("company_id", companyId)
      .eq("profile_id", auth.userId)
      .maybeSingle(),
  ]);

  return {
    auth,
    companyId,
    userId: auth.userId,
    employeeId: (employee?.id as string | undefined) ?? null,
    companyName: (company?.name as string | undefined) ?? "",
    can: (permission) => roleHas(auth.membership.role, permission),
  };
}

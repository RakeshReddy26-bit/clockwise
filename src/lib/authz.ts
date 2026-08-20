import "server-only";

import { createClient } from "@/lib/supabase/server";
import { roleHas, type Permission, type Role } from "@/lib/permissions";

/**
 * Server-side authorization chain. Sensitive operations call requireContext()
 * (or requirePermission()) and, for resource writes, assertCompanyResource().
 *
 *   1. authenticated user        — supabase.auth.getUser(), server-verified
 *   2. active company membership — resolved fresh from company_memberships
 *   3. required role/permission  — pure RBAC map (permissions.ts)
 *   4. resource tenant/ownership — assertCompanyResource()
 *   5. RLS                       — the database refuses regardless
 *
 * JWT claims are never treated as authoritative — step 2 always hits the DB.
 */

export class AuthzError extends Error {
  constructor(
    public readonly code:
      | "unauthenticated"
      | "no_membership"
      | "forbidden"
      | "wrong_tenant",
    message?: string
  ) {
    super(message ?? code);
    this.name = "AuthzError";
  }
}

export type Membership = {
  id: string;
  company_id: string;
  role: Role;
  status: "active" | "invited" | "suspended";
};

export type AuthContext = {
  userId: string;
  membership: Membership;
  supabase: Awaited<ReturnType<typeof createClient>>;
};

/** Step 1 — authenticated user (verified against the auth server). */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new AuthzError("unauthenticated");
  return { user, supabase };
}

/** Steps 1–2 — user plus an ACTIVE membership, read from the database. */
export async function requireContext(companyId?: string): Promise<AuthContext> {
  const { user, supabase } = await requireUser();

  let query = supabase
    .from("company_memberships")
    .select("id, company_id, role, status")
    .eq("profile_id", user.id)
    .eq("status", "active");
  if (companyId) query = query.eq("company_id", companyId);

  const { data, error } = await query.limit(1).maybeSingle();
  if (error || !data) throw new AuthzError("no_membership");

  return { userId: user.id, membership: data as Membership, supabase };
}

/** Steps 1–3 — context plus a required permission. */
export async function requirePermission(
  permission: Permission,
  companyId?: string
): Promise<AuthContext> {
  const ctx = await requireContext(companyId);
  if (!roleHas(ctx.membership.role, permission)) {
    throw new AuthzError("forbidden", `missing permission: ${permission}`);
  }
  return ctx;
}

/**
 * Step 4 — the resource being touched belongs to the caller's company.
 * Reads the row's company_id through the caller's own client, so RLS has
 * already filtered; a cross-tenant id resolves to "wrong_tenant".
 */
export async function assertCompanyResource(
  ctx: AuthContext,
  table: string,
  id: string
): Promise<void> {
  const { data, error } = await ctx.supabase
    .from(table)
    .select("company_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !data || data.company_id !== ctx.membership.company_id) {
    throw new AuthzError("wrong_tenant", `${table}/${id}`);
  }
}

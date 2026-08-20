import "server-only";

import type { AuthContext } from "@/lib/authz";

/** Append-only audit trail. Failures are logged, never fatal to the action. */
export async function writeAudit(
  ctx: AuthContext,
  entry: { action: string; entity: string; entityId?: string; diff?: unknown }
): Promise<void> {
  const { error } = await ctx.supabase.from("audit_logs").insert({
    company_id: ctx.membership.company_id,
    actor_profile_id: ctx.userId,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entityId ?? null,
    diff: entry.diff ?? null,
  });
  if (error) console.error("audit_log insert failed:", error.message);
}

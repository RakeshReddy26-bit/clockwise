"use server";

import { requireUser } from "@/lib/authz";

/**
 * Activate the membership the invitation created.
 *
 * The invited person cannot write company_memberships themselves — that is
 * COMPANY_ADMIN territory — so this is the one thing an invitee may do to their
 * own access, and activate_my_membership() (0017) confines it to
 * 'invited' → 'active' on their own row.
 *
 * requireUser rather than requireContext: at this moment they have a session
 * but not yet an active membership, which is exactly what requireContext
 * refuses. Calling it here would deadlock the flow.
 *
 * Safe to call repeatedly. It is a guarded single-row UPDATE, never an INSERT,
 * so refreshing this page cannot duplicate a membership. A membership that was
 * suspended in the meantime is untouched — someone terminated between
 * invitation and acceptance does not let themselves in.
 */
export async function activateMembership(): Promise<{ status: string }> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("activate_my_membership");
  if (error) {
    console.error("membership activation failed:", error.message);
    return { status: "failed" };
  }
  return data as { status: string };
}

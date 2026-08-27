import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env-server";

/**
 * The auth-admin door — one function, deliberately.
 *
 * This uses the same service-role key as createAdminClient(), but is kept
 * separate so the capability "can mint identities" is greppable and cannot
 * drift into "the admin client can do anything". Nothing else in the codebase
 * touches supabase.auth.admin.
 *
 * "server-only" makes importing this from client code a build error, and the
 * key is read through serverEnv(), never a NEXT_PUBLIC_ variable.
 */

export type InviteResult =
  | { kind: "invited"; profileId: string }
  /** The address already has an account. Phase G never attaches one. */
  | { kind: "account_exists" }
  | { kind: "failed"; message: string };

/**
 * Create an identity for `email` and send Supabase's invitation.
 *
 * inviteUserByEmail CREATES the user, which is precisely why linking it to an
 * employment record immediately is safe: a success means nobody has ever
 * controlled that address in this project and no password is set, so only the
 * invited mailbox can complete it.
 *
 * No metadata beyond the display name is passed. handle_new_user() (0003)
 * copies full_name and locale into profiles and nothing else — role and company
 * are never carried in user metadata, so no invitation can mint privilege.
 */
export async function inviteEmployeeAccount(input: {
  email: string;
  fullName: string;
  redirectTo: string;
}): Promise<InviteResult> {
  const env = serverEnv();
  const client = createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data, error } = await client.auth.admin.inviteUserByEmail(input.email, {
    data: { full_name: input.fullName },
    redirectTo: input.redirectTo,
  });

  if (error) {
    const { isExistingAccountError } = await import("@/lib/account");
    if (isExistingAccountError(error)) return { kind: "account_exists" };
    return { kind: "failed", message: error.message };
  }
  if (!data?.user?.id) return { kind: "failed", message: "invite returned no user" };

  return { kind: "invited", profileId: data.user.id };
}

import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env-server";

/**
 * Service-role client. Bypasses RLS — use only for tenant provisioning,
 * notification fan-out, and seed tooling. Never import from client code
 * ("server-only" makes that a build error).
 */
export function createAdminClient() {
  const env = serverEnv();
  return createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

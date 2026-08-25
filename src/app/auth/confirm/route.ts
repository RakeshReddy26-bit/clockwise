import { redirect } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Invitation / recovery landing.
 *
 * Server-side on purpose. PKCE is not supported for invitations — the browser
 * that sends the invite is not the browser that accepts it — so the alternative
 * is Supabase's default link, which returns tokens in a URL fragment that no
 * server route can read. Using `token_hash` + verifyOtp keeps session
 * establishment in cookies, exactly like the existing login action.
 *
 * This requires the Supabase "Invite user" email template to send
 * {{ .TokenHash }} to this route rather than {{ .ConfirmationURL }}. That is a
 * dashboard setting, not code, and it is listed in the deployment notes.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = url.searchParams.get("next") ?? "/welcome";

  // Only ever redirect within this application — an attacker-supplied absolute
  // URL here would turn the invitation into an open redirect.
  const destination = next.startsWith("/") && !next.startsWith("//") ? next : "/welcome";

  if (!tokenHash || !type) redirect("/login?error=invalid_link");

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) redirect("/login?error=invalid_link");

  redirect(destination);
}

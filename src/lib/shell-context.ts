import "server-only";

import { redirect } from "next/navigation";
import { requireContext, AuthzError, type AuthContext } from "@/lib/authz";

export type ShellContext = AuthContext & {
  profileName: string;
  company: {
    id: string;
    name: string;
    logo_url: string | null;
    settings: Record<string, unknown>;
  };
};

/** Context for the app shells; redirects instead of throwing. */
export async function getShellContext(): Promise<ShellContext> {
  let ctx: AuthContext;
  try {
    ctx = await requireContext();
  } catch (e) {
    if (e instanceof AuthzError) {
      redirect(e.code === "unauthenticated" ? "/login" : "/login?error=nomember");
    }
    throw e;
  }

  const [{ data: profile }, { data: company }] = await Promise.all([
    ctx.supabase.from("profiles").select("full_name").eq("id", ctx.userId).single(),
    ctx.supabase
      .from("companies")
      .select("id, name, logo_url, settings")
      .eq("id", ctx.membership.company_id)
      .single(),
  ]);

  if (!company) redirect("/login?error=nomember");

  return {
    ...ctx,
    profileName: profile?.full_name ?? "",
    company: company as ShellContext["company"],
  };
}

/** Tenant branding hook: companies.settings.branding.accent → CSS variables. */
export function brandingStyle(
  settings: Record<string, unknown>
): React.CSSProperties | undefined {
  const branding = settings?.["branding"] as
    | { accent?: string; accentForeground?: string }
    | undefined;
  if (!branding?.accent || !/^#[0-9a-fA-F]{6}$/.test(branding.accent)) return undefined;
  const style: Record<string, string> = { "--brand-accent": branding.accent };
  if (
    branding.accentForeground &&
    /^#[0-9a-fA-F]{6}$/.test(branding.accentForeground)
  ) {
    style["--brand-accent-foreground"] = branding.accentForeground;
  }
  return style as React.CSSProperties;
}

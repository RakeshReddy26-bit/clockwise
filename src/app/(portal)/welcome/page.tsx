import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/authz";
import { buttonVariants } from "@/components/ui/button";
import { activateMembership } from "./actions";

/**
 * First screen after an invitation is accepted.
 *
 * It does one thing on arrival — activate the membership — and then gets out of
 * the way. No profile setup form: HR already supplied the name, contract, site
 * and department, and asking for them again would be theatre. The two things we
 * genuinely do not have are offered as skippable links.
 */
export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const { user } = await requireUser().catch(() => redirect("/login"));
  const t = await getTranslations("welcome");

  const result = await activateMembership();

  // Nothing to activate and no membership at all means the invitation was
  // withdrawn or the person was terminated before accepting. Say so honestly
  // rather than leaving them on a page that cannot work.
  if (result.status === "failed") redirect("/login?error=nomember");

  const { supabase } = await requireUser();
  const { data: membership } = await supabase
    .from("company_memberships")
    .select("status")
    .eq("profile_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (!membership) redirect("/login?error=nomember");

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      <ul className="flex flex-col gap-2 text-sm">
        <li className="rounded-lg border bg-card p-3">
          <p className="font-medium">{t("shiftsTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("shiftsBody")}</p>
        </li>
        <li className="rounded-lg border bg-card p-3">
          <p className="font-medium">{t("clockTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("clockBody")}</p>
        </li>
        <li className="rounded-lg border bg-card p-3">
          <p className="font-medium">{t("absenceTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("absenceBody")}</p>
        </li>
      </ul>

      <div className="flex flex-col gap-2">
        <Link href="/me" className={buttonVariants({})}>
          {t("start")}
        </Link>
        <Link
          href="/me/profile"
          className="text-center text-xs text-muted-foreground hover:underline"
        >
          {t("completeProfile")}
        </Link>
      </div>
    </div>
  );
}

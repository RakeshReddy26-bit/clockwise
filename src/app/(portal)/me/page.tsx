import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OfferList } from "@/components/offer-list";
import { OfferOutcomes } from "@/components/offer-outcomes";
import { RemovalNotices } from "@/components/removal-notices";

export default async function HomePage() {
  const ctx = await getShellContext();
  const t = await getTranslations("home");
  const tn = await getTranslations("employeeNav");

  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("id")
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();

  const quickLinks = [
    { href: "/me/absences", label: tn("absences") },
    { href: "/me/calendar", label: tn("calendar") },
    { href: "/me/documents", label: tn("documents") },
    { href: "/me/requests", label: tn("requests") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("welcome", { name: ctx.profileName })}</CardTitle>
          <CardDescription>{t("foundationNote")}</CardDescription>
        </CardHeader>
      </Card>

      {employee && (
        <>
          {/* Outcome first: it answers "what happened?" before "what's new?" */}
          <RemovalNotices
            supabase={ctx.supabase}
            profileId={ctx.userId}
            companyId={ctx.membership.company_id}
          />
          <OfferOutcomes
            supabase={ctx.supabase}
            employeeId={employee.id}
            companyId={ctx.membership.company_id}
          />
          <OfferList
            supabase={ctx.supabase}
            employeeId={employee.id}
            companyId={ctx.membership.company_id}
          />
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        {quickLinks.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rounded-lg border bg-card p-3 text-center text-xs font-medium transition-colors hover:bg-secondary"
          >
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

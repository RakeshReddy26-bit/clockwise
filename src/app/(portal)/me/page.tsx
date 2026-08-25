import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NextShiftCard } from "@/components/next-shift-card";
import { OfferOutcomes } from "@/components/offer-outcomes";
import { RemovalNotices } from "@/components/removal-notices";

/**
 * The employee's landing page.
 *
 * Home answers "what do I need to do next?" and nothing else. The full offer
 * workspace and the shift history live in My shifts; duplicating them here
 * meant two adjacent tabs showed the same cards, with Home's list a strict
 * prefix of the other. What stays is what is genuinely attention: the next
 * shift, decisions that landed, and being taken off something.
 */
export const dynamic = "force-dynamic";

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

  // Open offers are a decision waiting on the employee, so Home says how many
  // and points at the page that can answer them — rather than reprinting the
  // cards that already live there.
  const { count: openOffers } = employee
    ? await ctx.supabase
        .from("shift_offer_responses")
        .select("id, shift_offers!inner(status)", { count: "exact", head: true })
        .eq("company_id", ctx.membership.company_id)
        .eq("employee_id", employee.id)
        .eq("shift_offers.status", "open")
    : { count: 0 };

  // Everything the bottom bar has no room for stays one tap away here.
  // `planned` marks the areas that are not part of this version, so nobody
  // taps one expecting a feature.
  const quickLinks = [
    { href: "/me/requests", label: tn("requests"), planned: false },
    { href: "/me/calendar", label: tn("calendar"), planned: true },
    { href: "/me/documents", label: tn("documents"), planned: true },
    { href: "/me/messages", label: tn("messages"), planned: true },
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
          {/* The next required action leads. Everything below it is context. */}
          <NextShiftCard supabase={ctx.supabase} employeeId={employee.id} />

          {(openOffers ?? 0) > 0 && (
            <Link
              href="/me/shifts"
              className="flex items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 transition-colors hover:bg-primary/10"
            >
              <span className="text-sm font-medium">
                {t("openOffers", { count: openOffers ?? 0 })}
              </span>
              <span className="text-xs font-medium text-primary">{t("openOffersAction")}</span>
            </Link>
          )}

          {/* Outcome after action: what happened to what they already answered. */}
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
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        {quickLinks.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="flex flex-col items-center gap-0.5 rounded-lg border bg-card p-3 text-center text-xs font-medium transition-colors hover:bg-secondary"
          >
            {l.label}
            {l.planned && (
              <span className="text-[10px] font-normal text-muted-foreground">
                {t("plannedTag")}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

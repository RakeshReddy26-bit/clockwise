import { getTranslations, getLocale } from "next-intl/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { localizeTerm, localizeSite } from "@/lib/taxonomy";
import { OfferCard, type OfferCardData } from "@/components/offer-card";
import type { ResponseState } from "@/lib/offer-transitions";

/**
 * The employee's shift offers, rendered identically on /me and /me/shifts.
 *
 * One server component rather than two page-local variants: the query, the
 * formatting and the card shape stay in one place, and each page decides only
 * whether to show it and under what heading.
 */

type ResponseRow = {
  id: string;
  response: string;
  decided_at: string | null;
  shift_offers: {
    status: string;
    message: string | null;
    shifts: {
      start_time: string;
      end_time: string;
      required_role: string | null;
      required_qualification: string | null;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    } | null;
  } | null;
};

export async function OfferList({
  supabase,
  employeeId,
  companyId,
  limit = 5,
}: {
  supabase: SupabaseClient;
  employeeId: string;
  companyId: string;
  limit?: number;
}) {
  const t = await getTranslations();
  const locale = await getLocale();

  // Only offers still open: a closed offer is history, not a decision the
  // employee can still make. RLS scopes this to their own rows regardless.
  const { data } = await supabase
    .from("shift_offer_responses")
    .select(
      "id, response, decided_at, shift_offers!inner(status, message, shifts(start_time, end_time, required_role, required_qualification, jobs(client_name, locations(name))))"
    )
    .eq("company_id", companyId)
    .eq("employee_id", employeeId)
    .eq("shift_offers.status", "open")
    .order("created_at", { ascending: false })
    .limit(limit);

  const rows = (data ?? []) as unknown as ResponseRow[];

  /**
   * An offer whose shift cannot be read is a bug, not an empty state.
   *
   * This previously dropped such rows silently, which turned a missing RLS
   * policy into a blank screen with nothing in the logs — the employee saw no
   * offers and no error, and every automated gate stayed green. Migration 0008
   * closed that particular gap; this stays as the tripwire for the next one.
   */
  const unreadable = rows.filter((row) => !row.shift_offers?.shifts);
  if (unreadable.length > 0) {
    console.error(
      `OfferList: ${unreadable.length} offer(s) resolved a response row but not the shift behind it — ` +
        `likely a missing SELECT policy on shifts/jobs for offered employees. ` +
        `employee_id=${employeeId} response_ids=${unreadable.map((r) => r.id).join(",")}`
    );
  }

  const offers: OfferCardData[] = rows
    .filter((row) => row.shift_offers?.shifts)
    .map((row) => {
      const offer = row.shift_offers!;
      const shift = offer.shifts!;
      const start = new Date(shift.start_time);
      const end = new Date(shift.end_time);
      const time = (d: Date) =>
        d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

      return {
        responseId: row.id,
        siteName: shift.jobs?.locations?.name
          ? localizeSite(shift.jobs.locations.name, (id) => t(id))
          : (shift.jobs?.client_name ?? "—"),
        clientName: shift.jobs?.locations?.name ? (shift.jobs?.client_name ?? null) : null,
        roleLabel: shift.required_role
          ? localizeTerm(shift.required_role, (id) => t(id))
          : null,
        requiredQualification: shift.required_qualification,
        dateLabel: start.toLocaleDateString(locale, {
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
        }),
        timeLabel: `${time(start)}–${time(end)}`,
        hours: Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 10) / 10,
        message: offer.message,
        response: row.response as ResponseState,
        offerOpen: offer.status === "open",
        decided: row.decided_at !== null,
      };
    });

  if (offers.length === 0 && unreadable.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-muted-foreground">
        {t("offers.sectionTitle", { count: offers.length })}
      </h2>
      {offers.map((offer) => (
        <OfferCard key={offer.responseId} offer={offer} />
      ))}

      {/*
        Tells the employee something is waiting for them and to ask dispatch,
        without naming a table or a policy. Better than a blank screen.
      */}
      {unreadable.length > 0 && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          {t("offers.unavailable", { count: unreadable.length })}
        </p>
      )}
    </section>
  );
}

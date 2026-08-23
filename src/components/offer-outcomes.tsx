import { getTranslations, getLocale } from "next-intl/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CheckCircle2, Info } from "lucide-react";
import { localizeSite } from "@/lib/taxonomy";

/**
 * What happened to the offers this employee answered.
 *
 * Without this the card simply vanished on approval: the offer closes, RLS
 * stops exposing it, and the list it lived in went empty with no explanation.
 * The employee's own response row stays readable either way, and once approved
 * they are assigned — so the shift becomes readable through the assignment.
 * That is enough to say plainly what was decided, with no schema or policy
 * change.
 *
 * Deliberately narrow: recent decisions only, no history feature, and the
 * assigned shift itself still lives in My shifts rather than being duplicated
 * here.
 */

/** How long a decision stays on Home before it is just old news. */
const RECENT_DAYS = 7;

type DecidedRow = {
  id: string;
  decided_at: string;
  resulting_assignment_id: string | null;
  shift_assignments: {
    shifts: {
      start_time: string;
      end_time: string;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    } | null;
  } | null;
};

export async function OfferOutcomes({
  supabase,
  employeeId,
  companyId,
}: {
  supabase: SupabaseClient;
  employeeId: string;
  companyId: string;
}) {
  const t = await getTranslations();
  const locale = await getLocale();

  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
  const { data } = await supabase
    .from("shift_offer_responses")
    .select(
      "id, decided_at, resulting_assignment_id, shift_assignments(shifts(start_time, end_time, jobs(client_name, locations(name))))"
    )
    .eq("company_id", companyId)
    .eq("employee_id", employeeId)
    .not("decided_at", "is", null)
    .gte("decided_at", since)
    .order("decided_at", { ascending: false })
    .limit(5);

  const rows = (data ?? []) as unknown as DecidedRow[];
  if (rows.length === 0) return null;

  const approved = rows.filter((row) => row.resulting_assignment_id !== null);
  const notSelected = rows.filter((row) => row.resulting_assignment_id === null);

  const time = (value: string) =>
    new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const date = (value: string) =>
    new Date(value).toLocaleDateString(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    });

  return (
    <section className="flex flex-col gap-2">
      {approved.map((row) => {
        const shift = row.shift_assignments?.shifts ?? null;
        const site = shift?.jobs?.locations?.name
          ? localizeSite(shift.jobs.locations.name, (id) => t(id))
          : (shift?.jobs?.client_name ?? null);

        return (
          <article
            key={row.id}
            className="flex gap-3 rounded-lg border border-success/40 bg-success/10 p-3"
          >
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
            <div className="min-w-0">
              <p className="font-medium text-success">{t("offers.approvedTitle")}</p>
              {shift && (
                <p className="text-sm">
                  {site} · <span className="tabular-nums">{date(shift.start_time)}</span>{" "}
                  <span className="tabular-nums">
                    {time(shift.start_time)}–{time(shift.end_time)}
                  </span>
                </p>
              )}
              <p className="text-xs text-muted-foreground">{t("offers.approvedWhereToFind")}</p>
            </div>
          </article>
        );
      })}

      {notSelected.length > 0 && (
        <article className="flex gap-3 rounded-lg border bg-card p-3">
          <Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="font-medium">{t("offers.notSelectedTitle")}</p>
            <p className="text-xs text-muted-foreground">
              {t("offers.notSelectedBody", { count: notSelected.length })}
            </p>
          </div>
        </article>
      )}
    </section>
  );
}

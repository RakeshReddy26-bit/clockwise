import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { VacationForm, SickForm, WithdrawButton } from "./absence-forms";

/**
 * The employee's own absences.
 *
 * Two lists and two forms, kept apart on the page because they are two
 * different things: one is a request somebody decides, the other is a fact
 * somebody records. Mixing them into one "absence" list would suggest a
 * manager can decline an illness.
 */
export const dynamic = "force-dynamic";

type VacationRow = {
  id: string;
  start_date: string;
  end_date: string;
  days_count: number;
  note: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
};

type SickRow = {
  id: string;
  start_date: string;
  expected_end_date: string | null;
  comment: string | null;
  status: string;
  created_at: string;
};

const VACATION_BADGE: Record<string, "warning" | "success" | "secondary"> = {
  pending: "warning",
  approved: "success",
  rejected: "secondary",
  cancelled: "secondary",
};

const SICK_BADGE: Record<string, "warning" | "success" | "secondary"> = {
  reported: "warning",
  confirmed: "success",
  closed: "secondary",
};

export default async function AbsencesPage() {
  const ctx = await getShellContext();
  const t = await getTranslations("absences");
  const locale = await getLocale();

  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("id")
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();

  // vacation_self_select / sick_self_select already scope these to the caller.
  const [{ data: vacationRows }, { data: sickRows }] = employee
    ? await Promise.all([
        ctx.supabase
          .from("vacation_requests")
          .select("id, start_date, end_date, days_count, note, status, created_at, decided_at")
          .eq("employee_id", employee.id)
          .order("start_date", { ascending: false })
          .limit(25),
        ctx.supabase
          .from("sick_leaves")
          .select("id, start_date, expected_end_date, comment, status, created_at")
          .eq("employee_id", employee.id)
          .order("start_date", { ascending: false })
          .limit(25),
      ])
    : [{ data: [] }, { data: [] }];

  const vacations = (vacationRows ?? []) as unknown as VacationRow[];
  const sickLeaves = (sickRows ?? []) as unknown as SickRow[];

  const fmtDate = (value: string) =>
    new Date(`${value}T00:00:00`).toLocaleDateString(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });

  const range = (start: string, end: string | null) =>
    end && end !== start ? `${fmtDate(start)} – ${fmtDate(end)}` : fmtDate(start);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">{t("intro")}</p>
      </div>

      {!employee ? (
        <EmptyState title={t("noEmployeeRecord")} />
      ) : (
        <>
          <VacationForm />

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">{t("myVacation")}</h2>
            {vacations.length === 0 ? (
              <p className="rounded-lg border border-dashed bg-card p-6 text-center text-xs text-muted-foreground">
                {t("noVacation")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {vacations.map((row) => (
                  <li key={row.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium tabular-nums">
                          {range(row.start_date, row.end_date)}
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {t("daysCount", { count: Number(row.days_count) })}
                        </p>
                      </div>
                      <Badge variant={VACATION_BADGE[row.status] ?? "secondary"}>
                        {t(`vacationStatus_${row.status}`)}
                      </Badge>
                    </div>

                    {row.note && (
                      <p className="rounded-md bg-secondary p-2 text-xs text-secondary-foreground">
                        {row.note}
                      </p>
                    )}

                    {row.status === "pending" && (
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] text-muted-foreground">{t("pendingHint")}</p>
                        <WithdrawButton requestId={row.id} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <SickForm />

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">{t("mySickLeave")}</h2>
            {sickLeaves.length === 0 ? (
              <p className="rounded-lg border border-dashed bg-card p-6 text-center text-xs text-muted-foreground">
                {t("noSickLeave")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {sickLeaves.map((row) => (
                  <li key={row.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-sm font-medium tabular-nums">
                        {row.expected_end_date
                          ? range(row.start_date, row.expected_end_date)
                          : t("openEnded", { from: fmtDate(row.start_date) })}
                      </p>
                      <Badge variant={SICK_BADGE[row.status] ?? "secondary"}>
                        {t(`sickStatus_${row.status}`)}
                      </Badge>
                    </div>
                    {row.comment && (
                      <p className="rounded-md bg-secondary p-2 text-xs text-secondary-foreground">
                        {row.comment}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

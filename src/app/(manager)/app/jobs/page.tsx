import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Badge } from "@/components/ui/badge";
import { SiteName } from "@/components/localized-term";
import { EmptyState } from "@/components/empty-state";
import { OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/eligibility";
import { shiftAttention } from "@/lib/shift-attention";

/**
 * Work orders, as an operational list.
 *
 * A job is the standing agreement with a client at a site; shifts are the work
 * it generates. So the useful view is not the job record — it is how much work
 * it is currently producing and whether that work is covered. Every column here
 * answers one of those two questions.
 *
 * Read-only by design. `jobs` has no create/update Server Action in this
 * codebase, and inventing one here would mean writing shift-adjacent business
 * logic outside the tested path. Jobs are created by the demo seeders today;
 * exposing a writer is its own piece of work.
 */
export const dynamic = "force-dynamic";

type JobRow = {
  id: string;
  client_name: string;
  description: string | null;
  status: string;
  locations: { name: string } | null;
};

type ShiftRow = {
  id: string;
  job_id: string;
  date: string;
  start_time: string;
  required_count: number;
  required_role: string | null;
  status: string;
};

const STATUS_BADGE: Record<string, "success" | "warning" | "secondary"> = {
  open: "warning",
  partially_staffed: "warning",
  fully_staffed: "success",
  in_progress: "success",
  completed: "secondary",
};

export default async function JobsPage() {
  const ctx = await getShellContext();
  const t = await getTranslations("jobs");
  const locale = await getLocale();
  const companyId = ctx.membership.company_id;
  const today = new Date().toISOString().slice(0, 10);

  const { data: jobRows } = await ctx.supabase
    .from("jobs")
    .select("id, client_name, description, status, locations(name)")
    .eq("company_id", companyId)
    .order("client_name")
    .limit(60);

  const jobs = (jobRows ?? []) as unknown as JobRow[];
  const jobIds = jobs.map((j) => j.id);

  // Upcoming shifts and their occupancy in two queries rather than per job.
  const [{ data: shiftRows }, { data: assignmentRows }] = jobIds.length
    ? await Promise.all([
        ctx.supabase
          .from("shifts")
          .select("id, job_id, date, start_time, required_count, required_role, status")
          .eq("company_id", companyId)
          .in("job_id", jobIds)
          .in("status", ["open", "staffed"])
          .gte("date", today)
          .order("start_time", { ascending: true })
          .limit(400),
        ctx.supabase
          .from("shift_assignments")
          .select("shift_id")
          .eq("company_id", companyId)
          .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES])
          .limit(1000),
      ])
    : [{ data: [] }, { data: [] }];

  const shifts = (shiftRows ?? []) as unknown as ShiftRow[];
  const filled = new Map<string, number>();
  for (const row of (assignmentRows ?? []) as Array<{ shift_id: string }>) {
    filled.set(row.shift_id, (filled.get(row.shift_id) ?? 0) + 1);
  }

  const byJob = new Map<string, ShiftRow[]>();
  for (const shift of shifts) {
    byJob.set(shift.job_id, [...(byJob.get(shift.job_id) ?? []), shift]);
  }

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">{t("intro")}</p>
      </div>

      {jobs.length === 0 ? (
        <EmptyState title={t("none")} body={t("noneBody")} />
      ) : (
        <div className="flex flex-col gap-2">
          {jobs.map((job) => {
            const jobShifts = byJob.get(job.id) ?? [];
            const openSeats = jobShifts.reduce((sum, s) => {
              const verdict = shiftAttention({
                filled: filled.get(s.id) ?? 0,
                requiredCount: s.required_count,
                hasOpenOffer: false,
              });
              return sum + verdict.openSeats;
            }, 0);
            const roles = [...new Set(jobShifts.map((s) => s.required_role).filter(Boolean))];
            const dates = jobShifts.map((s) => s.date);

            return (
              <article key={job.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{job.client_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {job.locations?.name ? (
                        <SiteName value={job.locations.name} />
                      ) : (
                        t("noSite")
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {openSeats > 0 && (
                      <Badge variant="destructive">{t("openSeats", { count: openSeats })}</Badge>
                    )}
                    <Badge variant={STATUS_BADGE[job.status] ?? "secondary"}>
                      {t(`status_${job.status}`)}
                    </Badge>
                  </div>
                </div>

                {job.description && (
                  <p className="text-xs text-muted-foreground">{job.description}</p>
                )}

                <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                  <dt className="text-muted-foreground">{t("upcomingShifts")}</dt>
                  <dd className="tabular-nums">{jobShifts.length}</dd>

                  {dates.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">{t("dateRange")}</dt>
                      <dd className="tabular-nums">
                        {fmtDate(dates[0])}
                        {dates.length > 1 ? ` – ${fmtDate(dates[dates.length - 1])}` : ""}
                      </dd>
                    </>
                  )}

                  {roles.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">{t("roles")}</dt>
                      <dd>{roles.join(", ")}</dd>
                    </>
                  )}
                </dl>

                {jobShifts.length > 0 && (
                  <Link
                    href={`/app/shifts?shift=${jobShifts[0].id}#shift-detail`}
                    className="self-start rounded-md border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    {t("openPlanning")}
                  </Link>
                )}
              </article>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">{t("readOnlyNote")}</p>
    </div>
  );
}

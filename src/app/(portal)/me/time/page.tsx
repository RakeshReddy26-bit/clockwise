import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Badge } from "@/components/ui/badge";
import { SiteName } from "@/components/localized-term";
import { EmptyState } from "@/components/empty-state";
import { formatMinutes, minutesBetween } from "@/lib/attendance";

/**
 * The employee's own recorded working time.
 *
 * Read-only, and no aggregation beyond a per-week total: this is not a
 * timesheet-approval feature, it is the answer to "did my clock-out register?".
 * The manager's view of the same data already lives at /app/time.
 */
export const dynamic = "force-dynamic";

type EntryRow = {
  id: string;
  clock_in: string;
  clock_out: string | null;
  status: string;
  clock_in_location_status: string | null;
  shift_assignments: {
    shifts: { jobs: { client_name: string; locations: { name: string } | null } | null } | null;
  } | null;
};

export default async function MyTimePage() {
  const ctx = await getShellContext();
  const t = await getTranslations("myTime");
  const locale = await getLocale();

  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("id")
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();

  // time_entries_self_select already scopes these rows to the caller.
  const { data } = employee
    ? await ctx.supabase
        .from("time_entries")
        .select(
          "id, clock_in, clock_out, status, clock_in_location_status, shift_assignments(shifts(jobs(client_name, locations(name))))"
        )
        .eq("employee_id", employee.id)
        .order("clock_in", { ascending: false })
        .limit(30)
    : { data: [] };

  const entries = (data ?? []) as unknown as EntryRow[];

  const totalMinutes = entries
    .filter((e) => e.clock_out)
    .reduce((sum, e) => sum + minutesBetween(new Date(e.clock_in), new Date(e.clock_out!)), 0);

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    });
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">{t("intro")}</p>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title={t("noneTitle")}
          body={t("noneBody")}
          action={{ href: "/me/shifts", label: t("toShifts") }}
        />
      ) : (
        <>
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">{t("recordedTotal")}</p>
            <p className="text-2xl font-semibold tabular-nums">{formatMinutes(totalMinutes)}</p>
          </div>

          <ul className="flex flex-col gap-2">
            {entries.map((entry) => {
              const job = entry.shift_assignments?.shifts?.jobs ?? null;
              const running = !entry.clock_out;
              return (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {job?.locations?.name ? (
                        <SiteName value={job.locations.name} />
                      ) : (
                        (job?.client_name ?? t("noSite"))
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {fmtDate(entry.clock_in)} · {fmtTime(entry.clock_in)}–
                      {entry.clock_out ? fmtTime(entry.clock_out) : "…"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {entry.clock_in_location_status === "outside_geofence" && (
                      <Badge variant="warning">{t("outsideSite")}</Badge>
                    )}
                    {running ? (
                      <Badge variant="success">{t("running")}</Badge>
                    ) : (
                      <span className="text-sm font-medium tabular-nums">
                        {formatMinutes(
                          minutesBetween(new Date(entry.clock_in), new Date(entry.clock_out!))
                        )}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

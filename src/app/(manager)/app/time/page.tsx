import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDistance } from "@/lib/geo";
import { SiteName } from "@/components/localized-term";
import { approveManualRequest, rejectManualRequest } from "./actions";

type EntryRow = {
  id: string;
  clock_in: string;
  clock_out: string | null;
  status: string;
  clock_in_location_status: string;
  clock_in_distance_m: number | null;
  employees: { full_name: string } | null;
  shift_assignments: {
    shifts: {
      start_time: string;
      end_time: string;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    } | null;
  } | null;
};

type RequestRow = {
  id: string;
  reason: string;
  reason_note: string | null;
  distance_m: number | null;
  created_at: string;
  employees: { full_name: string } | null;
};

type AttemptRow = {
  id: string;
  created_at: string;
  distance_m: number | null;
  allowed_radius_m: number | null;
  employees: { full_name: string } | null;
};

const FILTERS = ["all", "verified", "override", "unavailable", "not_required"] as const;
const FILTER_STATUS: Record<string, string> = {
  verified: "verified",
  override: "manager_override",
  unavailable: "unavailable",
  not_required: "not_required",
};

export default async function TimeBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const ctx = await getShellContext();
  const t = await getTranslations("timeBoard");
  const locale = await getLocale();
  const { filter = "all" } = await searchParams;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  let entryQuery = ctx.supabase
    .from("time_entries")
    .select(
      "id, clock_in, clock_out, status, clock_in_location_status, clock_in_distance_m, employees(full_name), shift_assignments(shifts(start_time, end_time, jobs(client_name, locations(name))))"
    )
    .eq("company_id", ctx.membership.company_id)
    .gte("clock_in", startOfDay.toISOString())
    .order("clock_in", { ascending: false })
    .limit(100);
  if (filter !== "all" && FILTER_STATUS[filter]) {
    entryQuery = entryQuery.eq("clock_in_location_status", FILTER_STATUS[filter]);
  }

  const [{ data: entries }, { data: requests }, { data: attempts }] = await Promise.all([
    entryQuery,
    ctx.supabase
      .from("manual_clockin_requests")
      .select("id, reason, reason_note, distance_m, created_at, employees(full_name)")
      .eq("company_id", ctx.membership.company_id)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    ctx.supabase
      .from("location_events")
      .select("id, created_at, distance_m, allowed_radius_m, employees(full_name)")
      .eq("company_id", ctx.membership.company_id)
      .eq("event_type", "clock_in_outside_geofence")
      .gte("created_at", startOfDay.toISOString())
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  const statusBadge = (status: string) => {
    switch (status) {
      case "verified":
        return <Badge variant="success">{t("statusVerified")} ✓</Badge>;
      case "manager_override":
        return <Badge variant="warning">{t("statusOverride")}</Badge>;
      case "outside_geofence":
        return <Badge variant="destructive">{t("statusOutside")} ⚠</Badge>;
      case "unavailable":
        return <Badge variant="secondary">{t("statusUnavailable")}</Badge>;
      default:
        return <Badge variant="secondary">{t("statusNotRequired")}</Badge>;
    }
  };

  const reasonLabel: Record<string, string> = {
    gps_inaccurate: t("reasonGps"),
    entrance_moved: t("reasonEntrance"),
    alternate_location: t("reasonAlternate"),
    manager_instructed: t("reasonInstructed"),
    other: t("reasonOther"),
  };

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>

      {(requests ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("pendingRequests")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {((requests ?? []) as unknown as RequestRow[]).map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="text-sm">
                  <p className="font-medium">{r.employees?.full_name ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">
                    {reasonLabel[r.reason] ?? r.reason}
                    {r.reason_note ? ` — ${r.reason_note}` : ""}
                    {r.distance_m != null ? ` · ${formatDistance(r.distance_m)}` : ""}
                    {` · ${fmtTime(r.created_at)}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <form action={approveManualRequest}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <Button size="sm" type="submit">{t("approve")}</Button>
                  </form>
                  <form action={rejectManualRequest}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <Button size="sm" variant="outline" type="submit">{t("reject")}</Button>
                  </form>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/app/time" : `/app/time?filter=${f}`}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f
                ? "border-transparent bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-secondary"
            )}
          >
            {t(`filter_${f}`)}
          </Link>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-secondary text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t("employee")}</th>
              <th className="px-3 py-2 font-medium">{t("site")}</th>
              <th className="px-3 py-2 font-medium">{t("shift")}</th>
              <th className="px-3 py-2 font-medium">{t("clockIn")}</th>
              <th className="px-3 py-2 font-medium">{t("locationStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {((entries ?? []) as unknown as EntryRow[]).length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  {t("noEntries")}
                </td>
              </tr>
            )}
            {((entries ?? []) as unknown as EntryRow[]).map((e) => {
              const shift = e.shift_assignments?.shifts;
              return (
                <tr key={e.id} className="border-b last:border-b-0">
                  <td className="px-3 py-2 font-medium">{e.employees?.full_name ?? "—"}</td>
                  <td className="px-3 py-2">
                    {shift?.jobs?.locations?.name ? (
                      <SiteName value={shift.jobs.locations.name} />
                    ) : (
                      (shift?.jobs?.client_name ?? "—")
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {shift ? `${fmtTime(shift.start_time)}–${fmtTime(shift.end_time)}` : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {fmtTime(e.clock_in)}
                    {e.clock_out ? ` – ${fmtTime(e.clock_out)}` : ""}
                    {!e.clock_out && (
                      <span className="ml-1.5 inline-block size-1.5 animate-pulse rounded-full bg-success align-middle" />
                    )}
                  </td>
                  <td className="px-3 py-2">{statusBadge(e.clock_in_location_status)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {((attempts ?? []) as unknown as AttemptRow[]).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("outsideAttempts")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {((attempts ?? []) as unknown as AttemptRow[]).map((a) => (
              <p key={a.id} className="text-sm">
                <span className="font-medium">{a.employees?.full_name ?? "—"}</span>{" "}
                <span className="text-muted-foreground">
                  {t("attemptLine", {
                    distance: a.distance_m != null ? formatDistance(a.distance_m) : "—",
                    time: fmtTime(a.created_at),
                  })}
                </span>
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

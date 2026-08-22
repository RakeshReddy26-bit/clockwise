import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Term } from "@/components/localized-term";
import { ClockInPanel } from "./clock-in-panel";

type AssignmentRow = {
  id: string;
  status: string;
  shifts: {
    id: string;
    start_time: string;
    end_time: string;
    required_role: string | null;
    instructions: string | null;
    contact_person: string | null;
    jobs: { client_name: string; location_id: string | null } | null;
  } | null;
};

export default async function MyShiftsPage() {
  const ctx = await getShellContext();
  const t = await getTranslations("myShifts");
  const locale = await getLocale();

  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("id")
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();

  if (!employee) {
    return <p className="text-sm text-muted-foreground">{t("noEmployeeRecord")}</p>;
  }

  const nowIso = new Date().toISOString();
  const { data: assignments } = await ctx.supabase
    .from("shift_assignments")
    .select(
      "id, status, shifts!inner(id, start_time, end_time, required_role, instructions, contact_person, jobs(client_name, location_id))"
    )
    .eq("employee_id", employee.id)
    .in("status", ["assigned", "accepted"])
    .gte("shifts.end_time", nowIso)
    .order("start_time", { referencedTable: "shifts", ascending: true })
    .limit(6);

  const list = (assignments ?? []) as unknown as AssignmentRow[];
  const current = list[0] ?? null;
  const upcoming = list.slice(1);

  let siteName: string | null = null;
  let address: string | null = null;
  let site = { lat: null as number | null, lng: null as number | null, radiusM: 100, enabled: false };
  if (current?.shifts?.jobs?.location_id) {
    const { data: location } = await ctx.supabase
      .from("locations")
      .select("name, address, lat, lng, geofence_radius_m, geofence_enabled")
      .eq("id", current.shifts.jobs.location_id)
      .maybeSingle();
    if (location) {
      siteName = location.name;
      address = location.address;
      site = {
        lat: location.lat,
        lng: location.lng,
        radiusM: location.geofence_radius_m,
        enabled: location.geofence_enabled,
      };
    }
  }

  const { data: runningEntry } = await ctx.supabase
    .from("time_entries")
    .select("id")
    .eq("employee_id", employee.id)
    .in("status", ["running", "on_break"])
    .limit(1)
    .maybeSingle();

  let hasPendingRequest = false;
  if (current) {
    const { data: pending } = await ctx.supabase
      .from("manual_clockin_requests")
      .select("id")
      .eq("shift_assignment_id", current.id)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    hasPendingRequest = !!pending;
  }

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "2-digit" });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>

      {!current ? (
        <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          {t("noShifts")}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <CardTitle>{t("currentShift")}</CardTitle>
              <Badge variant={current.status === "accepted" ? "success" : "secondary"}>
                {current.status === "accepted" ? t("accepted") : t("assigned")}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">{t("site")}</dt>
                <dd className="font-medium">{siteName ?? current.shifts?.jobs?.client_name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("role")}</dt>
                <dd className="font-medium">
                  <Term value={current.shifts?.required_role} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("time")}</dt>
                <dd className="font-medium tabular-nums">
                  {current.shifts
                    ? `${fmtDate(current.shifts.start_time)} · ${fmtTime(current.shifts.start_time)}–${fmtTime(current.shifts.end_time)}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("address")}</dt>
                <dd className="font-medium">{address ?? "—"}</dd>
              </div>
            </dl>
            {current.shifts?.instructions && (
              <p className="rounded-md bg-secondary p-2 text-xs text-secondary-foreground">
                {current.shifts.instructions}
              </p>
            )}

            <Separator />

            <ClockInPanel
              assignmentId={current.id}
              siteName={siteName}
              site={site}
              runningEntryId={runningEntry?.id ?? null}
              hasPendingRequest={hasPendingRequest}
            />
          </CardContent>
        </Card>
      )}

      {upcoming.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{t("upcoming")}</h2>
          {upcoming.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-lg border bg-card p-3 text-sm">
              <div>
                <p className="font-medium">{a.shifts?.jobs?.client_name ?? "—"}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {a.shifts
                    ? `${fmtDate(a.shifts.start_time)} · ${fmtTime(a.shifts.start_time)}–${fmtTime(a.shifts.end_time)}`
                    : ""}
                </p>
              </div>
              <Badge variant={a.status === "accepted" ? "success" : "secondary"}>
                {a.status === "accepted" ? t("accepted") : t("assigned")}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

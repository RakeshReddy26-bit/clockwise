import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Term, SiteName, localizedSite } from "@/components/localized-term";
import { OfferList } from "@/components/offer-list";
import { OfferOutcomes } from "@/components/offer-outcomes";
import { RemovalNotices } from "@/components/removal-notices";
import { ClockInPanel } from "./clock-in-panel";
import { CancelPanel } from "./cancel-panel";

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
  const tc = await getTranslations("cancellation");
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
    // 'cancellation_requested' stays in the list: the seat is still theirs
    // until a manager decides, and a shift that vanished the moment someone
    // asked to be released would be the same disappearing-card problem the
    // offer flow had.
    .in("status", ["assigned", "accepted", "cancellation_requested"])
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

  // Open cancellation requests for every listed assignment, in one query.
  const assignmentIds = list.map((a) => a.id);
  const { data: cancelRows } = assignmentIds.length
    ? await ctx.supabase
        .from("cancellation_requests")
        .select("shift_assignment_id")
        .in("shift_assignment_id", assignmentIds)
        .eq("status", "pending")
    : { data: [] };
  const pendingCancellation = new Set(
    ((cancelRows ?? []) as Array<{ shift_assignment_id: string }>).map(
      (r) => r.shift_assignment_id
    )
  );

  const statusBadge = (status: string) =>
    status === "cancellation_requested"
      ? { variant: "warning" as const, label: tc("badge") }
      : status === "accepted"
        ? { variant: "success" as const, label: t("accepted") }
        : { variant: "secondary" as const, label: t("assigned") };

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "2-digit" });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>

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
        limit={10}
      />

      {!current ? (
        <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          {t("noShifts")}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <CardTitle>{t("currentShift")}</CardTitle>
              <Badge variant={statusBadge(current.status).variant}>
                {statusBadge(current.status).label}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">{t("site")}</dt>
                <dd className="font-medium">
                  {siteName ? (
                    <SiteName value={siteName} />
                  ) : (
                    (current.shifts?.jobs?.client_name ?? "—")
                  )}
                </dd>
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

            {/*
              Above the clock-in panel on purpose. Below it, the action sat
              under the site map and the locate button — off the bottom of a
              phone screen, and easy to miss entirely.
            */}
            <CancelPanel
              assignmentId={current.id}
              hasPendingRequest={pendingCancellation.has(current.id)}
            />

            <Separator />

            <ClockInPanel
              assignmentId={current.id}
              siteName={await localizedSite(siteName)}
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
            <div
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 text-sm"
            >
              <div>
                <p className="font-medium">{a.shifts?.jobs?.client_name ?? "—"}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {a.shifts
                    ? `${fmtDate(a.shifts.start_time)} · ${fmtTime(a.shifts.start_time)}–${fmtTime(a.shifts.end_time)}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <CancelPanel
                  assignmentId={a.id}
                  hasPendingRequest={pendingCancellation.has(a.id)}
                />
                <Badge variant={statusBadge(a.status).variant}>
                  {statusBadge(a.status).label}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

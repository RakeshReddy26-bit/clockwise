import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMinutes, type AttendanceStatus } from "@/lib/attendance";
import { formatDistance } from "@/lib/geo";

export type BoardRow = {
  assignmentId: string;
  employeeName: string;
  siteName: string;
  departmentName: string | null;
  departmentId: string | null;
  locationId: string | null;
  role: string | null;
  scheduledStart: Date;
  scheduledEnd: Date;
  clockIn: Date | null;
  clockOut: Date | null;
  locationStatus: string | null;
  distanceM: number | null;
  status: AttendanceStatus;
  minutesLate: number | null;
};

export type BoardFilters = {
  site?: string;
  department?: string;
  status?: string;
  verification?: string;
};

const STATUS_TONE: Record<AttendanceStatus, "success" | "warning" | "destructive" | "secondary"> = {
  on_duty: "success",
  manual_override: "warning",
  outside_geofence: "destructive",
  late: "warning",
  no_show: "destructive",
  not_clocked_in: "secondary",
  upcoming: "secondary",
  clocked_out: "secondary",
};

function buildHref(current: BoardFilters, key: keyof BoardFilters, value: string) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) if (v && v !== "all") params.set(k, v);
  if (value === "all") params.delete(key);
  else params.set(key, value);
  const qs = params.toString();
  return qs ? `/app?${qs}` : "/app";
}

async function FilterGroup({
  label,
  paramKey,
  options,
  filters,
}: {
  label: string;
  paramKey: keyof BoardFilters;
  options: Array<{ value: string; label: string }>;
  filters: BoardFilters;
}) {
  const active = filters[paramKey] ?? "all";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {options.map((o) => (
        <Link
          key={o.value}
          href={buildHref(filters, paramKey, o.value)}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
            active === o.value
              ? "border-transparent bg-primary text-primary-foreground"
              : "bg-card text-muted-foreground hover:bg-secondary"
          )}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

export async function AttendanceBoard({
  rows,
  filters,
  sites,
  departments,
}: {
  rows: BoardRow[];
  filters: BoardFilters;
  sites: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
}) {
  const t = await getTranslations("ops");
  const locale = await getLocale();

  const time = (d: Date | null) =>
    d ? d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "—";

  const statusOptions = [
    "all",
    "on_duty",
    "late",
    "no_show",
    "not_clocked_in",
    "outside_geofence",
    "manual_override",
    "upcoming",
    "clocked_out",
  ].map((v) => ({ value: v, label: v === "all" ? t("filterAll") : t(`status_${v}`) }));

  const verificationOptions = ["all", "verified", "outside_geofence", "manager_override", "unavailable"].map(
    (v) => ({ value: v, label: v === "all" ? t("filterAll") : t(`verify_${v}`) })
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <FilterGroup
          label={t("filterSite")}
          paramKey="site"
          filters={filters}
          options={[{ value: "all", label: t("filterAll") }, ...sites.map((s) => ({ value: s.id, label: s.name }))]}
        />
        <FilterGroup
          label={t("filterDepartment")}
          paramKey="department"
          filters={filters}
          options={[
            { value: "all", label: t("filterAll") },
            ...departments.map((d) => ({ value: d.id, label: d.name })),
          ]}
        />
        <FilterGroup label={t("filterStatus")} paramKey="status" filters={filters} options={statusOptions} />
        <FilterGroup
          label={t("filterVerification")}
          paramKey="verification"
          filters={filters}
          options={verificationOptions}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-secondary text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t("colEmployee")}</th>
              <th className="px-3 py-2 font-medium">{t("colSite")}</th>
              <th className="px-3 py-2 font-medium">{t("colRole")}</th>
              <th className="px-3 py-2 font-medium">{t("colShift")}</th>
              <th className="px-3 py-2 font-medium">{t("colScheduled")}</th>
              <th className="px-3 py-2 font-medium">{t("colActual")}</th>
              <th className="px-3 py-2 font-medium">{t("colLocation")}</th>
              <th className="px-3 py-2 font-medium">{t("colStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  {t("boardEmpty")}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.assignmentId} className="border-b last:border-b-0">
                <td className="px-3 py-2 font-medium">{r.employeeName}</td>
                <td className="px-3 py-2">{r.siteName}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.role ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">
                  {time(r.scheduledStart)}–{time(r.scheduledEnd)}
                </td>
                <td className="px-3 py-2 tabular-nums">{time(r.scheduledStart)}</td>
                <td className="px-3 py-2 tabular-nums">
                  {time(r.clockIn)}
                  {r.clockOut && ` – ${time(r.clockOut)}`}
                  {!r.clockOut && r.clockIn && (
                    <span className="ml-1.5 inline-block size-1.5 animate-pulse rounded-full bg-success align-middle" />
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.locationStatus ? t(`verify_${r.locationStatus}`) : "—"}
                  {r.distanceM != null && r.locationStatus === "outside_geofence" && (
                    <span className="ml-1">({formatDistance(r.distanceM)})</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={STATUS_TONE[r.status]}>{t(`status_${r.status}`)}</Badge>
                  {r.minutesLate != null && r.minutesLate > 0 && (
                    <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
                      +{formatMinutes(r.minutesLate)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

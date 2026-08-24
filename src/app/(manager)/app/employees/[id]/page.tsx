import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { roleHas } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { SiteName } from "@/components/localized-term";
import { OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/eligibility";
import { accountState } from "@/lib/employee";
import { EmployeeForm, type Option } from "../employee-form";
import { StatusControl, QualificationEditor, type QualificationRow } from "../employee-controls";

/**
 * One employee.
 *
 * Editable: the employment record, the status, the qualifications. Read-only
 * context borrowed from modules that own it: upcoming shifts, absences,
 * availability.
 *
 * Not here at all: the emergency contact, which the employee maintains and
 * nobody browses; vacation balances, which nothing maintains; a time summary,
 * which does not exist yet. Adding any of them would turn this into an HRIS
 * page that is mostly wrong.
 */
export const dynamic = "force-dynamic";

type Employee = {
  id: string;
  company_id: string;
  employee_no: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  position: string | null;
  department_id: string | null;
  location_id: string | null;
  employment_status: string;
  contract_type: string;
  start_date: string | null;
  weekly_hours: number | null;
  hourly_rate: number | null;
  profile_id: string | null;
  locations: { name: string } | null;
};

const STATUS_BADGE: Record<string, "success" | "warning" | "secondary"> = {
  active: "success",
  probation: "warning",
  on_leave: "secondary",
  terminated: "secondary",
};

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await getShellContext();
  const t = await getTranslations("employees");
  const locale = await getLocale();
  const companyId = ctx.membership.company_id;
  const canManage = roleHas(ctx.membership.role, "employees.manage");
  const today = new Date().toISOString().slice(0, 10);

  const { data } = await ctx.supabase
    .from("employees")
    .select(
      "id, company_id, employee_no, full_name, email, phone, position, department_id, location_id, employment_status, contract_type, start_date, weekly_hours, hourly_rate, profile_id, locations(name)"
    )
    .eq("id", id)
    .maybeSingle();

  const employee = data as unknown as Employee | null;
  if (!employee || employee.company_id !== companyId) notFound();

  const [
    { data: departments },
    { data: locations },
    { data: qualifications },
    { data: availability },
    { data: assignments },
    { data: vacations },
    { data: sickLeaves },
    { data: membership },
  ] = await Promise.all([
    ctx.supabase.from("departments").select("id, name").eq("company_id", companyId).order("name"),
    ctx.supabase.from("locations").select("id, name").eq("company_id", companyId).order("name"),
    ctx.supabase
      .from("employee_qualifications")
      .select("id, name, issued_at, expires_at, status")
      .eq("employee_id", employee.id)
      .order("name"),
    ctx.supabase
      .from("employee_availability")
      .select("id, weekday, start_time, end_time, type, valid_from, valid_to")
      .eq("employee_id", employee.id)
      .order("weekday", { nullsFirst: true }),
    ctx.supabase
      .from("shift_assignments")
      .select("id, status, shifts!inner(id, date, start_time, end_time, jobs(client_name, locations(name)))")
      .eq("employee_id", employee.id)
      .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES])
      .gte("shifts.date", today)
      .order("date", { referencedTable: "shifts", ascending: true })
      .limit(10),
    ctx.supabase
      .from("vacation_requests")
      .select("id, start_date, end_date, status")
      .eq("employee_id", employee.id)
      .in("status", ["pending", "approved"])
      .gte("end_date", today)
      .order("start_date"),
    ctx.supabase
      .from("sick_leaves")
      .select("id, start_date, expected_end_date, status")
      .eq("employee_id", employee.id)
      .in("status", ["reported", "confirmed"])
      .order("start_date", { ascending: false }),
    employee.profile_id
      ? ctx.supabase
          .from("company_memberships")
          .select("status, role")
          .eq("company_id", companyId)
          .eq("profile_id", employee.profile_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const account = accountState(
    employee.profile_id,
    (membership as { status?: string } | null)?.status ?? null
  );

  const upcoming = (assignments ?? []) as unknown as Array<{
    id: string;
    status: string;
    shifts: {
      id: string;
      date: string;
      start_time: string;
      end_time: string;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    } | null;
  }>;

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const fmtDate = (value: string) =>
    new Date(`${value}T00:00:00`).toLocaleDateString(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link href="/app/employees" className="text-xs text-muted-foreground hover:underline">
          ← {t("title")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{employee.full_name}</h1>
          <Badge variant={STATUS_BADGE[employee.employment_status] ?? "secondary"}>
            {t(`status_${employee.employment_status}`)}
          </Badge>
          <span className="text-xs text-muted-foreground tabular-nums">
            {employee.employee_no} · {t(`account_${account}`)}
          </span>
        </div>
      </div>

      {canManage && (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
          <h2 className="text-sm font-semibold">{t("sectionStatus")}</h2>
          <StatusControl
            employeeId={employee.id}
            current={employee.employment_status}
            hasAccount={account === "active"}
          />
        </section>
      )}

      {canManage ? (
        <EmployeeForm
          employeeId={employee.id}
          departments={(departments ?? []) as Option[]}
          locations={(locations ?? []) as Option[]}
          initial={{
            employee_no: employee.employee_no,
            full_name: employee.full_name,
            email: employee.email ?? "",
            phone: employee.phone ?? "",
            position: employee.position ?? "",
            department_id: employee.department_id ?? "",
            location_id: employee.location_id ?? "",
            contract_type: employee.contract_type,
            start_date: employee.start_date ?? "",
            weekly_hours: employee.weekly_hours?.toString() ?? "",
            hourly_rate: employee.hourly_rate?.toString() ?? "",
          }}
        />
      ) : (
        <section className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm">
          <h2 className="text-sm font-semibold">{t("sectionEmployment")}</h2>
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <Row label={t("fieldContract")} value={t(`contract_${employee.contract_type}`)} />
            <Row label={t("fieldPosition")} value={employee.position} />
            <Row
              label={t("fieldSite")}
              value={employee.locations?.name ? <SiteName value={employee.locations.name} /> : null}
            />
            <Row label={t("fieldPhone")} value={employee.phone} />
          </dl>
          <p className="text-[11px] text-muted-foreground">{t("readOnlyIntro")}</p>
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-semibold">{t("sectionQualifications")}</h2>
        {canManage ? (
          <QualificationEditor
            employeeId={employee.id}
            rows={(qualifications ?? []) as QualificationRow[]}
          />
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {((qualifications ?? []) as QualificationRow[]).map((q) => (
              <li key={q.id}>
                {q.name}
                <span className="ml-2 text-muted-foreground tabular-nums">
                  {q.expires_at ? t("until", { date: q.expires_at }) : t("noExpiry")}
                </span>
              </li>
            ))}
            {(qualifications ?? []).length === 0 && (
              <li className="text-muted-foreground">{t("noQualifications")}</li>
            )}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-semibold">{t("sectionAvailability")}</h2>
        {/* Read-only here on purpose: the employee owns these rules. */}
        <p className="text-[11px] text-muted-foreground">{t("availabilityOwnedByEmployee")}</p>
        {(availability ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noAvailability")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {(
              (availability ?? []) as Array<{
                id: string;
                weekday: number | null;
                start_time: string | null;
                end_time: string | null;
                type: string;
              }>
            ).map((row) => (
              <li key={row.id} className="flex items-center gap-2">
                <Badge variant={row.type === "unavailable" ? "secondary" : "success"}>
                  {t(`availability_${row.type}`)}
                </Badge>
                <span className="tabular-nums">
                  {row.weekday === null ? t("everyDay") : t(`weekday_${WEEKDAY_KEYS[row.weekday]}`)}
                  {row.start_time ? ` · ${row.start_time.slice(0, 5)}` : ""}
                  {row.end_time ? `–${row.end_time.slice(0, 5)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-semibold">{t("sectionUpcoming")}</h2>
        {upcoming.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noUpcoming")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {upcoming.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/app/shifts?shift=${row.shifts?.id}`}
                  className="underline-offset-2 hover:underline"
                >
                  {row.shifts?.jobs?.locations?.name ? (
                    <SiteName value={row.shifts.jobs.locations.name} />
                  ) : (
                    (row.shifts?.jobs?.client_name ?? "—")
                  )}
                </Link>
                <span className="text-muted-foreground tabular-nums">
                  {row.shifts
                    ? `${fmtDate(row.shifts.date)} ${fmtTime(row.shifts.start_time)}–${fmtTime(row.shifts.end_time)}`
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-semibold">{t("sectionAbsences")}</h2>
        {(vacations ?? []).length === 0 && (sickLeaves ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noAbsences")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {(
              (vacations ?? []) as Array<{
                id: string;
                start_date: string;
                end_date: string;
                status: string;
              }>
            ).map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2">
                <span>{t("vacationLabel")}</span>
                <span className="text-muted-foreground tabular-nums">
                  {fmtDate(row.start_date)} – {fmtDate(row.end_date)} · {t(`absence_${row.status}`)}
                </span>
              </li>
            ))}
            {(
              (sickLeaves ?? []) as Array<{
                id: string;
                start_date: string;
                expected_end_date: string | null;
                status: string;
              }>
            ).map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2">
                <span>{t("sickLabel")}</span>
                <span className="text-muted-foreground tabular-nums">
                  {fmtDate(row.start_date)}
                  {row.expected_end_date ? ` – ${fmtDate(row.expected_end_date)}` : ""} ·{" "}
                  {t(`absence_${row.status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link href="/app/absences" className="text-[11px] text-muted-foreground hover:underline">
          {t("goToAbsences")} →
        </Link>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value ?? "—"}</dd>
    </>
  );
}

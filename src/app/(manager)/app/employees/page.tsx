import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { roleHas } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { SiteName } from "@/components/localized-term";
import { OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/eligibility";
import { accountState, expiresSoon, countsForDate } from "@/lib/employee";
import { EmptyState } from "@/components/empty-state";
import { EmployeeFilters } from "./employee-filters";

/**
 * The workforce, as an operational list rather than an HR dashboard.
 *
 * Every column answers a staffing question — can this person be scheduled, are
 * they already busy, is a certificate about to lapse, can they even log in yet.
 * Anything that would only be read once a year belongs on the detail page.
 */
export const dynamic = "force-dynamic";

type EmployeeRow = {
  id: string;
  employee_no: string;
  full_name: string;
  position: string | null;
  employment_status: string;
  contract_type: string;
  weekly_hours: number | null;
  profile_id: string | null;
  departments: { name: string } | null;
  locations: { name: string } | null;
};

const STATUS_BADGE: Record<string, "success" | "warning" | "secondary"> = {
  active: "success",
  probation: "warning",
  on_leave: "secondary",
  terminated: "secondary",
};

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const ctx = await getShellContext();
  const t = await getTranslations("employees");
  const params = await searchParams;
  const companyId = ctx.membership.company_id;
  const canManage = roleHas(ctx.membership.role, "employees.manage");
  const today = new Date().toISOString().slice(0, 10);

  let query = ctx.supabase
    .from("employees")
    .select(
      "id, employee_no, full_name, position, employment_status, contract_type, weekly_hours, profile_id, departments(name), locations(name)"
    )
    .eq("company_id", companyId)
    .order("employee_no", { ascending: true });

  if (params.status && params.status !== "all") query = query.eq("employment_status", params.status);
  if (params.q?.trim()) {
    const term = params.q.trim();
    query = query.or(`full_name.ilike.%${term}%,employee_no.ilike.%${term}%`);
  }

  const { data } = await query;
  const employees = (data ?? []) as unknown as EmployeeRow[];
  const ids = employees.map((e) => e.id);

  // Four batched lookups rather than four per row. The workforce is the whole
  // company, and an N+1 here would be felt on the first real tenant.
  const [{ data: assignments }, { data: qualifications }, { data: absences }, { data: memberships }] =
    ids.length > 0
      ? await Promise.all([
          ctx.supabase
            .from("shift_assignments")
            .select("employee_id, shifts!inner(date)")
            .eq("company_id", companyId)
            .in("employee_id", ids)
            .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES])
            .gte("shifts.date", today),
          ctx.supabase
            .from("employee_qualifications")
            .select("employee_id, status, expires_at")
            .eq("company_id", companyId)
            .in("employee_id", ids),
          ctx.supabase
            .from("vacation_requests")
            .select("employee_id")
            .eq("company_id", companyId)
            .eq("status", "approved")
            .in("employee_id", ids)
            .lte("start_date", today)
            .gte("end_date", today),
          ctx.supabase
            .from("company_memberships")
            .select("profile_id, status")
            .eq("company_id", companyId),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const upcomingBy = new Map<string, number>();
  for (const row of (assignments ?? []) as Array<{ employee_id: string }>) {
    upcomingBy.set(row.employee_id, (upcomingBy.get(row.employee_id) ?? 0) + 1);
  }

  const qualsBy = new Map<string, { valid: number; soon: number }>();
  for (const row of (qualifications ?? []) as Array<{
    employee_id: string;
    status: string;
    expires_at: string | null;
  }>) {
    const current = qualsBy.get(row.employee_id) ?? { valid: 0, soon: 0 };
    if (countsForDate({ status: row.status, expiresAt: row.expires_at }, today)) current.valid += 1;
    if (expiresSoon(row.expires_at, today)) current.soon += 1;
    qualsBy.set(row.employee_id, current);
  }

  const onLeaveToday = new Set((absences ?? []).map((r) => (r as { employee_id: string }).employee_id));
  const membershipStatus = new Map(
    ((memberships ?? []) as Array<{ profile_id: string; status: string }>).map((m) => [
      m.profile_id,
      m.status,
    ])
  );

  const localizedContract = (value: string) => t(`contract_${value}`);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-xs text-muted-foreground">
            {canManage ? t("intro") : t("readOnlyIntro")}
          </p>
        </div>
        {canManage && (
          <Link href="/app/employees/new" className={buttonVariants({ size: "sm" })}>
            {t("newEmployee")}
          </Link>
        )}
      </div>

      <EmployeeFilters status={params.status ?? "all"} q={params.q ?? ""} />

      {employees.length === 0 ? (
        <EmptyState
          title={t("none")}
          body={canManage ? t("noneBody") : undefined}
          action={canManage ? { href: "/app/employees/new", label: t("newEmployee") } : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="border-b bg-secondary/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-2 text-left font-medium">{t("colName")}</th>
                <th className="p-2 text-left font-medium">{t("colStatus")}</th>
                <th className="p-2 text-left font-medium">{t("colContract")}</th>
                <th className="p-2 text-left font-medium">{t("colSite")}</th>
                <th className="p-2 text-right font-medium">{t("colUpcoming")}</th>
                <th className="p-2 text-left font-medium">{t("colQualifications")}</th>
                <th className="p-2 text-left font-medium">{t("colAccount")}</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => {
                const quals = qualsBy.get(employee.id) ?? { valid: 0, soon: 0 };
                const account = accountState(
                  employee.profile_id,
                  employee.profile_id ? membershipStatus.get(employee.profile_id) ?? null : null
                );
                return (
                  <tr key={employee.id} className="border-b last:border-0 hover:bg-secondary/30">
                    <td className="p-2">
                      <Link
                        href={`/app/employees/${employee.id}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {employee.full_name}
                      </Link>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {employee.employee_no}
                        {employee.position ? ` · ${employee.position}` : ""}
                        {employee.departments?.name ? ` · ${employee.departments.name}` : ""}
                      </span>
                    </td>
                    <td className="p-2">
                      <Badge variant={STATUS_BADGE[employee.employment_status] ?? "secondary"}>
                        {t(`status_${employee.employment_status}`)}
                      </Badge>
                      {onLeaveToday.has(employee.id) && (
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          {t("awayToday")}
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      {localizedContract(employee.contract_type)}
                      {employee.weekly_hours != null && (
                        <span className="block text-muted-foreground tabular-nums">
                          {t("hoursPerWeek", { hours: Number(employee.weekly_hours) })}
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      {employee.locations?.name ? (
                        <SiteName value={employee.locations.name} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-2 text-right text-xs tabular-nums">
                      {upcomingBy.get(employee.id) ?? 0}
                    </td>
                    <td className="p-2 text-xs tabular-nums">
                      {quals.valid}
                      {quals.soon > 0 && (
                        <span className="ml-1 text-destructive">
                          {t("expiringCount", { count: quals.soon })}
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      <span className="text-muted-foreground">{t(`account_${account}`)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        {t("countSummary", { count: employees.length })}
      </p>
    </div>
  );
}

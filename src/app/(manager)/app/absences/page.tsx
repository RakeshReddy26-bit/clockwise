import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { roleHas } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/eligibility";
import { VacationDecision, SickDecision } from "./absence-decisions";

/**
 * Absences for the tenant.
 *
 * Everyone on staff can read this page — dispatch has to plan around absences,
 * and hiding them would just move the surprise to the day of the shift. Only
 * the decision controls are gated, and gating them is UX alignment, not
 * authorization: the Server Action requires `absence.decide`,
 * app.can_decide_absence() requires it again inside the SQL function, and the
 * table policies require it a third time.
 *
 * Conflicts are computed and shown BEFORE anyone clicks, so approving holiday
 * for someone who is still rostered is a visible situation rather than a
 * surprise refusal.
 */
export const dynamic = "force-dynamic";

type VacationRow = {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  days_count: number;
  note: string | null;
  status: string;
  created_at: string;
  employees: { full_name: string; employee_no: string } | null;
};

type SickRow = {
  id: string;
  employee_id: string;
  start_date: string;
  expected_end_date: string | null;
  status: string;
  employees: { full_name: string; employee_no: string } | null;
};

type AssignmentRow = {
  id: string;
  employee_id: string;
  shift_id: string;
  status: string;
  shifts: { date: string } | null;
};

export default async function AbsencesPage() {
  const ctx = await getShellContext();
  const t = await getTranslations("absences");
  const locale = await getLocale();
  const canDecide = roleHas(ctx.membership.role, "absence.decide");
  const companyId = ctx.membership.company_id;

  const [{ data: vacationRows }, { data: sickRows }] = await Promise.all([
    ctx.supabase
      .from("vacation_requests")
      .select(
        "id, employee_id, start_date, end_date, days_count, note, status, created_at, employees(full_name, employee_no)"
      )
      .eq("company_id", companyId)
      .in("status", ["pending", "approved"])
      .order("start_date", { ascending: true })
      .limit(50),
    ctx.supabase
      .from("sick_leaves")
      .select(
        "id, employee_id, start_date, expected_end_date, status, employees(full_name, employee_no)"
      )
      .eq("company_id", companyId)
      .in("status", ["reported", "confirmed"])
      .order("start_date", { ascending: false })
      .limit(50),
  ]);

  const vacations = (vacationRows ?? []) as unknown as VacationRow[];
  const sickLeaves = (sickRows ?? []) as unknown as SickRow[];

  // One query for every live assignment of everyone who appears on this page,
  // then matched in memory. The alternative — a query per row — is the same
  // answer at N times the cost.
  const employeeIds = [
    ...new Set([...vacations, ...sickLeaves].map((row) => row.employee_id)),
  ];
  let assignments: AssignmentRow[] = [];
  if (employeeIds.length > 0) {
    const { data } = await ctx.supabase
      .from("shift_assignments")
      .select("id, employee_id, shift_id, status, shifts!inner(date)")
      .eq("company_id", companyId)
      .in("employee_id", employeeIds)
      .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES]);
    assignments = (data ?? []) as unknown as AssignmentRow[];
  }

  /** Live assignments of one employee inside an inclusive, possibly open range. */
  const conflictsFor = (employeeId: string, start: string, end: string | null) =>
    assignments.filter((a) => {
      const date = a.shifts?.date;
      if (!date || a.employee_id !== employeeId) return false;
      return date >= start && (end === null || date <= end);
    });

  const fmtDate = (value: string) =>
    new Date(`${value}T00:00:00`).toLocaleDateString(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    });

  const range = (start: string, end: string | null) =>
    end && end !== start ? `${fmtDate(start)} – ${fmtDate(end)}` : fmtDate(start);

  const pending = vacations.filter((row) => row.status === "pending");
  const approved = vacations.filter((row) => row.status === "approved");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("managerTitle")}</h1>
        <p className="text-xs text-muted-foreground">
          {canDecide ? t("managerIntro") : t("readOnlyIntro")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("pendingVacation")}{" "}
            <span className="font-normal text-muted-foreground tabular-nums">
              ({pending.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {pending.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noPendingVacation")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((row) => {
                const conflicts = conflictsFor(row.employee_id, row.start_date, row.end_date);
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <p>
                        <span className="font-medium">{row.employees?.full_name ?? "—"}</span>{" "}
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {row.employees?.employee_no ?? ""}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {range(row.start_date, row.end_date)} ·{" "}
                        {t("daysCount", { count: Number(row.days_count) })}
                      </p>
                      {row.note && (
                        <p className="mt-1 rounded-md bg-secondary p-2 text-xs text-secondary-foreground">
                          {row.note}
                        </p>
                      )}
                      {conflicts.length > 0 && (
                        <p className="mt-1 text-xs text-destructive">
                          {t("conflictWarning", { count: conflicts.length })}
                        </p>
                      )}
                    </div>
                    {canDecide ? (
                      <VacationDecision
                        requestId={row.id}
                        employeeName={row.employees?.full_name ?? ""}
                      />
                    ) : (
                      <Badge variant="warning">{t("vacationStatus_pending")}</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("openSickLeave")}{" "}
            <span className="font-normal text-muted-foreground tabular-nums">
              ({sickLeaves.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{t("sickHint")}</p>
          {sickLeaves.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noSickLeaveOpen")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sickLeaves.map((row) => {
                const conflicts = conflictsFor(
                  row.employee_id,
                  row.start_date,
                  row.expected_end_date
                );
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <p>
                        <span className="font-medium">{row.employees?.full_name ?? "—"}</span>{" "}
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {row.employees?.employee_no ?? ""}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {row.expected_end_date
                          ? range(row.start_date, row.expected_end_date)
                          : t("openEnded", { from: fmtDate(row.start_date) })}
                      </p>
                      {conflicts.length > 0 && (
                        // Named as work for a human, not as an error: nobody is
                        // taken off a shift because they reported sick.
                        <p className="mt-1 text-xs text-destructive">
                          {t("sickConflictWarning", { count: conflicts.length })}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant={row.status === "confirmed" ? "success" : "warning"}>
                        {t(`sickStatus_${row.status}`)}
                      </Badge>
                      {canDecide && (
                        <SickDecision
                          sickLeaveId={row.id}
                          status={row.status}
                          employeeName={row.employees?.full_name ?? ""}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("approvedVacation")}{" "}
            <span className="font-normal text-muted-foreground tabular-nums">
              ({approved.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {approved.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noApprovedVacation")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {approved.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
                >
                  <span className="font-medium">{row.employees?.full_name ?? "—"}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {range(row.start_date, row.end_date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

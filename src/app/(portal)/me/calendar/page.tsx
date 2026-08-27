import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { MonthCalendar } from "@/components/month-calendar";
import { EmptyState } from "@/components/empty-state";
import { operatingDate } from "@/lib/ai/dates";
import { OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/eligibility";
import { monthOf, monthWindow, absenceDays, type CalendarEntry } from "@/lib/calendar";

/**
 * The employee's own month.
 *
 * Three sources, and the difference between them is the whole privacy story:
 * shifts and absences are filtered to THIS employee by an explicit
 * `employee_id` predicate on top of the self-scoped policies, while company
 * events are the one genuinely shared thing — `calendar_events` is readable by
 * any member by design, because a works meeting concerns everyone.
 *
 * A colleague's holiday is deliberately absent. The manager calendar shows it
 * because staffing depends on it; an employee has no such need.
 */
export const dynamic = "force-dynamic";

export default async function MyCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; kind?: string }>;
}) {
  const ctx = await getShellContext();
  const t = await getTranslations("calendar");
  const locale = await getLocale();
  const params = await searchParams;

  const now = new Date();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "")
    ? (params.month as string)
    : monthOf(operatingDate(now));
  const kind = (["shift", "absence", "event"] as const).find((k) => k === params.kind) ?? "all";
  const { from, to } = monthWindow(month);

  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("id")
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();

  if (!employee) return <EmptyState title={t("noEmployeeRecord")} />;

  const [{ data: assignments }, { data: vacations }, { data: sick }, { data: events }] =
    await Promise.all([
      ctx.supabase
        .from("shift_assignments")
        .select("id, shifts!inner(id, date, start_time, end_time, jobs(client_name, locations(name)))")
        .eq("employee_id", employee.id)
        .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES])
        .gte("shifts.date", from)
        .lte("shifts.date", to)
        .limit(120),
      ctx.supabase
        .from("vacation_requests")
        .select("id, start_date, end_date")
        .eq("employee_id", employee.id)
        .eq("status", "approved")
        .lte("start_date", to)
        .gte("end_date", from)
        .limit(50),
      ctx.supabase
        .from("sick_leaves")
        .select("id, start_date, expected_end_date")
        .eq("employee_id", employee.id)
        .in("status", ["reported", "confirmed"])
        .lte("start_date", to)
        .limit(50),
      ctx.supabase
        .from("calendar_events")
        .select("id, title, starts_at, ends_at")
        .eq("company_id", ctx.membership.company_id)
        .gte("starts_at", `${from}T00:00:00Z`)
        .lte("starts_at", `${to}T23:59:59Z`)
        .limit(100),
    ]);

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  const entries: CalendarEntry[] = [];

  for (const row of (assignments ?? []) as unknown as Array<{
    id: string;
    shifts: {
      id: string;
      date: string;
      start_time: string;
      end_time: string;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    } | null;
  }>) {
    if (!row.shifts) continue;
    entries.push({
      id: `shift:${row.id}`,
      kind: "shift",
      date: row.shifts.date,
      title: row.shifts.jobs?.locations?.name ?? row.shifts.jobs?.client_name ?? t("untitledShift"),
      timeLabel: `${time(row.shifts.start_time)}–${time(row.shifts.end_time)}`,
      href: "/me/shifts",
    });
  }

  for (const row of (vacations ?? []) as Array<{ id: string; start_date: string; end_date: string }>) {
    for (const day of absenceDays(row.start_date, row.end_date)) {
      entries.push({
        id: `vac:${row.id}:${day}`,
        kind: "absence",
        date: day,
        title: t("vacation"),
        timeLabel: null,
        href: "/me/absences",
      });
    }
  }

  for (const row of (sick ?? []) as Array<{
    id: string;
    start_date: string;
    expected_end_date: string | null;
  }>) {
    for (const day of absenceDays(row.start_date, row.expected_end_date)) {
      entries.push({
        id: `sick:${row.id}:${day}`,
        kind: "absence",
        date: day,
        title: t("sickLeave"),
        timeLabel: null,
        href: "/me/absences",
      });
    }
  }

  for (const row of (events ?? []) as Array<{
    id: string;
    title: string;
    starts_at: string;
    ends_at: string;
  }>) {
    entries.push({
      id: `event:${row.id}`,
      kind: "event",
      date: operatingDate(new Date(row.starts_at)),
      title: row.title,
      timeLabel: `${time(row.starts_at)}–${time(row.ends_at)}`,
      href: null,
    });
  }

  const filtered = kind === "all" ? entries : entries.filter((e) => e.kind === kind);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">{t("employeeIntro")}</p>
      </div>

      <MonthCalendar
        month={month}
        entries={filtered}
        basePath="/me/calendar"
        activeFilter={kind}
        now={now}
      />
    </div>
  );
}

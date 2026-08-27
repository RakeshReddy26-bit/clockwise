import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { MonthCalendar } from "@/components/month-calendar";
import { operatingDate } from "@/lib/ai/dates";
import {
  monthOf,
  monthWindow,
  absenceDays,
  type CalendarEntry,
} from "@/lib/calendar";

/**
 * The company month: shifts, absences and events on one grid.
 *
 * Every row is read through the caller's own client, so RLS decides what this
 * manager may see before the page does — `calendar_events` is member-readable,
 * absences and shifts follow their existing policies. The page adds no access
 * logic of its own.
 */
export const dynamic = "force-dynamic";

export default async function CalendarPage({
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
  const companyId = ctx.membership.company_id;

  const [{ data: shifts }, { data: vacations }, { data: sick }, { data: events }] =
    await Promise.all([
      ctx.supabase
        .from("shifts")
        .select("id, date, start_time, end_time, required_count, jobs(client_name, locations(name))")
        .eq("company_id", companyId)
        .in("status", ["open", "staffed", "in_progress", "completed"])
        .gte("date", from)
        .lte("date", to)
        .order("start_time", { ascending: true })
        .limit(400),
      ctx.supabase
        .from("vacation_requests")
        .select("id, start_date, end_date, status, employees(full_name)")
        .eq("company_id", companyId)
        .eq("status", "approved")
        .lte("start_date", to)
        .gte("end_date", from)
        .limit(200),
      ctx.supabase
        .from("sick_leaves")
        .select("id, start_date, expected_end_date, status, employees(full_name)")
        .eq("company_id", companyId)
        .in("status", ["reported", "confirmed"])
        .lte("start_date", to)
        .limit(200),
      ctx.supabase
        .from("calendar_events")
        .select("id, type, title, starts_at, ends_at")
        .eq("company_id", companyId)
        .gte("starts_at", `${from}T00:00:00Z`)
        .lte("starts_at", `${to}T23:59:59Z`)
        .order("starts_at", { ascending: true })
        .limit(200),
    ]);

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  const entries: CalendarEntry[] = [];

  for (const row of (shifts ?? []) as unknown as Array<{
    id: string;
    date: string;
    start_time: string;
    end_time: string;
    required_count: number;
    jobs: { client_name: string; locations: { name: string } | null } | null;
  }>) {
    entries.push({
      id: `shift:${row.id}`,
      kind: "shift",
      date: row.date,
      title: row.jobs?.locations?.name ?? row.jobs?.client_name ?? t("untitledShift"),
      timeLabel: `${time(row.start_time)}–${time(row.end_time)}`,
      href: `/app/shifts?shift=${row.id}#shift-detail`,
    });
  }

  for (const row of (vacations ?? []) as unknown as Array<{
    id: string;
    start_date: string;
    end_date: string;
    employees: { full_name: string } | null;
  }>) {
    for (const day of absenceDays(row.start_date, row.end_date)) {
      entries.push({
        id: `vac:${row.id}:${day}`,
        kind: "absence",
        date: day,
        title: row.employees?.full_name ?? "—",
        timeLabel: null,
        href: "/app/absences",
        detail: t("vacation"),
      });
    }
  }

  for (const row of (sick ?? []) as unknown as Array<{
    id: string;
    start_date: string;
    expected_end_date: string | null;
    employees: { full_name: string } | null;
  }>) {
    for (const day of absenceDays(row.start_date, row.expected_end_date)) {
      entries.push({
        id: `sick:${row.id}:${day}`,
        kind: "absence",
        date: day,
        title: row.employees?.full_name ?? "—",
        timeLabel: null,
        href: "/app/absences",
        detail: t("sickLeave"),
      });
    }
  }

  for (const row of (events ?? []) as unknown as Array<{
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
        <p className="text-xs text-muted-foreground">{t("managerIntro")}</p>
      </div>

      <MonthCalendar
        month={month}
        entries={filtered}
        basePath="/app/calendar"
        activeFilter={kind}
        now={now}
      />
    </div>
  );
}

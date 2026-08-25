import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CalendarClock, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { SiteName, Term } from "@/components/localized-term";
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  selectNextShift,
  nextShiftState,
  shiftDayLabel,
} from "@/lib/next-shift";

/**
 * "What do I need to do next?" — the answer, on the employee's landing page.
 *
 * Home is a summary, not a second copy of My shifts. This shows the one shift
 * that matters and sends the employee to the page that can act on it. The
 * clock-in panel is deliberately NOT duplicated here: it carries the geofence
 * preview, the map and the manual-request flow, and a second instance would be
 * a second place for that to drift. The server decides clock-in either way.
 */

type AssignmentRow = {
  id: string;
  status: string;
  shifts: {
    start_time: string;
    end_time: string;
    required_role: string | null;
    jobs: { client_name: string; locations: { name: string } | null } | null;
  } | null;
};

export async function NextShiftCard({
  supabase,
  employeeId,
}: {
  supabase: SupabaseClient;
  employeeId: string;
}) {
  const t = await getTranslations("nextShift");
  const locale = await getLocale();
  const now = new Date();

  // Same statuses and the same "has not ended yet" filter My shifts uses, so
  // the two pages can never name different shifts as the current one.
  const { data } = await supabase
    .from("shift_assignments")
    .select(
      "id, status, shifts!inner(start_time, end_time, required_role, jobs(client_name, locations(name)))"
    )
    .eq("employee_id", employeeId)
    .in("status", [...ACTIVE_ASSIGNMENT_STATUSES])
    .gte("shifts.end_time", now.toISOString())
    .order("start_time", { referencedTable: "shifts", ascending: true })
    .limit(5);

  const rows = (data ?? []) as unknown as AssignmentRow[];

  const picked = selectNextShift(
    rows.map((row) => ({
      row,
      shift: row.shifts
        ? { startTime: row.shifts.start_time, endTime: row.shifts.end_time }
        : null,
    })),
    now
  );

  if (!picked?.shift) {
    return (
      <section className="rounded-lg border border-dashed bg-card p-5 text-center">
        <p className="text-sm font-medium">{t("noneTitle")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("noneBody")}</p>
      </section>
    );
  }

  const row = picked.row;
  const shift = row.shifts!;

  // Only a fact: is an entry open right now. Whether they MAY clock in is the
  // server's decision, made in /me/shifts against the geofence.
  const { data: runningEntry } = await supabase
    .from("time_entries")
    .select("id")
    .eq("employee_id", employeeId)
    .in("status", ["running", "on_break"])
    .limit(1)
    .maybeSingle();

  const state = nextShiftState(picked.shift, !!runningEntry, now);
  const day = shiftDayLabel(shift.start_time, now);

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    });

  const site = shift.jobs?.locations?.name;
  const stateTone =
    state === "on_duty" ? "success" : state === "in_progress" ? "warning" : "secondary";

  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <CalendarClock className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("title")}</h2>
        </div>
        <Badge variant={stateTone}>{t(`state_${state}`)}</Badge>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-lg font-semibold tabular-nums">
          {day === "later" ? date(shift.start_time) : t(`day_${day}`)}
          {" · "}
          {time(shift.start_time)}–{time(shift.end_time)}
        </p>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <MapPin className="size-3.5 shrink-0" />
          <span className="truncate">
            {site ? <SiteName value={site} /> : (shift.jobs?.client_name ?? "—")}
          </span>
          {shift.required_role && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">
                <Term value={shift.required_role} />
              </span>
            </>
          )}
        </p>
      </div>

      <Link href="/me/shifts" className={buttonVariants({ size: "sm" })}>
        {t(state === "on_duty" ? "ctaOnDuty" : "ctaOpen")}
      </Link>
    </section>
  );
}

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { addMonths, buildMonthGrid, type CalendarEntry } from "@/lib/calendar";

/**
 * One month grid, shared by the manager and employee calendars.
 *
 * Both pages fetch very different rows — the manager sees the company, the
 * employee sees themselves — but the grid, the day arithmetic and the visual
 * language are the same, so they live here once. Filtering is a query-string
 * link rather than client state: it survives a reload, it is shareable, and it
 * needs no JavaScript.
 */

const KIND_TONE: Record<CalendarEntry["kind"], string> = {
  shift: "bg-primary/15 text-primary",
  absence: "bg-warning/15 text-warning",
  event: "bg-secondary text-secondary-foreground",
};

export async function MonthCalendar({
  month,
  entries,
  basePath,
  activeFilter,
  now = new Date(),
}: {
  month: string;
  entries: CalendarEntry[];
  /** Where the month and filter links point, e.g. "/app/calendar". */
  basePath: string;
  activeFilter: CalendarEntry["kind"] | "all";
  now?: Date;
}) {
  const t = await getTranslations("calendar");
  const cells = buildMonthGrid(month, entries, now);

  const monthLabel = new Date(`${month}-01T12:00:00Z`).toLocaleDateString(
    // Rendered server-side in the request locale by next-intl's formatter
    // elsewhere; here the month name comes from the translation table so the
    // two never disagree about capitalisation.
    "en-CA",
    { year: "numeric", month: "2-digit" }
  );

  const filterHref = (filter: string) =>
    `${basePath}?month=${month}${filter === "all" ? "" : `&kind=${filter}`}`;
  const monthHref = (delta: number) =>
    `${basePath}?month=${addMonths(month, delta)}${
      activeFilter === "all" ? "" : `&kind=${activeFilter}`
    }`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Link
            href={monthHref(-1)}
            aria-label={t("previousMonth")}
            className="rounded-md border bg-card p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </Link>
          <p className="min-w-28 text-center text-sm font-semibold tabular-nums">
            {t(`month_${month.slice(5)}`)} {month.slice(0, 4)}
          </p>
          <Link
            href={monthHref(1)}
            aria-label={t("nextMonth")}
            className="rounded-md border bg-card p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </Link>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {(["all", "shift", "absence", "event"] as const).map((filter) => (
            <Link
              key={filter}
              href={filterHref(filter)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                activeFilter === filter
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:bg-secondary"
              )}
            >
              {t(`filter_${filter}`)}
            </Link>
          ))}
        </div>
      </div>

      {/* The grid scrolls rather than squeezing: seven columns below ~640px
          would make each day narrower than a tap target. */}
      <div className="overflow-x-auto">
        <div className="min-w-[44rem]">
          <div className="grid grid-cols-7 gap-1 pb-1">
            {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => (
              <p key={day} className="px-1 text-[11px] font-medium text-muted-foreground">
                {t(`weekday_${day}`)}
              </p>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell) => (
              <div
                key={cell.date}
                className={cn(
                  "flex min-h-24 flex-col gap-1 rounded-md border p-1",
                  cell.inMonth ? "bg-card" : "bg-secondary/30",
                  cell.isToday && "border-primary"
                )}
              >
                <p
                  className={cn(
                    "px-0.5 text-[11px] tabular-nums",
                    cell.isToday ? "font-semibold text-primary" : "text-muted-foreground"
                  )}
                >
                  {Number(cell.date.slice(8))}
                </p>

                {cell.entries.slice(0, 3).map((entry) => {
                  const body = (
                    <>
                      <span className="block truncate font-medium">{entry.title}</span>
                      {entry.timeLabel && (
                        <span className="block truncate tabular-nums opacity-80">
                          {entry.timeLabel}
                        </span>
                      )}
                    </>
                  );
                  const className = cn(
                    "rounded px-1 py-0.5 text-[10px] leading-tight",
                    KIND_TONE[entry.kind]
                  );
                  return entry.href ? (
                    <Link key={entry.id} href={entry.href} className={cn(className, "hover:opacity-80")}>
                      {body}
                    </Link>
                  ) : (
                    <span key={entry.id} className={className}>
                      {body}
                    </span>
                  );
                })}

                {cell.entries.length > 3 && (
                  <p className="px-0.5 text-[10px] text-muted-foreground">
                    {t("andMore", { count: cell.entries.length - 3 })}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Keeps the month label available to assistive tech without repeating
          it visually — the heading above is decorative-adjacent. */}
      <p className="sr-only">{monthLabel}</p>
    </div>
  );
}

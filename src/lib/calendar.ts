/**
 * Month-grid arithmetic and event bucketing.
 *
 * Pure and clock-explicit. The manager and employee calendars render very
 * different things but must agree about which day a shift belongs to — and that
 * has to be the German calendar day the schedule is written in, the same one
 * migration 0011 derives `shifts.date` with. Getting it from the browser's zone
 * instead is how a 22:00 shift shows up on the wrong day.
 */

import { operatingDate, addDays, OPERATING_TIME_ZONE } from "@/lib/ai/dates";

export type CalendarEntryKind = "shift" | "absence" | "event";

export type CalendarEntry = {
  id: string;
  kind: CalendarEntryKind;
  /** 'YYYY-MM-DD' in the operating timezone. */
  date: string;
  title: string;
  /** 'HH:MM–HH:MM', or null for an all-day entry such as a holiday. */
  timeLabel: string | null;
  /** Where clicking it goes. Null when nothing useful to open. */
  href: string | null;
  /** Extra line, e.g. staffing or absence status. */
  detail?: string | null;
};

export type MonthCell = {
  date: string;
  inMonth: boolean;
  isToday: boolean;
  entries: CalendarEntry[];
};

/** 'YYYY-MM' for the month a date falls in. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** First day of a month as 'YYYY-MM-DD'. */
export function firstOfMonth(month: string): string {
  return `${month}-01`;
}

/** Shift a 'YYYY-MM' by whole months. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const index = total % 12;
  return `${year}-${String(index + 1).padStart(2, "0")}`;
}

/** Days in a month, without constructing a zoned date. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Monday-first weekday index (0 = Monday), the German convention. */
export function weekdayIndex(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * The month grid: whole weeks, Monday to Sunday, with leading and trailing days
 * from the neighbouring months so the grid is always rectangular.
 */
export function buildMonthGrid(
  month: string,
  entries: readonly CalendarEntry[],
  now: Date
): MonthCell[] {
  const today = operatingDate(now);
  const start = addDays(firstOfMonth(month), -weekdayIndex(firstOfMonth(month)));

  const byDate = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
  }

  // Six weeks always: a month can span six, and a grid that changes height
  // between months makes the whole page jump.
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const date = addDays(start, i);
    cells.push({
      date,
      inMonth: monthOf(date) === month,
      isToday: date === today,
      entries: sortEntries(byDate.get(date) ?? []),
    });
  }
  return cells;
}

/** Shifts first, then absences, then events; timed entries by time. */
export function sortEntries(entries: readonly CalendarEntry[]): CalendarEntry[] {
  const rank: Record<CalendarEntryKind, number> = { shift: 0, absence: 1, event: 2 };
  return [...entries].sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    return (a.timeLabel ?? "").localeCompare(b.timeLabel ?? "");
  });
}

/** Inclusive day list covering an absence, capped so one row cannot explode. */
export function absenceDays(start: string, end: string | null, max = 90): string[] {
  const last = end ?? start;
  const days: string[] = [];
  let cursor = start;
  while (cursor <= last && days.length < max) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** The instant window a month covers, for bounding queries. */
export function monthWindow(month: string): { from: string; to: string } {
  return { from: firstOfMonth(month), to: addDays(firstOfMonth(month), daysInMonth(month) - 1) };
}

export { OPERATING_TIME_ZONE };

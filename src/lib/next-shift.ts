/**
 * Which shift does the employee need to think about right now?
 *
 * Home and My shifts must never disagree about this, so the rule lives here
 * once instead of being re-expressed in two page queries. It is deliberately
 * the same rule /me/shifts already applied: the earliest assignment that has
 * not finished yet, among the statuses that still hold the employee's seat.
 *
 * Nothing in here decides whether clocking in is ALLOWED. That is a server
 * decision (geofence + eligibility) and stays there; this module only answers
 * "which one" and "has it started".
 */

/** Statuses where the seat is still the employee's. Mirrors /me/shifts. */
export const ACTIVE_ASSIGNMENT_STATUSES = [
  "assigned",
  "accepted",
  "cancellation_requested",
] as const;

export type ShiftTiming = {
  startTime: string | Date;
  endTime: string | Date;
};

const ms = (value: string | Date) =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

/**
 * The next shift the employee still has to work.
 *
 * "Next" means earliest start among shifts that have not ENDED — an overnight
 * shift already under way is the next thing they care about, not the one
 * starting tomorrow. Rows whose timing cannot be read are skipped rather than
 * crashing the page.
 */
export function selectNextShift<T extends { shift: ShiftTiming | null }>(
  rows: readonly T[],
  now: Date
): T | null {
  const nowMs = now.getTime();
  let best: T | null = null;
  let bestStart = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (!row.shift) continue;
    const end = ms(row.shift.endTime);
    const start = ms(row.shift.startTime);
    if (Number.isNaN(end) || Number.isNaN(start)) continue;
    if (end < nowMs) continue;
    if (start < bestStart) {
      best = row;
      bestStart = start;
    }
  }

  return best;
}

export type NextShiftState = "on_duty" | "in_progress" | "upcoming";

/**
 * What the employee is looking at, derived only from facts already in the
 * database: is a time entry running, and has the scheduled start passed.
 *
 * `on_duty`     — a time entry is open, they are clocked in.
 * `in_progress` — the shift has started and no entry is open (they may still
 *                 need to clock in; whether they MAY is the server's call).
 * `upcoming`    — the shift has not started.
 */
export function nextShiftState(
  shift: ShiftTiming,
  hasRunningEntry: boolean,
  now: Date
): NextShiftState {
  if (hasRunningEntry) return "on_duty";
  return ms(shift.startTime) <= now.getTime() ? "in_progress" : "upcoming";
}

export type DayLabel = "today" | "tomorrow" | "later";

/**
 * Calendar proximity, in the viewer's own day boundaries. Presentation only —
 * no scheduling rule depends on this.
 */
export function shiftDayLabel(start: string | Date, now: Date): DayLabel {
  const startDate = start instanceof Date ? new Date(start) : new Date(start);
  if (Number.isNaN(startDate.getTime())) return "later";

  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(startDate) - midnight(now)) / 86_400_000);

  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return "later";
}

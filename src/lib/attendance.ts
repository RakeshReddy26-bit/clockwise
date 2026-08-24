/**
 * Attendance engine — pure, deterministic, fully unit-tested.
 *
 * Nothing here touches the database or the clock: every function takes an
 * explicit `now`. That is what lets the same logic run from a dashboard
 * request, a Server Action, or a scheduled Railway cron job without change.
 */

export type AttendanceStatus =
  | "upcoming" // shift has not started (beyond grace)
  | "on_duty" // clocked in, still working
  | "late" // start + grace passed, not clocked in, below no-show threshold
  | "no_show" // start + noShow passed, never clocked in
  | "clocked_out" // completed entry
  | "outside_geofence" // clocked in but clock-in was outside the site
  | "manual_override" // clocked in via manager override
  | "not_clocked_in"; // shift started, inside grace, not yet clocked in

export type AttendanceThresholds = {
  graceMinutes: number;
  noShowMinutes: number;
  earlyClockOutToleranceMinutes: number;
};

export const DEFAULT_THRESHOLDS: AttendanceThresholds = {
  graceMinutes: 10,
  noShowMinutes: 45,
  earlyClockOutToleranceMinutes: 15,
};

/** Per-company thresholds from companies.settings.attendance, with defaults. */
export function attendanceThresholds(
  companySettings: Record<string, unknown> | null | undefined
): AttendanceThresholds {
  const a = (companySettings?.["attendance"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d;
  const graceMinutes = num(a["graceMinutes"], DEFAULT_THRESHOLDS.graceMinutes);
  // no-show must never fire before late
  const noShowMinutes = Math.max(
    graceMinutes,
    num(a["noShowMinutes"], DEFAULT_THRESHOLDS.noShowMinutes)
  );
  return {
    graceMinutes,
    noShowMinutes,
    earlyClockOutToleranceMinutes: num(
      a["earlyClockOutToleranceMinutes"],
      DEFAULT_THRESHOLDS.earlyClockOutToleranceMinutes
    ),
  };
}

export type AssignmentSnapshot = {
  assignmentId: string;
  employeeId: string;
  assignmentStatus: string; // assigned | accepted | cancellation_requested | cancelled | completed
  scheduledStart: Date;
  scheduledEnd: Date;
  clockIn: Date | null;
  clockOut: Date | null;
  clockInLocationStatus?: string | null; // verified | outside_geofence | manager_override | ...
};

const MINUTE = 60_000;

export function minutesBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / MINUTE);
}

/**
 * Assignments that no longer require attendance.
 *
 * THE INVARIANT: requesting a cancellation does not release the employee —
 * approving it does. Until a manager approves, the seat is still occupied and
 * the employee is still expected on site, so 'cancellation_requested' is an
 * ACTIVE status here. Treating it as inactive silently suppressed late and
 * no-show alerts for exactly the people most likely to not turn up, while the
 * shift still counted as staffed.
 *
 * The same invariant holds in staffing (recalc_shift_staffing counts it as
 * occupying), clock-in (the employee may still clock in), the manager day
 * board, offer approval (approve_shift_offer counts it toward capacity) and
 * the replacement flow. All six must agree.
 */
export function isInactiveAssignment(status: string): boolean {
  return status === "cancelled";
}

/** Current operational status of one assignment. */
export function attendanceStatus(
  snap: AssignmentSnapshot,
  thresholds: AttendanceThresholds,
  now: Date
): AttendanceStatus {
  if (snap.clockOut) return "clocked_out";

  if (snap.clockIn) {
    if (snap.clockInLocationStatus === "manager_override") return "manual_override";
    if (snap.clockInLocationStatus === "outside_geofence") return "outside_geofence";
    return "on_duty";
  }

  const minutesAfterStart = minutesBetween(now, snap.scheduledStart);
  if (minutesAfterStart < 0) return "upcoming";
  if (minutesAfterStart >= thresholds.noShowMinutes) return "no_show";
  if (minutesAfterStart >= thresholds.graceMinutes) return "late";
  return "not_clocked_in";
}

export type AlertDecision =
  | { type: "late_clock_in"; minutesDelta: number }
  | { type: "no_show"; minutesDelta: number }
  | { type: "early_clock_out"; minutesDelta: number };

/**
 * Which alerts SHOULD exist for this assignment right now.
 *
 * Idempotency contract: this returns the full desired set every time; the
 * persistence layer upserts on (shift_assignment_id, type), so running the
 * evaluation once or a hundred times produces the same rows. Escalation is
 * additive — a no-show assignment keeps its earlier late alert rather than
 * rewriting history.
 */
export function evaluateAlerts(
  snap: AssignmentSnapshot,
  thresholds: AttendanceThresholds,
  now: Date
): AlertDecision[] {
  if (isInactiveAssignment(snap.assignmentStatus)) return [];

  const decisions: AlertDecision[] = [];

  if (!snap.clockIn) {
    const minutesAfterStart = minutesBetween(now, snap.scheduledStart);
    if (minutesAfterStart >= thresholds.graceMinutes) {
      decisions.push({ type: "late_clock_in", minutesDelta: minutesAfterStart });
    }
    if (minutesAfterStart >= thresholds.noShowMinutes) {
      decisions.push({ type: "no_show", minutesDelta: minutesAfterStart });
    }
    return decisions;
  }

  // Clocked in late, then arrived: the late alert still stands as a record.
  const lateBy = minutesBetween(snap.clockIn, snap.scheduledStart);
  if (lateBy >= thresholds.graceMinutes) {
    decisions.push({ type: "late_clock_in", minutesDelta: lateBy });
  }

  if (snap.clockOut) {
    const earlyBy = minutesBetween(snap.scheduledEnd, snap.clockOut);
    if (earlyBy > thresholds.earlyClockOutToleranceMinutes) {
      decisions.push({ type: "early_clock_out", minutesDelta: earlyBy });
    }
  }

  return decisions;
}

/** "1h 15m" / "22m" — used in alert copy and the board. */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export type KpiCounts = {
  onDuty: number;
  late: number;
  noShow: number;
  outsideSite: number;
  manualOverride: number;
  clockedOut: number;
  upcoming: number;
  scheduled: number;
};

/** KPI roll-up from already-derived statuses. */
export function summarize(statuses: AttendanceStatus[]): KpiCounts {
  const counts: KpiCounts = {
    onDuty: 0,
    late: 0,
    noShow: 0,
    outsideSite: 0,
    manualOverride: 0,
    clockedOut: 0,
    upcoming: 0,
    scheduled: statuses.length,
  };
  for (const s of statuses) {
    if (s === "on_duty") counts.onDuty++;
    else if (s === "late" || s === "not_clocked_in") counts.late += s === "late" ? 1 : 0;
    if (s === "no_show") counts.noShow++;
    if (s === "outside_geofence") {
      counts.outsideSite++;
      counts.onDuty++; // still physically working, flagged
    }
    if (s === "manual_override") {
      counts.manualOverride++;
      counts.onDuty++;
    }
    if (s === "clocked_out") counts.clockedOut++;
    if (s === "upcoming") counts.upcoming++;
  }
  return counts;
}

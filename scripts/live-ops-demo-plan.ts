/**
 * The live operations demo scenario — pure data, no side effects, no clock.
 *
 * WHY THIS EXISTS
 *
 * The Kiel dataset seeds shifts at `dayOffset >= 1`. That is correct for a
 * schedule, but a demo tenant seeded last week has all of those shifts in the
 * past today, with nobody clocked in — so the operations board honestly reports
 * "0 on duty, 10 no-show". Technically right, and useless to show anyone.
 *
 * This plan anchors a single day's operation to `now` in MINUTES, so the board
 * tells the same story whenever it is generated. Nothing about the dashboard
 * changes: it still derives every number from real shifts, assignments and time
 * entries. What changes is that those rows describe a plausible morning.
 *
 * The plan is separated from the writer so the KPI mix can be asserted in a
 * unit test rather than discovered during a demo. `expectedKpis()` below is the
 * contract; tests/unit/live-ops-demo-plan.test.ts holds it to it.
 */

import { attendanceStatus, type AttendanceStatus, type AttendanceThresholds } from "../src/lib/attendance";

/** How a seeded person is attending, expressed as data rather than a status. */
export type AttendanceIntent =
  /** Clocked in inside the geofence and still working. */
  | { kind: "on_duty"; clockInOffsetMin: number }
  /** Clocked in, but the fix was outside the allowed radius. */
  | { kind: "outside_geofence"; clockInOffsetMin: number; distanceM: number }
  /** Shift started, no clock-in yet, still inside the no-show threshold. */
  | { kind: "late" }
  /** Shift started long enough ago that nobody expects them now. */
  | { kind: "no_show" }
  /** Worked and went home. */
  | { kind: "clocked_out"; clockInOffsetMin: number; clockOutOffsetMin: number }
  /** Assigned to a shift that has not started. */
  | { kind: "upcoming" };

export type DemoAssignment = {
  /** Index into the demo crew, resolved to a real employee by the writer. */
  crew: number;
  intent: AttendanceIntent;
  /**
   * This person has a manual clock-in request waiting for a decision. Set on a
   * late arrival, because that is the situation the feature exists for: the
   * geofence would not verify them and they asked a human to let them in.
   */
  pendingManualRequest?: { reason: string; note: string; minutesAgo: number };
};

export type DemoShift = {
  key: string;
  clientName: string;
  siteName: string;
  role: string;
  /** Minutes relative to now. Negative means already started. */
  startOffsetMin: number;
  endOffsetMin: number;
  requiredCount: number;
  assignments: DemoAssignment[];
};

const HOUR = 60;

/**
 * One morning at KSK.
 *
 * Read it top to bottom and you have the demo: a big cruise turnaround that is
 * one person short and has a no-show, a smaller quay with a late arrival who
 * cannot get the geofence to verify, a shift about to end, and work still to
 * come. Every number the board shows is a consequence of these rows.
 */
export const LIVE_OPS_SHIFTS: DemoShift[] = [
  {
    // The hero shift: understaffed AND carrying a no-show, so the replacement
    // workflow has something real to fix.
    key: "ostseekai-turnaround",
    clientName: "Ostsee Terminal Services",
    siteName: "Ostseekai Cruise Terminal",
    role: "Terminalmitarbeiter/in",
    startOffsetMin: -3 * HOUR,
    endOffsetMin: 5 * HOUR,
    requiredCount: 8, // 7 assigned → one seat open
    assignments: [
      { crew: 0, intent: { kind: "on_duty", clockInOffsetMin: -3 * HOUR + 4 } },
      { crew: 1, intent: { kind: "on_duty", clockInOffsetMin: -3 * HOUR + 2 } },
      { crew: 2, intent: { kind: "on_duty", clockInOffsetMin: -3 * HOUR - 3 } },
      { crew: 3, intent: { kind: "on_duty", clockInOffsetMin: -3 * HOUR + 9 } },
      {
        crew: 4,
        intent: { kind: "outside_geofence", clockInOffsetMin: -3 * HOUR + 6, distanceM: 412 },
      },
      { crew: 5, intent: { kind: "clocked_out", clockInOffsetMin: -3 * HOUR, clockOutOffsetMin: -25 } },
      // The person the whole demo is about.
      { crew: 6, intent: { kind: "no_show" } },
    ],
  },
  {
    key: "schwedenkai-service",
    clientName: "Ostsee Terminal Services",
    siteName: "Schwedenkai",
    role: "Servicekraft",
    startOffsetMin: -25,
    endOffsetMin: 7 * HOUR,
    requiredCount: 2,
    assignments: [
      { crew: 7, intent: { kind: "on_duty", clockInOffsetMin: -22 } },
      {
        crew: 8,
        intent: { kind: "late" },
        pendingManualRequest: {
          reason: "gps_inaccurate",
          note: "GPS zeigt mich am Nachbarkai. Ich stehe am Serviceeingang.",
          minutesAgo: 6,
        },
      },
    ],
  },
  {
    // Ends within the two-hour window the board calls "ending soon".
    key: "ostuferhafen-early",
    clientName: "Kiel Port Logistics",
    siteName: "Ostuferhafen Terminal",
    role: "Logistikmitarbeiter/in",
    startOffsetMin: -6 * HOUR - 40,
    endOffsetMin: HOUR,
    requiredCount: 2,
    assignments: [
      { crew: 9, intent: { kind: "on_duty", clockInOffsetMin: -6 * HOUR - 38 } },
      { crew: 10, intent: { kind: "on_duty", clockInOffsetMin: -6 * HOUR - 41 } },
    ],
  },
  {
    // Later today, still short — an open shift the manager can fill.
    key: "norwegenkai-afternoon",
    clientName: "Ostsee Terminal Services",
    siteName: "Norwegenkai",
    role: "Terminalmitarbeiter/in",
    startOffsetMin: 4 * HOUR,
    endOffsetMin: 12 * HOUR,
    requiredCount: 3,
    assignments: [{ crew: 11, intent: { kind: "upcoming" } }],
  },
  {
    key: "hauptbahnhof-evening",
    clientName: "Bahnhofsservice Kiel",
    siteName: "Kiel Hauptbahnhof / Hafen Transfer",
    role: "Reinigungskraft",
    startOffsetMin: 7 * HOUR,
    endOffsetMin: 13 * HOUR,
    requiredCount: 2,
    assignments: [
      { crew: 12, intent: { kind: "upcoming" } },
      { crew: 13, intent: { kind: "upcoming" } },
    ],
  },
  {
    // Nobody assigned at all: the second open shift.
    key: "port-parking-night",
    clientName: "Fördeparken Kiel GmbH",
    siteName: "Port Parking Kiel",
    role: "Parkservice-Mitarbeiter/in",
    startOffsetMin: 10 * HOUR,
    endOffsetMin: 18 * HOUR,
    requiredCount: 2,
    assignments: [],
  },
];

/** Distinct crew slots the plan needs; the writer resolves this many people. */
export const LIVE_OPS_CREW_SIZE = 14;

/** Hero replacement scenario used by the demo. */
export const HERO_SHIFT_KEY = "ostseekai-turnaround";

/**
 * Employees intentionally kept off today's roster so the normal
 * eligibility engine can return real replacement candidates.
 */
export const RESERVE_SIZE = 4;

/** Role required by the hero shift. */
export function heroShiftRole(): string {
  const hero = LIVE_OPS_SHIFTS.find((s) => s.key === HERO_SHIFT_KEY);
  if (!hero) throw new Error(`hero shift "${HERO_SHIFT_KEY}" is missing from the plan`);
  return hero.role;
}

/* ------------------------------------------------------------------ */
/* Derivations — used by the writer and asserted by the tests          */
/* ------------------------------------------------------------------ */

/** The clock-in an intent implies, or null when the person never arrived. */
export function clockInFor(intent: AttendanceIntent): number | null {
  switch (intent.kind) {
    case "on_duty":
    case "outside_geofence":
    case "clocked_out":
      return intent.clockInOffsetMin;
    default:
      return null;
  }
}

export function clockOutFor(intent: AttendanceIntent): number | null {
  return intent.kind === "clocked_out" ? intent.clockOutOffsetMin : null;
}

/** The `clock_in_location_status` column value an intent implies. */
export function locationStatusFor(intent: AttendanceIntent): string | null {
  if (intent.kind === "outside_geofence") return "outside_geofence";
  return clockInFor(intent) === null ? null : "verified";
}

/**
 * What the attendance engine will say about this person.
 *
 * Deliberately computed by calling the real engine rather than by restating its
 * rules: if the thresholds or the state machine ever change, this plan's
 * expectations move with them instead of quietly disagreeing.
 */
export function statusFor(
  shift: DemoShift,
  assignment: DemoAssignment,
  thresholds: AttendanceThresholds
): AttendanceStatus {
  const now = new Date(0);
  const at = (offsetMin: number | null) =>
    offsetMin === null ? null : new Date(offsetMin * 60_000);

  return attendanceStatus(
    {
      assignmentId: `${shift.key}:${assignment.crew}`,
      employeeId: String(assignment.crew),
      assignmentStatus: "assigned",
      scheduledStart: new Date(shift.startOffsetMin * 60_000),
      scheduledEnd: new Date(shift.endOffsetMin * 60_000),
      clockIn: at(clockInFor(assignment.intent)),
      clockOut: at(clockOutFor(assignment.intent)),
      clockInLocationStatus: locationStatusFor(assignment.intent),
    },
    thresholds,
    now
  );
}

export type ExpectedKpis = {
  scheduled: number;
  onDuty: number;
  late: number;
  noShow: number;
  outsideSite: number;
  clockedOut: number;
  upcoming: number;
  /** Shifts with an unfilled seat. */
  understaffed: number;
  /** on_duty people whose shift ends within two hours. */
  endingSoon: number;
  pendingManualRequests: number;
};

/**
 * The operational picture this plan produces.
 *
 * The dashboard computes these independently from database rows; this function
 * computes them from the plan. A test asserting they agree is what stops the
 * demo drifting into "0 on duty" again without anyone noticing.
 */
export function expectedKpis(thresholds: AttendanceThresholds): ExpectedKpis {
  const kpis: ExpectedKpis = {
    scheduled: 0,
    onDuty: 0,
    late: 0,
    noShow: 0,
    outsideSite: 0,
    clockedOut: 0,
    upcoming: 0,
    understaffed: 0,
    endingSoon: 0,
    pendingManualRequests: 0,
  };

  for (const shift of LIVE_OPS_SHIFTS) {
    if (shift.assignments.length < shift.requiredCount) kpis.understaffed += 1;

    for (const assignment of shift.assignments) {
      kpis.scheduled += 1;
      if (assignment.pendingManualRequest) kpis.pendingManualRequests += 1;

      const status = statusFor(shift, assignment, thresholds);

      // Mirror summarize() exactly, including its judgement that somebody
      // flagged outside the geofence is still physically at work: they are on
      // duty AND they are a problem, and the board counts them in both places.
      if (status === "on_duty" || status === "outside_geofence" || status === "manual_override") {
        kpis.onDuty += 1;
      }
      if (status === "late") kpis.late += 1;
      if (status === "no_show") kpis.noShow += 1;
      if (status === "outside_geofence") kpis.outsideSite += 1;
      if (status === "clocked_out") kpis.clockedOut += 1;
      if (status === "upcoming") kpis.upcoming += 1;

      // "Ending soon" is the board's own narrower definition: cleanly on duty,
      // finishing within two hours.
      if (status === "on_duty" && shift.endOffsetMin > 0 && shift.endOffsetMin <= 120) {
        kpis.endingSoon += 1;
      }
    }
  }

  return kpis;
}

/** Shifts that will still be open for staffing when the board loads. */
export function openShiftCount(): number {
  return LIVE_OPS_SHIFTS.filter(
    (s) => s.startOffsetMin > 0 && s.assignments.length < s.requiredCount
  ).length;
}

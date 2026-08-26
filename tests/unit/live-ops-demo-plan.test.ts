import { describe, it, expect } from "vitest";
import {
  LIVE_OPS_SHIFTS,
  LIVE_OPS_CREW_SIZE,
  expectedKpis,
  openShiftCount,
  statusFor,
  clockInFor,
  clockOutFor,
  locationStatusFor,
} from "../../scripts/live-ops-demo-plan";
import { DEFAULT_THRESHOLDS, summarize, type AttendanceStatus } from "@/lib/attendance";

/**
 * The demo scenario, held to its own contract.
 *
 * A demo tenant that quietly drifts into "0 on duty, 10 no-show" is worse than
 * no demo at all, and the drift is invisible until somebody opens the board in
 * front of a customer. These tests are the tripwire: they assert the plan still
 * produces a believable morning, using the real attendance engine rather than a
 * restatement of its rules.
 */

const T = DEFAULT_THRESHOLDS;

describe("the demo produces a realistic operational picture", () => {
  const kpis = expectedKpis(T);

  it("has people on duty, in the range a manager would expect", () => {
    expect(kpis.onDuty).toBeGreaterThanOrEqual(4);
    expect(kpis.onDuty).toBeLessThanOrEqual(8);
  });

  it("has exactly one late arrival and one no-show", () => {
    expect(kpis.late).toBe(1);
    expect(kpis.noShow).toBe(1);
  });

  it("has exactly one clock-in outside the geofence", () => {
    expect(kpis.outsideSite).toBe(1);
  });

  it("has exactly one manual clock-in request waiting", () => {
    expect(kpis.pendingManualRequests).toBe(1);
  });

  it("has between one and three open shifts", () => {
    expect(openShiftCount()).toBeGreaterThanOrEqual(1);
    expect(openShiftCount()).toBeLessThanOrEqual(3);
  });

  it("has at least one shift ending soon", () => {
    expect(kpis.endingSoon).toBeGreaterThanOrEqual(1);
  });

  it("has several shifts still to start", () => {
    expect(kpis.upcoming).toBeGreaterThanOrEqual(3);
  });

  it("has at least one understaffed shift for the replacement demo", () => {
    expect(kpis.understaffed).toBeGreaterThanOrEqual(1);
  });

  it("schedules a believable number of people for one day", () => {
    expect(kpis.scheduled).toBeGreaterThanOrEqual(10);
    expect(kpis.scheduled).toBeLessThanOrEqual(40);
  });

  /**
   * The KPI cards come from `summarize()`. Computing the same numbers that way
   * proves the plan and the dashboard agree, rather than each being separately
   * plausible.
   */
  it("agrees with the dashboard's own summarize()", () => {
    const statuses: AttendanceStatus[] = [];
    for (const shift of LIVE_OPS_SHIFTS) {
      for (const assignment of shift.assignments) {
        statuses.push(statusFor(shift, assignment, T));
      }
    }
    const summary = summarize(statuses);

    expect(summary.onDuty).toBe(kpis.onDuty);
    expect(summary.late).toBe(kpis.late);
    expect(summary.noShow).toBe(kpis.noShow);
    expect(summary.outsideSite).toBe(kpis.outsideSite);
    expect(summary.upcoming).toBe(kpis.upcoming);
    expect(summary.scheduled).toBe(kpis.scheduled);
  });
});

describe("no impossible state reaches the board", () => {
  /** The bug the brief names: a future shift showing somebody clocked in. */
  it("nobody is clocked in before their shift has started", () => {
    for (const shift of LIVE_OPS_SHIFTS) {
      for (const assignment of shift.assignments) {
        const clockIn = clockInFor(assignment.intent);
        if (clockIn === null) continue;
        // A few minutes early is normal; hours early is a data bug.
        expect(clockIn).toBeGreaterThan(shift.startOffsetMin - 15);
      }
    }
  });

  it("nobody on a future shift has a time entry at all", () => {
    for (const shift of LIVE_OPS_SHIFTS.filter((s) => s.startOffsetMin > 0)) {
      for (const assignment of shift.assignments) {
        expect(clockInFor(assignment.intent)).toBeNull();
        expect(assignment.intent.kind).toBe("upcoming");
      }
    }
  });

  it("nobody has clocked out before clocking in", () => {
    for (const shift of LIVE_OPS_SHIFTS) {
      for (const assignment of shift.assignments) {
        const inAt = clockInFor(assignment.intent);
        const outAt = clockOutFor(assignment.intent);
        if (inAt === null || outAt === null) continue;
        expect(outAt).toBeGreaterThan(inAt);
      }
    }
  });

  it("nobody has clocked out in the future", () => {
    for (const shift of LIVE_OPS_SHIFTS) {
      for (const assignment of shift.assignments) {
        const outAt = clockOutFor(assignment.intent);
        if (outAt !== null) expect(outAt).toBeLessThanOrEqual(0);
      }
    }
  });

  it("gives every clock-in a location status and every absence none", () => {
    for (const shift of LIVE_OPS_SHIFTS) {
      for (const assignment of shift.assignments) {
        const hasEntry = clockInFor(assignment.intent) !== null;
        expect(locationStatusFor(assignment.intent) !== null).toBe(hasEntry);
      }
    }
  });

  it("only asks for a manual clock-in on somebody who has not clocked in", () => {
    for (const shift of LIVE_OPS_SHIFTS) {
      for (const assignment of shift.assignments) {
        if (!assignment.pendingManualRequest) continue;
        expect(clockInFor(assignment.intent)).toBeNull();
      }
    }
  });

  it("every shift ends after it starts", () => {
    for (const shift of LIVE_OPS_SHIFTS) {
      expect(shift.endOffsetMin).toBeGreaterThan(shift.startOffsetMin);
    }
  });

  it("never assigns more people than the shift requires", () => {
    for (const shift of LIVE_OPS_SHIFTS) {
      expect(shift.assignments.length).toBeLessThanOrEqual(shift.requiredCount);
    }
  });
});

describe("the crew is internally consistent", () => {
  it("never double-books a person across overlapping shifts", () => {
    for (const a of LIVE_OPS_SHIFTS) {
      for (const b of LIVE_OPS_SHIFTS) {
        if (a === b) continue;
        const overlap = a.startOffsetMin < b.endOffsetMin && b.startOffsetMin < a.endOffsetMin;
        if (!overlap) continue;
        const aCrew = new Set(a.assignments.map((x) => x.crew));
        for (const assignment of b.assignments) {
          expect(aCrew.has(assignment.crew)).toBe(false);
        }
      }
    }
  });

  it("keeps every crew index inside the pool the writer resolves", () => {
    for (const shift of LIVE_OPS_SHIFTS) {
      for (const assignment of shift.assignments) {
        expect(assignment.crew).toBeGreaterThanOrEqual(0);
        expect(assignment.crew).toBeLessThan(LIVE_OPS_CREW_SIZE);
      }
    }
  });

  it("uses distinct people within a single shift", () => {
    for (const shift of LIVE_OPS_SHIFTS) {
      const crew = shift.assignments.map((a) => a.crew);
      expect(new Set(crew).size).toBe(crew.length);
    }
  });

  it("gives every shift a unique key so the writer can be idempotent", () => {
    const keys = LIVE_OPS_SHIFTS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the scenario stays stable under different company thresholds", () => {
  /**
   * A tenant that has widened its grace period should still see a late arrival
   * and a no-show, or the demo silently loses two of its cards.
   */
  it("still shows one late and one no-show with a wider grace period", () => {
    const relaxed = { graceMinutes: 20, noShowMinutes: 60, earlyClockOutToleranceMinutes: 15 };
    const kpis = expectedKpis(relaxed);
    expect(kpis.late).toBe(1);
    expect(kpis.noShow).toBe(1);
  });

  it("still shows one late and one no-show with a stricter one", () => {
    const strict = { graceMinutes: 5, noShowMinutes: 30, earlyClockOutToleranceMinutes: 10 };
    const kpis = expectedKpis(strict);
    expect(kpis.late).toBe(1);
    expect(kpis.noShow).toBe(1);
  });
});

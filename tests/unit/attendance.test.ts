import { describe, expect, it } from "vitest";
import {
  attendanceThresholds,
  attendanceStatus,
  evaluateAlerts,
  summarize,
  formatMinutes,
  minutesBetween,
  isInactiveAssignment,
  DEFAULT_THRESHOLDS,
  type AssignmentSnapshot,
} from "@/lib/attendance";

const T = DEFAULT_THRESHOLDS; // grace 10, no-show 45, early tolerance 15

const START = new Date("2026-08-21T20:00:00Z");
const END = new Date("2026-08-22T06:00:00Z");

function snap(over: Partial<AssignmentSnapshot> = {}): AssignmentSnapshot {
  return {
    assignmentId: "a1",
    employeeId: "e1",
    assignmentStatus: "accepted",
    scheduledStart: START,
    scheduledEnd: END,
    clockIn: null,
    clockOut: null,
    clockInLocationStatus: null,
    ...over,
  };
}

const at = (iso: string) => new Date(iso);

describe("thresholds from company settings", () => {
  it("falls back to defaults", () => {
    expect(attendanceThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(attendanceThresholds({})).toEqual(DEFAULT_THRESHOLDS);
  });

  it("reads company overrides", () => {
    expect(
      attendanceThresholds({
        attendance: { graceMinutes: 5, noShowMinutes: 30, earlyClockOutToleranceMinutes: 20 },
      })
    ).toEqual({ graceMinutes: 5, noShowMinutes: 30, earlyClockOutToleranceMinutes: 20 });
  });

  it("ignores junk and never lets no-show fire before late", () => {
    const th = attendanceThresholds({
      attendance: { graceMinutes: 20, noShowMinutes: 5, earlyClockOutToleranceMinutes: "x" },
    });
    expect(th.graceMinutes).toBe(20);
    expect(th.noShowMinutes).toBe(20);
    expect(th.earlyClockOutToleranceMinutes).toBe(15);
  });
});

describe("attendance status", () => {
  it("upcoming before start", () => {
    expect(attendanceStatus(snap(), T, at("2026-08-21T19:30:00Z"))).toBe("upcoming");
  });
  it("not clocked in inside grace", () => {
    expect(attendanceStatus(snap(), T, at("2026-08-21T20:05:00Z"))).toBe("not_clocked_in");
  });
  it("late after grace", () => {
    expect(attendanceStatus(snap(), T, at("2026-08-21T20:10:00Z"))).toBe("late");
  });
  it("no show after threshold", () => {
    expect(attendanceStatus(snap(), T, at("2026-08-21T20:45:00Z"))).toBe("no_show");
  });
  it("on duty once clocked in", () => {
    expect(
      attendanceStatus(snap({ clockIn: at("2026-08-21T19:58:00Z"), clockInLocationStatus: "verified" }), T, at("2026-08-21T23:00:00Z"))
    ).toBe("on_duty");
  });
  it("surfaces outside-geofence and manual override", () => {
    expect(
      attendanceStatus(snap({ clockIn: START, clockInLocationStatus: "outside_geofence" }), T, at("2026-08-21T21:00:00Z"))
    ).toBe("outside_geofence");
    expect(
      attendanceStatus(snap({ clockIn: START, clockInLocationStatus: "manager_override" }), T, at("2026-08-21T21:00:00Z"))
    ).toBe("manual_override");
  });
  it("clocked out wins", () => {
    expect(
      attendanceStatus(snap({ clockIn: START, clockOut: at("2026-08-22T06:00:00Z") }), T, at("2026-08-22T07:00:00Z"))
    ).toBe("clocked_out");
  });
});

describe("1. late alert generation", () => {
  it("no alert before the grace period expires", () => {
    expect(evaluateAlerts(snap(), T, at("2026-08-21T20:09:00Z"))).toEqual([]);
  });

  it("fires exactly at start + grace", () => {
    const alerts = evaluateAlerts(snap(), T, at("2026-08-21T20:10:00Z"));
    expect(alerts).toEqual([{ type: "late_clock_in", minutesDelta: 10 }]);
  });

  it("records lateness when the employee eventually clocks in", () => {
    const alerts = evaluateAlerts(
      snap({ clockIn: at("2026-08-21T20:22:00Z") }),
      T,
      at("2026-08-21T23:00:00Z")
    );
    expect(alerts).toEqual([{ type: "late_clock_in", minutesDelta: 22 }]);
  });

  it("no late alert for an on-time clock-in", () => {
    expect(evaluateAlerts(snap({ clockIn: at("2026-08-21T19:55:00Z") }), T, at("2026-08-21T23:00:00Z"))).toEqual([]);
  });

  it("respects a company-specific grace period", () => {
    const th = attendanceThresholds({ attendance: { graceMinutes: 30, noShowMinutes: 90 } });
    expect(evaluateAlerts(snap(), th, at("2026-08-21T20:20:00Z"))).toEqual([]);
    expect(evaluateAlerts(snap(), th, at("2026-08-21T20:30:00Z"))).toEqual([
      { type: "late_clock_in", minutesDelta: 30 },
    ]);
  });
});

describe("2. no-show alert generation", () => {
  it("escalates to no-show while keeping the late record", () => {
    const alerts = evaluateAlerts(snap(), T, at("2026-08-21T20:45:00Z"));
    expect(alerts).toEqual([
      { type: "late_clock_in", minutesDelta: 45 },
      { type: "no_show", minutesDelta: 45 },
    ]);
  });

  it("never fires once the employee has clocked in", () => {
    const alerts = evaluateAlerts(snap({ clockIn: at("2026-08-21T20:30:00Z") }), T, at("2026-08-21T22:00:00Z"));
    expect(alerts.some((a) => a.type === "no_show")).toBe(false);
  });

  it("cancelled assignments never alert", () => {
    expect(evaluateAlerts(snap({ assignmentStatus: "cancelled" }), T, at("2026-08-22T02:00:00Z"))).toEqual([]);
    expect(
      evaluateAlerts(snap({ assignmentStatus: "cancellation_requested" }), T, at("2026-08-22T02:00:00Z"))
    ).toEqual([]);
    expect(isInactiveAssignment("cancelled")).toBe(true);
  });
});

describe("3. early clock-out alert", () => {
  it("fires beyond the tolerance", () => {
    const alerts = evaluateAlerts(
      snap({ clockIn: START, clockOut: at("2026-08-22T04:45:00Z") }),
      T,
      at("2026-08-22T05:00:00Z")
    );
    expect(alerts).toEqual([{ type: "early_clock_out", minutesDelta: 75 }]);
    expect(formatMinutes(75)).toBe("1h 15m");
  });

  it("stays quiet inside the tolerance", () => {
    expect(
      evaluateAlerts(snap({ clockIn: START, clockOut: at("2026-08-22T05:50:00Z") }), T, at("2026-08-22T06:00:00Z"))
    ).toEqual([]);
  });

  it("no alert for clocking out after the shift end", () => {
    expect(
      evaluateAlerts(snap({ clockIn: START, clockOut: at("2026-08-22T06:20:00Z") }), T, at("2026-08-22T07:00:00Z"))
    ).toEqual([]);
  });

  it("tolerance is configurable", () => {
    const th = attendanceThresholds({ attendance: { earlyClockOutToleranceMinutes: 90 } });
    expect(
      evaluateAlerts(snap({ clockIn: START, clockOut: at("2026-08-22T04:45:00Z") }), th, at("2026-08-22T05:00:00Z"))
    ).toEqual([]);
  });

  it("late arrival plus early departure produces both alerts", () => {
    const alerts = evaluateAlerts(
      snap({ clockIn: at("2026-08-21T20:40:00Z"), clockOut: at("2026-08-22T04:00:00Z") }),
      T,
      at("2026-08-22T05:00:00Z")
    );
    expect(alerts.map((a) => a.type)).toEqual(["late_clock_in", "early_clock_out"]);
  });
});

describe("idempotency of the pure evaluation", () => {
  it("returns an identical decision set for repeated runs at the same instant", () => {
    const s = snap();
    const now = at("2026-08-21T20:50:00Z");
    const a = evaluateAlerts(s, T, now);
    const b = evaluateAlerts(s, T, now);
    const c = evaluateAlerts(s, T, now);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("stays stable as time passes: same alert types, no new kinds", () => {
    const s = snap();
    const types = (n: string) => evaluateAlerts(s, T, at(n)).map((x) => x.type);
    expect(types("2026-08-21T20:45:00Z")).toEqual(["late_clock_in", "no_show"]);
    expect(types("2026-08-21T22:00:00Z")).toEqual(["late_clock_in", "no_show"]);
    expect(types("2026-08-22T05:00:00Z")).toEqual(["late_clock_in", "no_show"]);
  });

  it("is pure — evaluation does not mutate its input", () => {
    const s = snap();
    const before = JSON.stringify(s);
    evaluateAlerts(s, T, at("2026-08-21T21:00:00Z"));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("KPI roll-up", () => {
  it("counts each operational bucket", () => {
    const k = summarize([
      "on_duty",
      "on_duty",
      "outside_geofence",
      "manual_override",
      "late",
      "no_show",
      "upcoming",
      "clocked_out",
    ]);
    expect(k.scheduled).toBe(8);
    expect(k.onDuty).toBe(4); // 2 clean + outside + override are all working
    expect(k.late).toBe(1);
    expect(k.noShow).toBe(1);
    expect(k.outsideSite).toBe(1);
    expect(k.manualOverride).toBe(1);
    expect(k.upcoming).toBe(1);
    expect(k.clockedOut).toBe(1);
  });
});

describe("helpers", () => {
  it("minutesBetween floors toward the past", () => {
    expect(minutesBetween(at("2026-08-21T20:10:30Z"), START)).toBe(10);
  });
  it("formatMinutes", () => {
    expect(formatMinutes(9)).toBe("9m");
    expect(formatMinutes(60)).toBe("1h 0m");
    expect(formatMinutes(135)).toBe("2h 15m");
  });
});

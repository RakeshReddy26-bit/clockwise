import { describe, it, expect } from "vitest";
import {
  selectNextShift,
  nextShiftState,
  shiftDayLabel,
  ACTIVE_ASSIGNMENT_STATUSES,
} from "@/lib/next-shift";

const at = (iso: string) => new Date(iso);
const row = (id: string, start: string, end: string) => ({
  id,
  shift: { startTime: start, endTime: end },
});

describe("selectNextShift", () => {
  const now = at("2027-03-10T12:00:00Z");

  it("returns null when there is nothing to work", () => {
    expect(selectNextShift([], now)).toBeNull();
  });

  it("picks the earliest start, regardless of the order rows arrive in", () => {
    const picked = selectNextShift(
      [
        row("late", "2027-03-12T08:00:00Z", "2027-03-12T16:00:00Z"),
        row("soon", "2027-03-10T18:00:00Z", "2027-03-11T02:00:00Z"),
        row("middle", "2027-03-11T08:00:00Z", "2027-03-11T16:00:00Z"),
      ],
      now
    );
    expect(picked?.id).toBe("soon");
  });

  it("prefers a shift already under way over one starting later", () => {
    // The overnight shift started this morning and runs past `now`. That is
    // what the employee is doing, not tonight's.
    const picked = selectNextShift(
      [
        row("tonight", "2027-03-10T18:00:00Z", "2027-03-11T02:00:00Z"),
        row("running", "2027-03-10T06:00:00Z", "2027-03-10T14:00:00Z"),
      ],
      now
    );
    expect(picked?.id).toBe("running");
  });

  it("ignores shifts that have already ended", () => {
    const picked = selectNextShift(
      [
        row("finished", "2027-03-10T02:00:00Z", "2027-03-10T10:00:00Z"),
        row("next", "2027-03-10T18:00:00Z", "2027-03-11T02:00:00Z"),
      ],
      now
    );
    expect(picked?.id).toBe("next");
  });

  it("treats a shift ending exactly now as still current", () => {
    const picked = selectNextShift([row("edge", "2027-03-10T04:00:00Z", "2027-03-10T12:00:00Z")], now);
    expect(picked?.id).toBe("edge");
  });

  it("skips rows whose shift could not be read rather than crashing", () => {
    const picked = selectNextShift(
      [
        { id: "unreadable", shift: null },
        row("real", "2027-03-10T18:00:00Z", "2027-03-11T02:00:00Z"),
      ],
      now
    );
    expect(picked?.id).toBe("real");
  });

  it("returns null when every row is unreadable", () => {
    expect(selectNextShift([{ id: "a", shift: null }], now)).toBeNull();
  });

  it("holds the seat for the statuses /me/shifts also treats as active", () => {
    // Home and My shifts must never disagree about which shift is current.
    expect([...ACTIVE_ASSIGNMENT_STATUSES]).toEqual([
      "assigned",
      "accepted",
      "cancellation_requested",
    ]);
  });
});

describe("nextShiftState", () => {
  const shift = { startTime: "2027-03-10T14:00:00Z", endTime: "2027-03-10T22:00:00Z" };

  it("is on_duty whenever an entry is open, even before the scheduled start", () => {
    expect(nextShiftState(shift, true, at("2027-03-10T13:30:00Z"))).toBe("on_duty");
  });

  it("is upcoming before the start with no open entry", () => {
    expect(nextShiftState(shift, false, at("2027-03-10T13:30:00Z"))).toBe("upcoming");
  });

  it("is in_progress once the start has passed and nothing is open", () => {
    expect(nextShiftState(shift, false, at("2027-03-10T14:30:00Z"))).toBe("in_progress");
  });

  it("flips exactly at the scheduled start", () => {
    expect(nextShiftState(shift, false, at("2027-03-10T14:00:00Z"))).toBe("in_progress");
  });
});

describe("shiftDayLabel", () => {
  it("labels the same calendar day as today", () => {
    expect(shiftDayLabel("2027-03-10T22:00:00", at("2027-03-10T06:00:00"))).toBe("today");
  });

  it("labels the following calendar day as tomorrow", () => {
    expect(shiftDayLabel("2027-03-11T06:00:00", at("2027-03-10T22:00:00"))).toBe("tomorrow");
  });

  it("labels anything further out as later", () => {
    expect(shiftDayLabel("2027-03-13T06:00:00", at("2027-03-10T06:00:00"))).toBe("later");
  });

  it("does not call a shift already under way 'later'", () => {
    expect(shiftDayLabel("2027-03-10T02:00:00", at("2027-03-10T12:00:00"))).toBe("today");
  });
});

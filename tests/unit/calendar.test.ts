import { describe, it, expect } from "vitest";
import {
  monthOf,
  firstOfMonth,
  addMonths,
  daysInMonth,
  weekdayIndex,
  buildMonthGrid,
  sortEntries,
  absenceDays,
  monthWindow,
  type CalendarEntry,
} from "@/lib/calendar";

/**
 * Month arithmetic.
 *
 * All of it is pure and timezone-independent by construction — the grid is
 * built from 'YYYY-MM-DD' strings, never from a zoned Date — which is what
 * stops a 22:00 shift landing on the wrong day for a viewer in another zone.
 */

const entry = (over: Partial<CalendarEntry> = {}): CalendarEntry => ({
  id: "e1",
  kind: "shift",
  date: "2027-06-15",
  title: "Ostseekai",
  timeLabel: "06:00–14:00",
  href: null,
  ...over,
});

describe("month arithmetic", () => {
  it("extracts and builds a month", () => {
    expect(monthOf("2027-06-15")).toBe("2027-06");
    expect(firstOfMonth("2027-06")).toBe("2027-06-01");
  });

  it("steps months across a year boundary", () => {
    expect(addMonths("2027-12", 1)).toBe("2028-01");
    expect(addMonths("2027-01", -1)).toBe("2026-12");
    expect(addMonths("2027-06", 7)).toBe("2028-01");
  });

  it("counts days including leap years", () => {
    expect(daysInMonth("2027-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2027-06")).toBe(30);
    expect(daysInMonth("2027-07")).toBe(31);
  });

  it("uses a Monday-first week, the German convention", () => {
    // 2027-06-14 is a Monday.
    expect(weekdayIndex("2027-06-14")).toBe(0);
    expect(weekdayIndex("2027-06-20")).toBe(6);
  });

  it("gives the inclusive window a month covers", () => {
    expect(monthWindow("2027-06")).toEqual({ from: "2027-06-01", to: "2027-06-30" });
    expect(monthWindow("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describe("the month grid", () => {
  const now = new Date("2027-06-15T12:00:00Z");

  it("is always six whole weeks, so the page does not jump", () => {
    for (const month of ["2027-01", "2027-02", "2027-06", "2028-02"]) {
      expect(buildMonthGrid(month, [], now)).toHaveLength(42);
    }
  });

  it("starts on a Monday", () => {
    const grid = buildMonthGrid("2027-06", [], now);
    expect(weekdayIndex(grid[0].date)).toBe(0);
  });

  it("marks which cells belong to the month", () => {
    const grid = buildMonthGrid("2027-06", [], now);
    expect(grid.filter((c) => c.inMonth)).toHaveLength(30);
    expect(grid.find((c) => c.date === "2027-06-01")?.inMonth).toBe(true);
    expect(grid.find((c) => c.date === "2027-05-31")?.inMonth).toBe(false);
  });

  it("marks today exactly once", () => {
    const grid = buildMonthGrid("2027-06", [], now);
    expect(grid.filter((c) => c.isToday)).toHaveLength(1);
    expect(grid.find((c) => c.isToday)?.date).toBe("2027-06-15");
  });

  it("marks no cell as today when viewing another month", () => {
    expect(buildMonthGrid("2027-09", [], now).filter((c) => c.isToday)).toHaveLength(0);
  });

  it("files entries on their own day", () => {
    const grid = buildMonthGrid(
      "2027-06",
      [entry({ id: "a", date: "2027-06-15" }), entry({ id: "b", date: "2027-06-16" })],
      now
    );
    expect(grid.find((c) => c.date === "2027-06-15")?.entries.map((e) => e.id)).toEqual(["a"]);
    expect(grid.find((c) => c.date === "2027-06-16")?.entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("shows an entry that falls in a leading or trailing cell", () => {
    const grid = buildMonthGrid("2027-06", [entry({ id: "x", date: "2027-05-31" })], now);
    expect(grid.find((c) => c.date === "2027-05-31")?.entries).toHaveLength(1);
  });

  it("does not invent entries on empty days", () => {
    const grid = buildMonthGrid("2027-06", [entry()], now);
    expect(grid.filter((c) => c.entries.length > 0)).toHaveLength(1);
  });
});

describe("entry ordering", () => {
  it("puts shifts before absences before events", () => {
    const sorted = sortEntries([
      entry({ id: "event", kind: "event", timeLabel: null }),
      entry({ id: "absence", kind: "absence", timeLabel: null }),
      entry({ id: "shift", kind: "shift" }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["shift", "absence", "event"]);
  });

  it("orders same-kind entries by time", () => {
    const sorted = sortEntries([
      entry({ id: "late", timeLabel: "14:00–22:00" }),
      entry({ id: "early", timeLabel: "06:00–14:00" }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["early", "late"]);
  });

  it("does not mutate the input", () => {
    const input = [entry({ id: "b", kind: "event" }), entry({ id: "a", kind: "shift" })];
    sortEntries(input);
    expect(input.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

describe("absence expansion", () => {
  it("covers every day inclusively", () => {
    expect(absenceDays("2027-06-01", "2027-06-03")).toEqual([
      "2027-06-01",
      "2027-06-02",
      "2027-06-03",
    ]);
  });

  it("treats a missing end date as a single day", () => {
    expect(absenceDays("2027-06-01", null)).toEqual(["2027-06-01"]);
  });

  it("crosses a month boundary", () => {
    expect(absenceDays("2027-06-29", "2027-07-02")).toHaveLength(4);
  });

  it("is capped so one long absence cannot flood the grid", () => {
    expect(absenceDays("2027-01-01", "2027-12-31").length).toBeLessThanOrEqual(90);
  });

  it("returns nothing when the range is inverted", () => {
    expect(absenceDays("2027-06-10", "2027-06-01")).toEqual([]);
  });
});

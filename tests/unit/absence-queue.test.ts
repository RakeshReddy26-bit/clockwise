import { describe, it, expect } from "vitest";
import { orderAbsenceQueue, countDecidable } from "@/lib/absence-queue";

const DECIDABLE = ["reported"];

const row = (id: string, status: string, start_date: string) => ({ id, status, start_date });

describe("orderAbsenceQueue", () => {
  it("puts rows still needing a decision ahead of decided ones", () => {
    const ordered = orderAbsenceQueue(
      [
        row("old-confirmed", "confirmed", "2027-01-01"),
        row("new-reported", "reported", "2027-06-01"),
      ],
      DECIDABLE
    );
    expect(ordered.map((r) => r.id)).toEqual(["new-reported", "old-confirmed"]);
  });

  /**
   * The shape of the bug this replaced: a decided row with an earlier date
   * must never be able to push a pending one down the page.
   */
  it("an older decided row cannot outrank a pending one", () => {
    const ordered = orderAbsenceQueue(
      [
        row("c1", "confirmed", "2020-01-01"),
        row("c2", "confirmed", "2020-02-01"),
        row("r1", "reported", "2099-12-31"),
      ],
      DECIDABLE
    );
    expect(ordered[0].id).toBe("r1");
  });

  it("orders soonest first inside each group", () => {
    const ordered = orderAbsenceQueue(
      [
        row("r-late", "reported", "2027-09-01"),
        row("r-soon", "reported", "2027-03-01"),
        row("c-late", "confirmed", "2027-10-01"),
        row("c-soon", "confirmed", "2027-04-01"),
      ],
      DECIDABLE
    );
    expect(ordered.map((r) => r.id)).toEqual(["r-soon", "r-late", "c-soon", "c-late"]);
  });

  it("drops nothing — decided rows stay visible behind the queue", () => {
    const input = [row("a", "confirmed", "2027-01-01"), row("b", "reported", "2027-01-02")];
    expect(orderAbsenceQueue(input, DECIDABLE)).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const input = [row("a", "confirmed", "2027-02-01"), row("b", "reported", "2027-01-01")];
    const before = input.map((r) => r.id);
    orderAbsenceQueue(input, DECIDABLE);
    expect(input.map((r) => r.id)).toEqual(before);
  });

  it("handles an empty list", () => {
    expect(orderAbsenceQueue([], DECIDABLE)).toEqual([]);
  });
});

describe("countDecidable", () => {
  it("counts only what still needs a decision", () => {
    const rows = [
      row("a", "reported", "2027-01-01"),
      row("b", "confirmed", "2027-01-02"),
      row("c", "reported", "2027-01-03"),
    ];
    expect(countDecidable(rows, DECIDABLE)).toBe(2);
  });

  it("is zero when everything is already decided", () => {
    expect(countDecidable([row("a", "confirmed", "2027-01-01")], DECIDABLE)).toBe(0);
  });
});

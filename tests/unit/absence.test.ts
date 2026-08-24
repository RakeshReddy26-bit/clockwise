import { describe, expect, it } from "vitest";
import {
  classifyVacationDecision,
  classifyVacationWithdrawal,
  classifySickTransition,
  classifyVacationRequest,
  vacationBlocksScheduling,
  sickBlocksScheduling,
  coversDate,
  rangesOverlap,
  daysBetweenInclusive,
  conflictingAssignments,
  BLOCKING_SICK_STATUSES,
  BLOCKING_VACATION_STATUSES,
} from "@/lib/absence";
import { BLOCKING_SICK_STATUSES as ELIGIBILITY_SICK } from "@/lib/eligibility";

describe("what blocks scheduling", () => {
  it("only approved vacation blocks — pending deliberately does not", () => {
    expect(vacationBlocksScheduling("approved")).toBe(true);
    expect(vacationBlocksScheduling("pending")).toBe(false);
    expect(vacationBlocksScheduling("rejected")).toBe(false);
    expect(vacationBlocksScheduling("cancelled")).toBe(false);
    expect(BLOCKING_VACATION_STATUSES).toEqual(["approved"]);
  });

  it("reported sickness blocks as hard as confirmed", () => {
    expect(sickBlocksScheduling("reported")).toBe(true);
    expect(sickBlocksScheduling("confirmed")).toBe(true);
    expect(sickBlocksScheduling("closed")).toBe(false);
  });

  it("is literally the eligibility engine's list, not a second copy of it", () => {
    expect(BLOCKING_SICK_STATUSES).toBe(ELIGIBILITY_SICK);
    expect([...BLOCKING_SICK_STATUSES]).toEqual(["reported", "confirmed"]);
  });
});

describe("vacation decisions", () => {
  it("approves and rejects a pending request", () => {
    expect(classifyVacationDecision("pending", "approve")).toEqual({
      kind: "allowed",
      to: "approved",
    });
    expect(classifyVacationDecision("pending", "reject")).toEqual({
      kind: "allowed",
      to: "rejected",
    });
  });

  it("refuses a second decision in every direction", () => {
    for (const status of ["approved", "rejected", "cancelled"]) {
      expect(classifyVacationDecision(status, "approve")).toEqual({
        kind: "refused",
        reason: "not_pending",
      });
    }
  });
});

describe("employee withdrawal", () => {
  it("produces cancelled, never rejected", () => {
    expect(classifyVacationWithdrawal("pending")).toEqual({ kind: "allowed", to: "cancelled" });
  });

  it("is impossible once a manager has decided", () => {
    for (const status of ["approved", "rejected", "cancelled"]) {
      expect(classifyVacationWithdrawal(status)).toEqual({
        kind: "refused",
        reason: "not_pending",
      });
    }
  });
});

describe("sick-leave transitions", () => {
  it("reported → confirmed → closed", () => {
    expect(classifySickTransition("reported", "confirmed")).toEqual({
      kind: "allowed",
      to: "confirmed",
    });
    expect(classifySickTransition("confirmed", "closed")).toEqual({
      kind: "allowed",
      to: "closed",
    });
  });

  it("allows closing straight from reported — the short illness nobody documented", () => {
    expect(classifySickTransition("reported", "closed")).toEqual({ kind: "allowed", to: "closed" });
  });

  it("cannot reopen a closed leave or re-confirm", () => {
    expect(classifySickTransition("closed", "confirmed")).toEqual({
      kind: "refused",
      reason: "already_closed",
    });
    expect(classifySickTransition("confirmed", "confirmed")).toEqual({
      kind: "refused",
      reason: "not_a_transition",
    });
  });

  it("has no rejection — an employer does not decline an illness", () => {
    expect(classifySickTransition("reported", "rejected")).toEqual({
      kind: "refused",
      reason: "not_a_transition",
    });
  });
});

describe("date coverage", () => {
  it("is inclusive at both ends", () => {
    expect(coversDate("2026-05-10", "2026-05-10", "2026-05-12")).toBe(true);
    expect(coversDate("2026-05-12", "2026-05-10", "2026-05-12")).toBe(true);
    expect(coversDate("2026-05-09", "2026-05-10", "2026-05-12")).toBe(false);
    expect(coversDate("2026-05-13", "2026-05-10", "2026-05-12")).toBe(false);
  });

  it("treats a one-day absence as covering exactly that day", () => {
    expect(coversDate("2026-05-10", "2026-05-10", "2026-05-10")).toBe(true);
    expect(coversDate("2026-05-11", "2026-05-10", "2026-05-10")).toBe(false);
  });

  it("an open-ended sick leave covers everything from its start", () => {
    expect(coversDate("2030-01-01", "2026-05-10", null)).toBe(true);
    expect(coversDate("2026-05-09", "2026-05-10", null)).toBe(false);
  });
});

describe("range overlap", () => {
  it("detects touching, containment and separation", () => {
    expect(rangesOverlap("2026-05-10", "2026-05-12", "2026-05-12", "2026-05-14")).toBe(true);
    expect(rangesOverlap("2026-05-10", "2026-05-20", "2026-05-12", "2026-05-14")).toBe(true);
    expect(rangesOverlap("2026-05-10", "2026-05-12", "2026-05-13", "2026-05-14")).toBe(false);
  });

  it("an open-ended range overlaps everything after it", () => {
    expect(rangesOverlap("2026-05-10", null, "2030-01-01", "2030-01-02")).toBe(true);
    expect(rangesOverlap("2026-05-10", null, "2026-05-01", "2026-05-05")).toBe(false);
  });
});

describe("day counting", () => {
  it("counts inclusively", () => {
    expect(daysBetweenInclusive("2026-05-10", "2026-05-10")).toBe(1);
    expect(daysBetweenInclusive("2026-05-10", "2026-05-12")).toBe(3);
  });

  it("is stable across a DST boundary", () => {
    // Last Sunday in March 2027 is the 28th.
    expect(daysBetweenInclusive("2027-03-27", "2027-03-29")).toBe(3);
    expect(daysBetweenInclusive("2027-10-30", "2027-11-01")).toBe(3);
  });

  it("returns 0 for a reversed range", () => {
    expect(daysBetweenInclusive("2026-05-12", "2026-05-10")).toBe(0);
  });
});

describe("submitting a request", () => {
  const today = "2026-05-01";

  it("accepts a well-formed future request", () => {
    expect(
      classifyVacationRequest({ start: "2026-06-01", end: "2026-06-05", today, existing: [] })
    ).toEqual({ kind: "allowed" });
  });

  it("accepts one starting today", () => {
    expect(
      classifyVacationRequest({ start: today, end: today, today, existing: [] })
    ).toEqual({ kind: "allowed" });
  });

  it("refuses a reversed range and a past start", () => {
    expect(
      classifyVacationRequest({ start: "2026-06-05", end: "2026-06-01", today, existing: [] })
    ).toEqual({ kind: "refused", reason: "invalid_range" });
    expect(
      classifyVacationRequest({ start: "2026-04-01", end: "2026-04-02", today, existing: [] })
    ).toEqual({ kind: "refused", reason: "in_the_past" });
  });

  it("refuses an overlap with a live request", () => {
    for (const status of ["pending", "approved"]) {
      expect(
        classifyVacationRequest({
          start: "2026-06-03",
          end: "2026-06-08",
          today,
          existing: [{ start: "2026-06-01", end: "2026-06-05", status }],
        })
      ).toEqual({ kind: "refused", reason: "overlaps_existing" });
    }
  });

  it("ignores rejected and withdrawn history — the same days may be asked for again", () => {
    for (const status of ["rejected", "cancelled"]) {
      expect(
        classifyVacationRequest({
          start: "2026-06-03",
          end: "2026-06-08",
          today,
          existing: [{ start: "2026-06-01", end: "2026-06-05", status }],
        })
      ).toEqual({ kind: "allowed" });
    }
  });
});

describe("conflicting assignments", () => {
  const assignments = [
    { id: "a", shiftDate: "2026-06-02", status: "assigned" },
    { id: "b", shiftDate: "2026-06-04", status: "accepted" },
    { id: "c", shiftDate: "2026-06-04", status: "cancellation_requested" },
    { id: "d", shiftDate: "2026-06-04", status: "cancelled" },
    { id: "e", shiftDate: "2026-06-04", status: "completed" },
    { id: "f", shiftDate: "2026-06-20", status: "assigned" },
  ];

  it("finds only live assignments inside the period", () => {
    const found = conflictingAssignments({ start: "2026-06-01", end: "2026-06-05" }, assignments);
    expect(found.map((a) => a.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("a released assignment is no longer a conflict — this is what unblocks approval", () => {
    const released = assignments.map((a) =>
      a.id === "a" || a.id === "b" || a.id === "c" ? { ...a, status: "cancelled" } : a
    );
    expect(conflictingAssignments({ start: "2026-06-01", end: "2026-06-05" }, released)).toEqual(
      []
    );
  });

  it("an open-ended absence conflicts with everything from its start", () => {
    const found = conflictingAssignments({ start: "2026-06-01", end: null }, assignments);
    expect(found.map((a) => a.id).sort()).toEqual(["a", "b", "c", "f"]);
  });

  it("boundary days count", () => {
    expect(
      conflictingAssignments({ start: "2026-06-02", end: "2026-06-02" }, assignments).map(
        (a) => a.id
      )
    ).toEqual(["a"]);
  });
});

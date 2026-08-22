import { describe, expect, it } from "vitest";
import {
  evaluateCandidate,
  rankCandidates,
  eligibleOnly,
  matchesRequiredRole,
  hasValidQualification,
  overlaps,
  dateWithin,
  OCCUPYING_ASSIGNMENT_STATUSES,
  type CandidateInput,
  type ShiftContext,
} from "@/lib/eligibility";

const SHIFT: ShiftContext = {
  id: "shift-1",
  companyId: "company-a",
  start: new Date("2026-09-01T06:00:00Z"),
  end: new Date("2026-09-01T14:00:00Z"),
  date: "2026-09-01",
  requiredRole: "Servicetechniker/in",
  requiredQualification: null,
};

function candidate(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    employeeId: "emp-1",
    companyId: "company-a",
    employeeNo: "CW-001",
    fullName: "Test Person",
    employmentStatus: "active",
    position: "Servicetechniker/in",
    departmentName: "Gebäudetechnik",
    qualifications: [],
    availability: [],
    assignments: [],
    vacations: [],
    sickLeaves: [],
    ...over,
  };
}

const range = (startIso: string, endIso: string) => ({
  start: new Date(startIso),
  end: new Date(endIso),
});

describe("rule 1 — employment status", () => {
  it("active and probation employees can be scheduled", () => {
    expect(evaluateCandidate(candidate({ employmentStatus: "active" }), SHIFT).eligible).toBe(true);
    expect(evaluateCandidate(candidate({ employmentStatus: "probation" }), SHIFT).eligible).toBe(
      true
    );
  });

  it("terminated and on_leave employees are excluded", () => {
    for (const status of ["terminated", "on_leave"]) {
      const result = evaluateCandidate(candidate({ employmentStatus: status }), SHIFT);
      expect(result.eligible, status).toBe(false);
      expect(result.reasons).toContain("not_schedulable");
    }
  });
});

describe("rule 2 — tenant", () => {
  it("rejects a candidate from another company even if everything else fits", () => {
    const result = evaluateCandidate(candidate({ companyId: "company-b" }), SHIFT);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("wrong_company");
  });
});

describe("rule 3 — matchesRequiredRole (compatibility bridge)", () => {
  it("a null or blank required role accepts anyone", () => {
    expect(matchesRequiredRole(null, "Reinigungskraft", "Reinigung")).toBe(true);
    expect(matchesRequiredRole("   ", "Reinigungskraft", "Reinigung")).toBe(true);
  });

  it("matches the employee position", () => {
    expect(matchesRequiredRole("Servicetechniker/in", "Servicetechniker/in", "Reinigung")).toBe(
      true
    );
  });

  it("matches the department name — the seeded-data bridge", () => {
    expect(matchesRequiredRole("Logistik & Event", "Lagerhelfer/in", "Logistik & Event")).toBe(
      true
    );
  });

  it("rejects when neither matches", () => {
    expect(matchesRequiredRole("Servicetechniker/in", "Reinigungskraft", "Reinigung")).toBe(false);
  });

  it("tolerates surrounding whitespace but stays exact otherwise", () => {
    expect(matchesRequiredRole(" Reinigungskraft ", "Reinigungskraft", null)).toBe(true);
    expect(matchesRequiredRole("Reinigung", "Reinigungskraft", null)).toBe(false);
  });

  it("handles missing position and department", () => {
    expect(matchesRequiredRole("Servicekraft", null, null)).toBe(false);
  });

  it("a localized label never satisfies the rule", () => {
    // English display labels must not leak into business logic.
    expect(matchesRequiredRole("Service Technician", "Servicetechniker/in", "Gebäudetechnik")).toBe(
      false
    );
    expect(matchesRequiredRole("Servicetechniker/in", "Service Technician", "Building Services")).toBe(
      false
    );
    expect(matchesRequiredRole("Logistics Worker", "Logistikmitarbeiter/in", null)).toBe(false);
  });

  it("surfaces role_mismatch through the full evaluation", () => {
    const result = evaluateCandidate(
      candidate({ position: "Reinigungskraft", departmentName: "Reinigung" }),
      SHIFT
    );
    expect(result.reasons).toContain("role_mismatch");
  });
});

describe("rule 4 — qualifications", () => {
  const shift = { ...SHIFT, requiredQualification: "Höhenrettung" };

  it("no requirement means no qualification check", () => {
    expect(hasValidQualification(candidate(), null, "2026-09-01")).toBe(true);
    expect(hasValidQualification(candidate(), "  ", "2026-09-01")).toBe(true);
  });

  it("accepts a valid qualification with no expiry", () => {
    const c = candidate({
      qualifications: [{ name: "Höhenrettung", status: "valid", expiresAt: null }],
    });
    expect(evaluateCandidate(c, shift).eligible).toBe(true);
  });

  it("accepts one expiring after the shift date", () => {
    const c = candidate({
      qualifications: [{ name: "Höhenrettung", status: "valid", expiresAt: "2026-12-31" }],
    });
    expect(evaluateCandidate(c, shift).eligible).toBe(true);
  });

  it("accepts one expiring exactly on the shift date", () => {
    const c = candidate({
      qualifications: [{ name: "Höhenrettung", status: "valid", expiresAt: "2026-09-01" }],
    });
    expect(evaluateCandidate(c, shift).eligible).toBe(true);
  });

  it("rejects one that expired the day before", () => {
    const c = candidate({
      qualifications: [{ name: "Höhenrettung", status: "valid", expiresAt: "2026-08-31" }],
    });
    expect(evaluateCandidate(c, shift).reasons).toContain("missing_qualification");
  });

  it("rejects a non-valid status even when unexpired", () => {
    for (const status of ["expired", "expiring"]) {
      const c = candidate({
        qualifications: [{ name: "Höhenrettung", status, expiresAt: "2026-12-31" }],
      });
      expect(evaluateCandidate(c, shift).reasons, status).toContain("missing_qualification");
    }
  });

  it("rejects a different qualification", () => {
    const c = candidate({
      qualifications: [{ name: "Staplerschein", status: "valid", expiresAt: null }],
    });
    expect(evaluateCandidate(c, shift).reasons).toContain("missing_qualification");
  });
});

describe("rule 5 — availability", () => {
  it("no availability data means eligible, never excluded", () => {
    expect(evaluateCandidate(candidate({ availability: [] }), SHIFT).eligible).toBe(true);
  });

  it("an overlapping unavailable window excludes", () => {
    const c = candidate({
      availability: [
        { type: "unavailable", range: range("2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z") },
      ],
    });
    expect(evaluateCandidate(c, SHIFT).reasons).toContain("marked_unavailable");
  });

  it("an unavailable window on another day does not exclude", () => {
    const c = candidate({
      availability: [
        { type: "unavailable", range: range("2026-09-02T06:00:00Z", "2026-09-02T14:00:00Z") },
      ],
    });
    expect(evaluateCandidate(c, SHIFT).eligible).toBe(true);
  });

  it("available and preferred windows never exclude", () => {
    for (const type of ["available", "preferred"]) {
      const c = candidate({
        availability: [{ type, range: range("2026-09-01T06:00:00Z", "2026-09-01T14:00:00Z") }],
      });
      expect(evaluateCandidate(c, SHIFT).eligible, type).toBe(true);
    }
  });
});

describe("rule 6 — overlapping assignments", () => {
  it("an overlapping assignment excludes", () => {
    const c = candidate({
      assignments: [
        { shiftId: "other", range: range("2026-09-01T12:00:00Z", "2026-09-01T20:00:00Z") },
      ],
    });
    expect(evaluateCandidate(c, SHIFT).reasons).toContain("overlapping_assignment");
  });

  it("a shift ending exactly when this one starts is allowed", () => {
    const c = candidate({
      assignments: [
        { shiftId: "other", range: range("2026-08-31T22:00:00Z", "2026-09-01T06:00:00Z") },
      ],
    });
    expect(evaluateCandidate(c, SHIFT).eligible).toBe(true);
  });

  it("a shift starting exactly when this one ends is allowed", () => {
    const c = candidate({
      assignments: [
        { shiftId: "other", range: range("2026-09-01T14:00:00Z", "2026-09-01T22:00:00Z") },
      ],
    });
    expect(evaluateCandidate(c, SHIFT).eligible).toBe(true);
  });

  it("a one-minute overlap is rejected", () => {
    const c = candidate({
      assignments: [
        { shiftId: "other", range: range("2026-09-01T13:59:00Z", "2026-09-01T22:00:00Z") },
      ],
    });
    expect(evaluateCandidate(c, SHIFT).reasons).toContain("overlapping_assignment");
  });

  it("overlaps() is symmetric and half-open", () => {
    const a = range("2026-09-01T06:00:00Z", "2026-09-01T14:00:00Z");
    const b = range("2026-09-01T14:00:00Z", "2026-09-01T22:00:00Z");
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(b, a)).toBe(false);
    const c = range("2026-09-01T13:00:00Z", "2026-09-01T22:00:00Z");
    expect(overlaps(a, c)).toBe(true);
    expect(overlaps(c, a)).toBe(true);
  });
});

describe("rule 7/8 — absences", () => {
  it("approved vacation covering the date excludes", () => {
    const c = candidate({ vacations: [{ startDate: "2026-08-28", endDate: "2026-09-03" }] });
    expect(evaluateCandidate(c, SHIFT).reasons).toContain("on_vacation");
  });

  it("vacation on the boundary days excludes (inclusive range)", () => {
    expect(
      evaluateCandidate(
        candidate({ vacations: [{ startDate: "2026-09-01", endDate: "2026-09-01" }] }),
        SHIFT
      ).reasons
    ).toContain("on_vacation");
  });

  it("vacation ending the day before does not exclude", () => {
    const c = candidate({ vacations: [{ startDate: "2026-08-20", endDate: "2026-08-31" }] });
    expect(evaluateCandidate(c, SHIFT).eligible).toBe(true);
  });

  it("reported and confirmed sick leave excludes", () => {
    for (const status of ["reported", "confirmed"]) {
      const c = candidate({
        sickLeaves: [{ startDate: "2026-08-30", endDate: "2026-09-05", status }],
      });
      expect(evaluateCandidate(c, SHIFT).reasons, status).toContain("on_sick_leave");
    }
  });

  it("an open-ended sick leave excludes every later date", () => {
    const c = candidate({
      sickLeaves: [{ startDate: "2026-08-30", endDate: null, status: "confirmed" }],
    });
    expect(evaluateCandidate(c, SHIFT).reasons).toContain("on_sick_leave");
  });

  it("a closed sick leave does not exclude", () => {
    const c = candidate({
      sickLeaves: [{ startDate: "2026-08-30", endDate: "2026-09-05", status: "closed" }],
    });
    expect(evaluateCandidate(c, SHIFT).eligible).toBe(true);
  });

  it("dateWithin handles open-ended ranges", () => {
    expect(dateWithin("2026-09-01", "2026-08-30", null)).toBe(true);
    expect(dateWithin("2026-08-29", "2026-08-30", null)).toBe(false);
  });
});

describe("rule 9 — already assigned", () => {
  it("reports already_assigned rather than overlapping for this same shift", () => {
    const c = candidate({
      assignments: [
        { shiftId: SHIFT.id, range: range("2026-09-01T06:00:00Z", "2026-09-01T14:00:00Z") },
      ],
    });
    const result = evaluateCandidate(c, SHIFT);
    expect(result.reasons).toContain("already_assigned");
    expect(result.reasons).not.toContain("overlapping_assignment");
  });
});

describe("multiple failures", () => {
  it("collects every reason instead of stopping at the first", () => {
    const c = candidate({
      employmentStatus: "terminated",
      position: "Reinigungskraft",
      departmentName: "Reinigung",
      vacations: [{ startDate: "2026-09-01", endDate: "2026-09-02" }],
    });
    const result = evaluateCandidate(c, SHIFT);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["not_schedulable", "role_mismatch", "on_vacation"])
    );
  });
});

describe("ranking", () => {
  const preferred = range("2026-09-01T06:00:00Z", "2026-09-01T14:00:00Z");

  it("scores preferred above available, and zero without data", () => {
    const withPreferred = evaluateCandidate(
      candidate({ availability: [{ type: "preferred", range: preferred }] }),
      SHIFT
    );
    const withAvailable = evaluateCandidate(
      candidate({ availability: [{ type: "available", range: preferred }] }),
      SHIFT
    );
    const withNothing = evaluateCandidate(candidate(), SHIFT);
    expect(withPreferred.score).toBe(2);
    expect(withAvailable.score).toBe(1);
    expect(withNothing.score).toBe(0);
  });

  it("adds a point when the required role is the employee's department", () => {
    const shift = { ...SHIFT, requiredRole: "Logistik & Event" };
    const result = evaluateCandidate(
      candidate({ position: "Lagerhelfer/in", departmentName: "Logistik & Event" }),
      shift
    );
    expect(result.score).toBe(1);
  });

  it("does not consider workload — V1 has no hours-based factor", () => {
    const busy = candidate({
      employeeNo: "CW-002",
      assignments: [
        { shiftId: "x", range: range("2026-08-31T06:00:00Z", "2026-08-31T20:00:00Z") },
        { shiftId: "y", range: range("2026-09-02T06:00:00Z", "2026-09-02T20:00:00Z") },
      ],
    });
    const idle = candidate({ employeeNo: "CW-003" });
    expect(evaluateCandidate(busy, SHIFT).score).toBe(evaluateCandidate(idle, SHIFT).score);
  });

  it("ineligible candidates always score zero", () => {
    const c = candidate({
      employmentStatus: "terminated",
      availability: [{ type: "preferred", range: preferred }],
    });
    expect(evaluateCandidate(c, SHIFT).score).toBe(0);
  });

  it("orders eligible first, then score desc, then employee number", () => {
    const results = rankCandidates(
      [
        candidate({ employeeId: "c", employeeNo: "CW-003" }),
        candidate({ employeeId: "t", employeeNo: "CW-000", employmentStatus: "terminated" }),
        candidate({ employeeId: "a", employeeNo: "CW-001" }),
        candidate({
          employeeId: "p",
          employeeNo: "CW-009",
          availability: [{ type: "preferred", range: preferred }],
        }),
      ],
      SHIFT
    );
    expect(results.map((r) => r.employeeId)).toEqual(["p", "a", "c", "t"]);
    expect(results.at(-1)!.eligible).toBe(false);
  });

  it("is stable regardless of input order", () => {
    const people = [
      candidate({ employeeId: "a", employeeNo: "CW-001" }),
      candidate({ employeeId: "b", employeeNo: "CW-002" }),
      candidate({ employeeId: "c", employeeNo: "CW-003" }),
    ];
    const forward = rankCandidates(people, SHIFT).map((r) => r.employeeId);
    const reversed = rankCandidates([...people].reverse(), SHIFT).map((r) => r.employeeId);
    expect(forward).toEqual(reversed);
  });

  it("eligibleOnly drops everyone with a reason", () => {
    const results = rankCandidates(
      [candidate({ employeeId: "ok" }), candidate({ employeeId: "no", employmentStatus: "terminated" })],
      SHIFT
    );
    expect(eligibleOnly(results).map((r) => r.employeeId)).toEqual(["ok"]);
  });
});

describe("caller contract", () => {
  it("names exactly the assignment statuses that still occupy time", () => {
    // Must match recalc_shift_staffing() in 0001_schema.sql: a cancellation
    // frees the seat only once approved.
    expect([...OCCUPYING_ASSIGNMENT_STATUSES]).toEqual([
      "assigned",
      "accepted",
      "cancellation_requested",
    ]);
  });
});

describe("purity", () => {
  it("does not mutate its inputs", () => {
    const c = candidate({
      availability: [{ type: "preferred", range: range("2026-09-01T06:00:00Z", "2026-09-01T14:00:00Z") }],
    });
    const before = JSON.stringify(c);
    evaluateCandidate(c, SHIFT);
    rankCandidates([c], SHIFT);
    expect(JSON.stringify(c)).toBe(before);
  });

  it("returns the same verdict for repeated evaluation", () => {
    const c = candidate();
    const a = evaluateCandidate(c, SHIFT);
    const b = evaluateCandidate(c, SHIFT);
    expect(a).toEqual(b);
  });
});

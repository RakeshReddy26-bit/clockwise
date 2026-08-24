import { describe, expect, it } from "vitest";
import {
  classifyEngagement,
  editVerdict,
  editSetVerdict,
  capacityVerdict,
  derivedShiftStatus,
  notifyAudience,
  changedFields,
  isEditableField,
  FIELD_RISK,
  EDITABLE_FIELDS,
  ENGAGEMENT_LEVELS,
  type Engagement,
  type EditableField,
} from "@/lib/shift-lifecycle";

const NOW = new Date("2026-09-01T10:00:00Z");
const FUTURE = new Date("2026-09-03T18:00:00Z");

function engagement(over: Partial<Parameters<typeof classifyEngagement>[0]> = {}) {
  return classifyEngagement({
    endTime: FUTURE,
    now: NOW,
    hasTimeEntries: false,
    occupyingAssignments: 0,
    interestedResponses: 0,
    hasOpenOffer: false,
    ...over,
  });
}

describe("classifyEngagement", () => {
  it("is none for an untouched future shift", () => {
    expect(engagement()).toBe("none");
  });

  it("climbs the ladder in order", () => {
    expect(engagement({ hasOpenOffer: true })).toBe("offered");
    expect(engagement({ hasOpenOffer: true, interestedResponses: 1 })).toBe("interested");
    expect(engagement({ hasOpenOffer: true, occupyingAssignments: 1 })).toBe("assigned");
    expect(engagement({ occupyingAssignments: 1, hasTimeEntries: true })).toBe("worked");
  });

  it("past beats everything, because it is over", () => {
    expect(
      engagement({
        endTime: new Date("2026-08-31T00:00:00Z"),
        hasTimeEntries: true,
        occupyingAssignments: 2,
      })
    ).toBe("past");
  });

  it("treats the exact end instant as past", () => {
    expect(engagement({ endTime: NOW })).toBe("past");
  });

  it("does not read the clock itself", () => {
    expect(engagement({ now: new Date("2026-09-04T00:00:00Z") })).toBe("past");
  });
});

describe("editVerdict — the matrix", () => {
  const rows: Array<[EditableField, Partial<Record<Engagement, string>>]> = [
    [
      "instructions",
      { none: "allow", offered: "allow", interested: "allow", assigned: "allow", worked: "allow", past: "refuse" },
    ],
    [
      "contact_person",
      { none: "allow", offered: "allow", interested: "allow", assigned: "allow", worked: "allow", past: "refuse" },
    ],
    [
      "required_count",
      { none: "allow", offered: "allow", interested: "allow", assigned: "allow", worked: "allow", past: "refuse" },
    ],
    [
      "required_role",
      { none: "allow", offered: "confirm", interested: "confirm", assigned: "refuse", worked: "refuse", past: "refuse" },
    ],
    [
      "required_qualification",
      { none: "allow", offered: "confirm", interested: "confirm", assigned: "refuse", worked: "refuse", past: "refuse" },
    ],
    [
      "start_time",
      { none: "allow", offered: "confirm", interested: "confirm", assigned: "refuse", worked: "refuse", past: "refuse" },
    ],
    [
      "end_time",
      { none: "allow", offered: "confirm", interested: "confirm", assigned: "refuse", worked: "refuse", past: "refuse" },
    ],
    [
      "job_id",
      { none: "allow", offered: "refuse", interested: "refuse", assigned: "refuse", worked: "refuse", past: "refuse" },
    ],
  ];

  it("covers every field", () => {
    expect(rows.map(([f]) => f).sort()).toEqual([...EDITABLE_FIELDS].sort());
  });

  for (const [field, expected] of rows) {
    for (const level of ENGAGEMENT_LEVELS) {
      it(`${field} at ${level} → ${expected[level]}`, () => {
        expect(editVerdict(field, level).kind).toBe(expected[level]);
      });
    }
  }

  it("names why a refusal happened", () => {
    expect(editVerdict("start_time", "assigned")).toEqual({
      kind: "refuse",
      reason: "has_assignments",
    });
    expect(editVerdict("start_time", "worked")).toEqual({
      kind: "refuse",
      reason: "has_time_entries",
    });
    expect(editVerdict("instructions", "past")).toEqual({
      kind: "refuse",
      reason: "shift_ended",
    });
    expect(editVerdict("job_id", "offered")).toEqual({ kind: "refuse", reason: "job_locked" });
  });
});

describe("editSetVerdict — the strictest field wins", () => {
  it("allows when everything is safe", () => {
    expect(editSetVerdict(["instructions", "required_count"], "assigned")).toEqual({
      kind: "allow",
    });
  });

  it("escalates to confirmation if any field needs it", () => {
    expect(editSetVerdict(["instructions", "start_time"], "offered")).toEqual({
      kind: "confirm",
      because: "invalidates_open_offer",
    });
  });

  it("one refusal refuses the whole edit", () => {
    expect(editSetVerdict(["instructions", "job_id"], "interested")).toEqual({
      kind: "refuse",
      reason: "job_locked",
    });
  });

  it("an empty edit is allowed and meaningless", () => {
    expect(editSetVerdict([], "worked")).toEqual({ kind: "allow" });
  });
});

describe("capacityVerdict", () => {
  it("lets capacity rise freely", () => {
    expect(capacityVerdict(2, 5, 2)).toEqual({ kind: "allow", opensVacancies: true });
  });

  it("lets capacity fall to exactly occupancy", () => {
    expect(capacityVerdict(5, 3, 3)).toEqual({ kind: "allow", opensVacancies: false });
  });

  it("refuses dropping below the people already holding a seat", () => {
    expect(capacityVerdict(3, 2, 3)).toEqual({ kind: "refuse", reason: "below_occupancy" });
  });

  it("refuses zero, negatives and fractions", () => {
    for (const n of [0, -1, 1.5]) {
      expect(capacityVerdict(3, n, 0)).toEqual({ kind: "refuse", reason: "not_positive" });
    }
  });
});

describe("derivedShiftStatus", () => {
  it("is staffed only when every seat is taken", () => {
    expect(derivedShiftStatus(1, 1)).toBe("staffed");
    expect(derivedShiftStatus(3, 2)).toBe("staffed");
    expect(derivedShiftStatus(1, 3)).toBe("open");
    expect(derivedShiftStatus(0, 1)).toBe("open");
  });
});

describe("notifyAudience", () => {
  it("says nothing for a capacity-only change", () => {
    expect(notifyAudience(["required_count"])).toBe("none");
  });

  it("tells people when the work itself changed", () => {
    expect(notifyAudience(["instructions"])).toBe("engaged");
    expect(notifyAudience(["required_count", "start_time"])).toBe("engaged");
  });

  it("says nothing when nothing changed", () => {
    expect(notifyAudience([])).toBe("none");
  });
});

describe("changedFields", () => {
  const current = {
    instructions: "Treffpunkt Tor 1",
    required_count: 2,
    required_role: null,
  };

  it("returns only what actually differs", () => {
    expect(
      changedFields(current, { instructions: "Treffpunkt Tor 1", required_count: 3 })
    ).toEqual(["required_count"]);
  });

  it("treats blank, whitespace and null as the same absence", () => {
    expect(changedFields(current, { required_role: "" })).toEqual([]);
    expect(changedFields(current, { required_role: "   " })).toEqual([]);
    expect(changedFields(current, { required_role: null })).toEqual([]);
  });

  it("ignores surrounding whitespace on real values", () => {
    expect(changedFields(current, { instructions: "  Treffpunkt Tor 1  " })).toEqual([]);
    expect(changedFields(current, { instructions: "Treffpunkt Tor 3" })).toEqual([
      "instructions",
    ]);
  });

  it("a form that posts every field unchanged is not an edit", () => {
    expect(changedFields(current, { ...current })).toEqual([]);
  });
});

describe("field metadata", () => {
  it("classifies every editable field exactly once", () => {
    for (const field of EDITABLE_FIELDS) {
      expect(FIELD_RISK[field]).toBeTruthy();
    }
    expect(Object.keys(FIELD_RISK).sort()).toEqual([...EDITABLE_FIELDS].sort());
  });

  it("rejects anything that is not an editable field", () => {
    expect(isEditableField("status")).toBe(false);
    expect(isEditableField("date")).toBe(false);
    expect(isEditableField("company_id")).toBe(false);
    expect(isEditableField("instructions")).toBe(true);
  });
});

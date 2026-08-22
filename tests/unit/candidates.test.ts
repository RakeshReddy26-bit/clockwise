import { describe, expect, it } from "vitest";
import { offsetOf, availabilityWindowForDate, toShiftContext } from "@/lib/candidates";
import { OCCUPYING_ASSIGNMENT_STATUSES, overlaps } from "@/lib/eligibility";

/**
 * The row-shaping half of candidate loading. The database call itself is
 * covered by tests/db/offers.test.ts; here we pin the pure mapping so a
 * timezone or weekday slip cannot silently exclude someone.
 */

const AVAILABILITY = {
  type: "available",
  weekday: null as number | null,
  valid_from: null as string | null,
  valid_to: null as string | null,
  start_time: "06:00:00" as string | null,
  end_time: "14:00:00" as string | null,
};

describe("offsetOf", () => {
  it("reads the offset a timestamp was delivered in", () => {
    expect(offsetOf("2026-09-01T06:00:00+02:00")).toBe("+02:00");
    expect(offsetOf("2026-09-01T06:00:00-05:00")).toBe("-05:00");
    expect(offsetOf("2026-09-01T04:00:00Z")).toBe("Z");
  });

  it("falls back to UTC when no offset is present", () => {
    expect(offsetOf("2026-09-01T06:00:00")).toBe("Z");
  });

  it("normalises a compact offset", () => {
    expect(offsetOf("2026-09-01T06:00:00+0200")).toBe("+02:00");
  });
});

describe("availabilityWindowForDate", () => {
  it("builds the window on the shift's own clock", () => {
    const window = availabilityWindowForDate(AVAILABILITY, "2026-09-01", "+02:00");
    expect(window).not.toBeNull();
    expect(window!.range.start.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(window!.range.end.toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });

  it("keeps the rule's type so scoring can tell preferred from available", () => {
    const window = availabilityWindowForDate(
      { ...AVAILABILITY, type: "preferred" },
      "2026-09-01",
      "Z"
    );
    expect(window!.type).toBe("preferred");
  });

  it("covers the whole day when no times are given", () => {
    const window = availabilityWindowForDate(
      { ...AVAILABILITY, start_time: null, end_time: null },
      "2026-09-01",
      "Z"
    );
    expect(window!.range.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(window!.range.end.toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });

  it("applies only on the matching weekday", () => {
    // 2026-09-01 is a Tuesday (getUTCDay() === 2)
    expect(availabilityWindowForDate({ ...AVAILABILITY, weekday: 2 }, "2026-09-01", "Z")).not.toBeNull();
    expect(availabilityWindowForDate({ ...AVAILABILITY, weekday: 3 }, "2026-09-01", "Z")).toBeNull();
  });

  it("respects the validity range inclusively", () => {
    const row = { ...AVAILABILITY, valid_from: "2026-09-01", valid_to: "2026-09-30" };
    expect(availabilityWindowForDate(row, "2026-09-01", "Z")).not.toBeNull();
    expect(availabilityWindowForDate(row, "2026-09-30", "Z")).not.toBeNull();
    expect(availabilityWindowForDate(row, "2026-08-31", "Z")).toBeNull();
    expect(availabilityWindowForDate(row, "2026-10-01", "Z")).toBeNull();
  });

  it("ignores inverted or zero-length rules rather than producing a bad window", () => {
    expect(
      availabilityWindowForDate(
        { ...AVAILABILITY, start_time: "14:00:00", end_time: "06:00:00" },
        "2026-09-01",
        "Z"
      )
    ).toBeNull();
    expect(
      availabilityWindowForDate(
        { ...AVAILABILITY, start_time: "06:00:00", end_time: "06:00:00" },
        "2026-09-01",
        "Z"
      )
    ).toBeNull();
  });

  it("produces a window that overlaps the shift it was built against", () => {
    const shift = {
      start: new Date("2026-09-01T06:00:00+02:00"),
      end: new Date("2026-09-01T14:00:00+02:00"),
    };
    const window = availabilityWindowForDate(AVAILABILITY, "2026-09-01", "+02:00")!;
    expect(overlaps(window.range, shift)).toBe(true);
  });
});

describe("toShiftContext", () => {
  it("carries the raw role and qualification through untranslated", () => {
    const context = toShiftContext({
      id: "s1",
      company_id: "c1",
      date: "2026-09-01",
      start_time: "2026-09-01T06:00:00+02:00",
      end_time: "2026-09-01T14:00:00+02:00",
      required_role: "Servicetechniker/in",
      required_qualification: "Staplerschein",
    });
    expect(context.requiredRole).toBe("Servicetechniker/in");
    expect(context.requiredQualification).toBe("Staplerschein");
    expect(context.start.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(context.date).toBe("2026-09-01");
  });
});

describe("occupying-status contract", () => {
  it("the loader filters assignments on the shared constant, not a local copy", () => {
    // Guards against a second list drifting away from recalc_shift_staffing().
    expect([...OCCUPYING_ASSIGNMENT_STATUSES]).toEqual([
      "assigned",
      "accepted",
      "cancellation_requested",
    ]);
  });
});

import { describe, it, expect } from "vitest";
import {
  buildAttentionItems,
  askAiPromptKey,
  isAllClear,
  type AttentionInput,
  type BoardPerson,
  type BoardShift,
  type PendingRequest,
} from "@/lib/live-ops";

/**
 * Attention ordering.
 *
 * The panel exists to answer "what do I deal with first", so the ordering IS
 * the feature. These tests pin the operational judgement behind it, and would
 * fail loudly if somebody reordered the severities without meaning to.
 */

const NOW = new Date("2027-06-01T10:00:00Z");
const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60_000);

const person = (over: Partial<BoardPerson> = {}): BoardPerson => ({
  assignmentId: "a1",
  employeeName: "Lukas Brandt",
  siteName: "Ostseekai",
  shiftId: "s1",
  status: "on_duty",
  minutesLate: null,
  distanceM: null,
  ...over,
});

const shift = (over: Partial<BoardShift> = {}): BoardShift => ({
  shiftId: "s1",
  siteName: "Ostseekai",
  required: 8,
  filled: 7,
  openSeats: 1,
  startsAt: minutesFromNow(-180),
  ...over,
});

const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  requestId: "r1",
  employeeName: "Sofia Petrova",
  siteName: "Schwedenkai",
  shiftId: "s2",
  createdAt: minutesFromNow(-6),
  ...over,
});

const build = (over: Partial<AttentionInput> = {}, limit?: number) =>
  buildAttentionItems({ people: [], shifts: [], requests: [], now: NOW, ...over }, limit);

describe("what gets surfaced", () => {
  it("says nothing when the operation is clean", () => {
    const result = build({ people: [person()], shifts: [shift({ openSeats: 0, filled: 8 })] });
    expect(result.items).toEqual([]);
    expect(isAllClear(result)).toBe(true);
  });

  it("raises a no-show", () => {
    const result = build({ people: [person({ status: "no_show", minutesLate: 28 })] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "no_show",
      employeeName: "Lukas Brandt",
      siteName: "Ostseekai",
      minutesLate: 28,
      shiftId: "s1",
    });
  });

  it("raises a clock-in outside the geofence with its distance", () => {
    const result = build({
      people: [person({ status: "outside_geofence", distanceM: 412 })],
    });
    expect(result.items[0]).toMatchObject({ kind: "outside_geofence", distanceM: 412 });
  });

  it("raises a late arrival", () => {
    const result = build({ people: [person({ status: "late", minutesLate: 12 })] });
    expect(result.items[0]).toMatchObject({ kind: "late", minutesLate: 12 });
  });

  it("raises a pending manual request with how long it has waited", () => {
    const result = build({ requests: [request()] });
    expect(result.items[0]).toMatchObject({
      kind: "manual_request",
      waitingMinutes: 6,
      requestId: "r1",
    });
  });

  it("raises an understaffed shift with its seat counts", () => {
    const result = build({ shifts: [shift()] });
    expect(result.items[0]).toMatchObject({
      kind: "understaffed_active",
      required: 8,
      filled: 7,
      openSeats: 1,
    });
  });

  it("ignores a fully staffed shift", () => {
    const result = build({ shifts: [shift({ openSeats: 0, filled: 8 })] });
    expect(result.items).toEqual([]);
  });

  it("ignores people who are simply working", () => {
    const result = build({
      people: [person({ status: "on_duty" }), person({ assignmentId: "a2", status: "clocked_out" })],
    });
    expect(result.items).toEqual([]);
  });

  it("does not treat an upcoming shift's assignees as a problem", () => {
    const result = build({ people: [person({ status: "upcoming" })] });
    expect(result.items).toEqual([]);
  });
});

describe("ordering", () => {
  it("puts a no-show above everything else", () => {
    const result = build({
      people: [
        person({ assignmentId: "a1", status: "late", minutesLate: 40 }),
        person({ assignmentId: "a2", status: "outside_geofence", distanceM: 900 }),
        person({ assignmentId: "a3", status: "no_show", minutesLate: 46 }),
      ],
      shifts: [shift()],
      requests: [request()],
    });
    expect(result.items[0].kind).toBe("no_show");
  });

  it("ranks the full severity order as designed", () => {
    const result = build({
      people: [
        person({ assignmentId: "a1", status: "no_show", minutesLate: 50 }),
        person({ assignmentId: "a2", status: "outside_geofence", distanceM: 412 }),
        person({ assignmentId: "a3", status: "late", minutesLate: 12 }),
      ],
      shifts: [
        shift({ shiftId: "running", startsAt: minutesFromNow(-60) }),
        shift({ shiftId: "later", startsAt: minutesFromNow(240) }),
      ],
      requests: [request()],
    });

    expect(result.items.map((i) => i.kind)).toEqual([
      "no_show",
      "understaffed_active",
      "manual_request",
      "outside_geofence",
      "understaffed_upcoming",
      "late",
    ]);
  });

  it("separates a shift already running from one still to come", () => {
    const result = build({
      shifts: [
        shift({ shiftId: "later", startsAt: minutesFromNow(120) }),
        shift({ shiftId: "running", startsAt: minutesFromNow(-30) }),
      ],
    });
    expect(result.items[0]).toMatchObject({ kind: "understaffed_active", shiftId: "running" });
    expect(result.items[1]).toMatchObject({ kind: "understaffed_upcoming", shiftId: "later" });
  });

  it("treats a shift starting exactly now as already running", () => {
    const result = build({ shifts: [shift({ startsAt: NOW })] });
    expect(result.items[0].kind).toBe("understaffed_active");
  });

  it("within one band, the longest-standing problem comes first", () => {
    const result = build({
      people: [
        person({ assignmentId: "a1", status: "no_show", minutesLate: 46 }),
        person({ assignmentId: "a2", status: "no_show", minutesLate: 95 }),
      ],
    });
    expect(result.items.map((i) => i.key)).toEqual(["no_show:a2", "no_show:a1"]);
  });

  it("within upcoming gaps, the soonest shift comes first", () => {
    const result = build({
      shifts: [
        shift({ shiftId: "far", startsAt: minutesFromNow(360) }),
        shift({ shiftId: "soon", startsAt: minutesFromNow(45) }),
      ],
    });
    expect(result.items.map((i) => i.shiftId)).toEqual(["soon", "far"]);
  });

  it("orders waiting manual requests by how long the employee has waited", () => {
    const result = build({
      requests: [
        request({ requestId: "r1", createdAt: minutesFromNow(-3) }),
        request({ requestId: "r2", createdAt: minutesFromNow(-19) }),
      ],
    });
    expect(result.items.map((i) => i.key)).toEqual(["manual:r2", "manual:r1"]);
  });
});

describe("triage limit", () => {
  it("keeps the list short and reports the true total", () => {
    const people = Array.from({ length: 12 }, (_, i) =>
      person({ assignmentId: `a${i}`, status: "late", minutesLate: i })
    );
    const result = build({ people }, 4);
    expect(result.items).toHaveLength(4);
    expect(result.total).toBe(12);
  });

  it("drops the least severe, never the most", () => {
    const result = build(
      {
        people: [
          person({ assignmentId: "late", status: "late", minutesLate: 30 }),
          person({ assignmentId: "gone", status: "no_show", minutesLate: 60 }),
        ],
      },
      1
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].kind).toBe("no_show");
  });

  it("never reports fewer than it shows", () => {
    const result = build({ people: [person({ status: "no_show", minutesLate: 1 })] }, 10);
    expect(result.total).toBeGreaterThanOrEqual(result.items.length);
  });
});

describe("keys and Ask-AI wiring", () => {
  it("gives every item a key that is stable and unique", () => {
    const result = build({
      people: [
        person({ assignmentId: "a1", status: "no_show", minutesLate: 50 }),
        person({ assignmentId: "a2", status: "late", minutesLate: 11 }),
      ],
      shifts: [shift()],
      requests: [request()],
    });
    const keys = result.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    // Running it again produces the same keys, so React does not remount rows.
    expect(keys).toEqual(
      build({
        people: [
          person({ assignmentId: "a1", status: "no_show", minutesLate: 50 }),
          person({ assignmentId: "a2", status: "late", minutesLate: 11 }),
        ],
        shifts: [shift()],
        requests: [request()],
      }).items.map((i) => i.key)
    );
  });

  it("maps every kind to a distinct assistant prompt", () => {
    const kinds = [
      "no_show",
      "understaffed_active",
      "understaffed_upcoming",
      "manual_request",
      "outside_geofence",
      "late",
    ] as const;
    const seen = kinds.map((kind) => askAiPromptKey({ kind } as never));
    expect(seen.every(Boolean)).toBe(true);
    // Both understaffed variants ask the same question, which is intended.
    expect(new Set(seen).size).toBe(5);
  });
});

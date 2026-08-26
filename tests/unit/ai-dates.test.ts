import { describe, it, expect } from "vitest";
import {
  operatingDate,
  addDays,
  dateRange,
  operatingWallClockToUtc,
  isWallClockTime,
  OPERATING_TIME_ZONE,
} from "@/lib/ai/dates";

/**
 * Calendar resolution for the assistant.
 *
 * The assistant turns "tomorrow at 06:00" into an instant the existing
 * create_shift RPC accepts. That conversion must agree with migration 0011,
 * which derives `shifts.date` with `at time zone 'Europe/Berlin'` — otherwise a
 * shift the manager asked for on Tuesday lands on Monday.
 *
 * These are pure functions and the tests are timezone-independent by
 * construction: they assert on UTC instants and on 'YYYY-MM-DD' strings, never
 * on anything read through the local clock.
 */

describe("operatingDate", () => {
  it("uses the operating zone, not the machine's", () => {
    // 23:30 UTC on 9 March is already 00:30 on the 10th in Berlin.
    expect(operatingDate(new Date("2027-03-09T23:30:00Z"))).toBe("2027-03-10");
  });

  it("keeps a mid-day instant on the same day", () => {
    expect(operatingDate(new Date("2027-03-10T12:00:00Z"))).toBe("2027-03-10");
  });

  it("is still correct in summer time", () => {
    // CEST is +02:00, so 22:30 UTC has already rolled over.
    expect(operatingDate(new Date("2027-07-15T22:30:00Z"))).toBe("2027-07-16");
  });

  it("names the same zone the migration uses", () => {
    expect(OPERATING_TIME_ZONE).toBe("Europe/Berlin");
  });
});

describe("addDays", () => {
  it("moves forward and backward", () => {
    expect(addDays("2027-03-10", 1)).toBe("2027-03-11");
    expect(addDays("2027-03-10", -1)).toBe("2027-03-09");
  });

  it("crosses a month boundary", () => {
    expect(addDays("2027-03-31", 1)).toBe("2027-04-01");
  });

  it("crosses a year boundary", () => {
    expect(addDays("2027-12-31", 1)).toBe("2028-01-01");
  });

  it("handles a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  /** The DST transition must not eat or duplicate a day. */
  it("steps cleanly across the spring transition", () => {
    expect(addDays("2027-03-27", 1)).toBe("2027-03-28");
    expect(addDays("2027-03-28", 1)).toBe("2027-03-29");
  });

  it("steps cleanly across the autumn transition", () => {
    expect(addDays("2027-10-30", 1)).toBe("2027-10-31");
    expect(addDays("2027-10-31", 1)).toBe("2027-11-01");
  });
});

describe("dateRange", () => {
  it("is inclusive at both ends", () => {
    expect(dateRange("2027-06-01", "2027-06-03")).toEqual([
      "2027-06-01",
      "2027-06-02",
      "2027-06-03",
    ]);
  });

  it("returns a single day when the ends match", () => {
    expect(dateRange("2027-06-01", "2027-06-01")).toEqual(["2027-06-01"]);
  });

  it("returns nothing when the range is inverted", () => {
    expect(dateRange("2027-06-03", "2027-06-01")).toEqual([]);
  });

  it("is capped so a careless range cannot produce a huge batch", () => {
    expect(dateRange("2027-01-01", "2027-12-31").length).toBeLessThanOrEqual(62);
  });
});

describe("operatingWallClockToUtc", () => {
  it("converts a winter morning at +01:00", () => {
    // 06:00 CET on 15 January is 05:00 UTC.
    expect(operatingWallClockToUtc("2027-01-15", "06:00").toISOString()).toBe(
      "2027-01-15T05:00:00.000Z"
    );
  });

  it("converts a summer morning at +02:00", () => {
    // 06:00 CEST on 15 July is 04:00 UTC.
    expect(operatingWallClockToUtc("2027-07-15", "06:00").toISOString()).toBe(
      "2027-07-15T04:00:00.000Z"
    );
  });

  it("converts an evening start that stays on the same UTC day", () => {
    expect(operatingWallClockToUtc("2027-07-15", "22:00").toISOString()).toBe(
      "2027-07-15T20:00:00.000Z"
    );
  });

  it("converts a start just after midnight", () => {
    // 00:30 CET on 10 March is 23:30 UTC on the 9th — the case that caught the
    // date-derivation bug in the DB layer.
    expect(operatingWallClockToUtc("2027-03-10", "00:30").toISOString()).toBe(
      "2027-03-09T23:30:00.000Z"
    );
  });

  it("is correct on the day the clocks go forward", () => {
    // 28 March 2027: 02:00 CET becomes 03:00 CEST. A 06:00 start is already
    // on summer time, so it is 04:00 UTC.
    expect(operatingWallClockToUtc("2027-03-28", "06:00").toISOString()).toBe(
      "2027-03-28T04:00:00.000Z"
    );
  });

  it("is correct on the day the clocks go back", () => {
    // 31 October 2027: 03:00 CEST becomes 02:00 CET. A 06:00 start is on
    // winter time, so it is 05:00 UTC.
    expect(operatingWallClockToUtc("2027-10-31", "06:00").toISOString()).toBe(
      "2027-10-31T05:00:00.000Z"
    );
  });

  it("round-trips through operatingDate for the calendar day the shift lands on", () => {
    // This is the invariant that keeps the proposal and migration 0011 in
    // agreement: the date the manager named is the date the row will carry.
    for (const [date, time] of [
      ["2027-03-10", "00:30"],
      ["2027-03-28", "06:00"],
      ["2027-07-15", "22:00"],
      ["2027-10-31", "06:00"],
      ["2027-12-24", "23:59"],
    ] as const) {
      expect(operatingDate(operatingWallClockToUtc(date, time))).toBe(date);
    }
  });
});

describe("isWallClockTime", () => {
  it("accepts valid 24-hour times", () => {
    for (const value of ["00:00", "06:00", "13:45", "23:59"]) {
      expect(isWallClockTime(value)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const value of ["24:00", "6:00", "06:60", "0600", "six", "", "06:00:00"]) {
      expect(isWallClockTime(value)).toBe(false);
    }
  });
});

/**
 * Calendar arithmetic in the operating timezone, for turning "tomorrow" into a
 * date the queries can use.
 *
 * Pure, and deliberately narrow. This does NOT derive `shifts.date` — migration
 * 0011 does that, with `at time zone 'Europe/Berlin'`, and stays the authority.
 * All this does is answer "which calendar day is the manager talking about",
 * using the same zone so the two never disagree.
 *
 * Europe/Berlin is named rather than offset so DST is the IANA database's
 * problem, exactly as in 0011.
 */

export const OPERATING_TIME_ZONE = "Europe/Berlin";

/** 'YYYY-MM-DD' for an instant, as seen in the operating timezone. */
export function operatingDate(instant: Date, timeZone = OPERATING_TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD, which is the shape Postgres `date` uses.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Shift a 'YYYY-MM-DD' by whole days without going through a timezone. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  // UTC arithmetic on a date-only value: no zone is involved either side, so
  // no DST transition can move the answer.
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** Inclusive list of calendar dates from `start` to `end`. Capped for safety. */
export function dateRange(start: string, end: string, max = 62): string[] {
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end && dates.length < max) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

/**
 * The UTC instant for a wall-clock time on a given day in the operating zone.
 *
 * Needed because a manager says "06:00" and `create_shift` takes a timestamptz.
 * Implemented by probing: guess UTC, ask what wall clock that lands on in
 * Berlin, and correct by the difference. Two passes settle every case
 * including the DST-transition hours, where the offset changes mid-day.
 */
export function operatingWallClockToUtc(
  isoDate: string,
  time: string,
  timeZone = OPERATING_TIME_ZONE
): Date {
  const [hour, minute] = time.split(":").map(Number);
  const [y, m, d] = isoDate.split("-").map(Number);

  let utc = Date.UTC(y, m - 1, d, hour, minute, 0, 0);
  for (let pass = 0; pass < 2; pass++) {
    const offsetMs = zoneOffsetMs(new Date(utc), timeZone);
    const corrected = Date.UTC(y, m - 1, d, hour, minute, 0, 0) - offsetMs;
    if (corrected === utc) break;
    utc = corrected;
  }
  return new Date(utc);
}

/** How far ahead of UTC the zone is, at this instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Intl renders midnight as hour 24 in some runtimes; normalise it.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second")
  );
  return asUtc - instant.getTime();
}

/** Simple 'HH:MM' guard used by the proposal schemas. */
export function isWallClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

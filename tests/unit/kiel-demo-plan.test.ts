import { describe, expect, it } from "vitest";
import {
  WORKSITES,
  JOBS,
  SHIFTS,
  CREW_SIZE,
  shiftWindow,
} from "../../scripts/kiel-demo-plan";

/**
 * The demo dataset is data, so its invariants are checked as data — no
 * database required. These assertions are what stop a future edit from
 * silently double-booking someone or breaking the wind-farm story.
 */

describe("dataset shape", () => {
  it("has the agreed counts", () => {
    expect(WORKSITES).toHaveLength(12);
    expect(JOBS).toHaveLength(6);
    expect(SHIFTS).toHaveLength(16);
    expect(SHIFTS.filter((s) => s.crew === null)).toHaveLength(3);
    expect(SHIFTS.filter((s) => s.crew !== null)).toHaveLength(13);
  });

  it("uses unique worksite and client names", () => {
    expect(new Set(WORKSITES.map((w) => w.name)).size).toBe(WORKSITES.length);
    expect(new Set(JOBS.map((j) => j.clientName)).size).toBe(JOBS.length);
  });

  it("every job and shift points at a defined worksite and client", () => {
    const siteNames = new Set(WORKSITES.map((w) => w.name));
    const clientNames = new Set(JOBS.map((j) => j.clientName));
    for (const job of JOBS) expect(siteNames.has(job.siteName), job.siteName).toBe(true);
    for (const shift of SHIFTS) {
      expect(siteNames.has(shift.siteName), shift.siteName).toBe(true);
      expect(clientNames.has(shift.clientName), shift.clientName).toBe(true);
    }
  });
});

describe("worksite geofences", () => {
  it("coordinates sit inside the Schleswig-Holstein demo region", () => {
    for (const site of WORKSITES) {
      expect(site.lat, site.name).toBeGreaterThan(54.0);
      expect(site.lat, site.name).toBeLessThan(54.6);
      expect(site.lng, site.name).toBeGreaterThan(9.0);
      expect(site.lng, site.name).toBeLessThan(10.5);
    }
  });

  it("radii stay inside the database check constraint (10–5000 m)", () => {
    for (const site of WORKSITES) {
      expect(site.radiusM, site.name).toBeGreaterThanOrEqual(10);
      expect(site.radiusM, site.name).toBeLessThanOrEqual(5000);
    }
  });

  it("records a verification source for every coordinate", () => {
    for (const site of WORKSITES) expect(site.source.length, site.name).toBeGreaterThan(0);
  });

  it("gives the wind-farm field zone a wide radius and the muster point a tight one", () => {
    const field = WORKSITES.find((w) => w.name.startsWith("Windpark Hamdorf"))!;
    const muster = WORKSITES.find((w) => w.name === "Hamdorf Meeting Point")!;
    expect(field.radiusM).toBe(1500);
    expect(muster.radiusM).toBe(200);
    expect(field.radiusM).toBeGreaterThan(muster.radiusM);
  });
});

describe("shift windows", () => {
  it("every shift ends after it starts", () => {
    for (const shift of SHIFTS) {
      const { start, end } = shiftWindow(shift);
      expect(end, `${shift.siteName} ${shift.dayOffset}`).toBeGreaterThan(start);
    }
  });

  it("represents the overnight Ostuferhafen shift as 22:00 to 06:00 next day", () => {
    const overnight = SHIFTS.find((s) => s.startHour === 22)!;
    expect(overnight.siteName).toBe("Ostuferhafen Cruise Terminal");
    expect(overnight.endHour).toBe(30); // 30 - 24 = 06:00 the following day
    const { start, end } = shiftWindow(overnight);
    expect(end - start).toBe(8);
    expect(Math.floor(end / 24)).toBe(overnight.dayOffset + 1);
  });

  it("spreads work across four consecutive days", () => {
    const days = [...new Set(SHIFTS.map((s) => s.dayOffset))].sort((a, b) => a - b);
    expect(days).toEqual([1, 2, 3, 4]);
  });

  it("requires at least one worker per shift", () => {
    for (const shift of SHIFTS) expect(shift.requiredCount).toBeGreaterThanOrEqual(1);
  });
});

describe("crew assignments", () => {
  it("uses only crew indexes the employee pool can satisfy", () => {
    for (const shift of SHIFTS) {
      if (shift.crew === null) continue;
      expect(shift.crew, shift.siteName).toBeGreaterThanOrEqual(0);
      expect(shift.crew, shift.siteName).toBeLessThan(CREW_SIZE);
    }
  });

  it("never double-books a crew member", () => {
    const byCrew = new Map<number, Array<{ start: number; end: number; label: string }>>();
    for (const shift of SHIFTS) {
      if (shift.crew === null) continue;
      const { start, end } = shiftWindow(shift);
      const list = byCrew.get(shift.crew) ?? [];
      list.push({ start, end, label: `${shift.siteName} d${shift.dayOffset}` });
      byCrew.set(shift.crew, list);
    }

    for (const [crew, shifts] of byCrew) {
      const ordered = [...shifts].sort((a, b) => a.start - b.start);
      for (let i = 1; i < ordered.length; i++) {
        expect(
          ordered[i].start,
          `crew ${crew}: "${ordered[i - 1].label}" overlaps "${ordered[i].label}"`
        ).toBeGreaterThanOrEqual(ordered[i - 1].end);
      }
    }
  });

  it("sends the same crew member from the Hamdorf muster into the field zone", () => {
    const muster = SHIFTS.find((s) => s.siteName === "Hamdorf Meeting Point")!;
    const field = SHIFTS.find(
      (s) => s.siteName.startsWith("Windpark Hamdorf") && s.dayOffset === muster.dayOffset
    )!;
    expect(muster.crew).not.toBeNull();
    expect(field.crew).toBe(muster.crew);
    // muster ends exactly when field work begins
    expect(shiftWindow(field).start).toBe(shiftWindow(muster).end);
  });

  it("never puts one person in two regions on the same day", () => {
    const isWindRegion = (name: string) =>
      name === "Hamdorf Meeting Point" || name.startsWith("Windpark Hamdorf");

    const seen = new Map<string, Set<string>>();
    for (const shift of SHIFTS) {
      if (shift.crew === null) continue;
      const key = `${shift.crew}:${shift.dayOffset}`;
      const regions = seen.get(key) ?? new Set<string>();
      regions.add(isWindRegion(shift.siteName) ? "wind" : "kiel");
      seen.set(key, regions);
    }
    for (const [key, regions] of seen) {
      expect([...regions], `crew/day ${key} spans two regions`).toHaveLength(1);
    }
  });

  it("leaves open shifts genuinely unassigned", () => {
    const open = SHIFTS.filter((s) => s.crew === null);
    expect(open.map((s) => s.siteName).sort()).toEqual([
      "Airport Kiel-Holtenau – South Parking",
      "Norwegenkai",
      "Port Parking Kiel",
    ]);
  });
});

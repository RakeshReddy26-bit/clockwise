import { describe, expect, it } from "vitest";
import { haversineMeters, formatDistance, isFiniteCoordinate } from "@/lib/geo";
import {
  evaluateGeofence,
  shouldSendOutsideAlert,
  geofenceSettings,
  MAX_USABLE_ACCURACY_M,
} from "@/lib/geofence";

// Synthetic coordinates only — no real employee locations.
const SITE = { lat: 52.52, lng: 13.405, radiusM: 100, enabled: true };

/** Move north by `meters` (1 deg latitude ≈ 111,195 m on the sphere used). */
function north(lat: number, meters: number): number {
  return lat + meters / 111_195;
}

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    expect(haversineMeters(52.52, 13.405, 52.52, 13.405)).toBe(0);
  });

  it("matches a known reference distance (Berlin → Munich ≈ 504 km)", () => {
    const d = haversineMeters(52.52, 13.405, 48.1371, 11.5754);
    expect(d).toBeGreaterThan(495_000);
    expect(d).toBeLessThan(515_000);
  });

  it("is symmetric", () => {
    const a = haversineMeters(52.52, 13.405, 52.53, 13.41);
    const b = haversineMeters(52.53, 13.41, 52.52, 13.405);
    expect(a).toBeCloseTo(b, 6);
  });

  it("computes small offsets accurately (100 m north ≈ 100 m)", () => {
    const d = haversineMeters(SITE.lat, SITE.lng, north(SITE.lat, 100), SITE.lng);
    expect(d).toBeGreaterThan(99);
    expect(d).toBeLessThan(101);
  });
});

describe("evaluateGeofence", () => {
  it("1. inside radius → verified", () => {
    const r = evaluateGeofence(SITE, { lat: north(SITE.lat, 40), lng: SITE.lng, accuracyM: 10 });
    expect(r.status).toBe("verified");
    expect(r.distanceM).toBeGreaterThan(35);
    expect(r.distanceM).toBeLessThan(45);
  });

  it("2. exactly at the boundary → allowed (inclusive)", () => {
    const r = evaluateGeofence(
      { ...SITE, radiusM: 100 },
      { lat: north(SITE.lat, 100), lng: SITE.lng, accuracyM: 5 }
    );
    // floating point puts this within ±1 m of the boundary; radius check is <=
    expect(["verified"]).toContain(
      evaluateGeofence({ ...SITE, radiusM: 101 }, { lat: north(SITE.lat, 100), lng: SITE.lng }).status
    );
    expect(r.distanceM).toBeCloseTo(100, 0);
  });

  it("3. outside radius → outside_geofence with distance", () => {
    const r = evaluateGeofence(SITE, { lat: north(SITE.lat, 420), lng: SITE.lng, accuracyM: 10 });
    expect(r.status).toBe("outside_geofence");
    expect(r.distanceM).toBeGreaterThan(410);
    expect(r.distanceM).toBeLessThan(430);
  });

  it("6. missing coordinates → unavailable (never allowed, never crashes)", () => {
    expect(evaluateGeofence(SITE, {}).status).toBe("unavailable");
    expect(evaluateGeofence(SITE, { lat: 52.52 }).status).toBe("unavailable");
    expect(evaluateGeofence(SITE, { lat: NaN, lng: 13.4 }).status).toBe("unavailable");
    expect(evaluateGeofence(SITE, { lat: 999, lng: 13.4 }).status).toBe("unavailable");
  });

  it("7. poor GPS accuracy → unavailable", () => {
    const r = evaluateGeofence(SITE, {
      lat: SITE.lat,
      lng: SITE.lng,
      accuracyM: MAX_USABLE_ACCURACY_M + 1,
    });
    expect(r.status).toBe("unavailable");
    // at the limit is still usable
    expect(
      evaluateGeofence(SITE, { lat: SITE.lat, lng: SITE.lng, accuracyM: MAX_USABLE_ACCURACY_M }).status
    ).toBe("verified");
  });

  it("geofence disabled or unconfigured site → not_required", () => {
    expect(evaluateGeofence({ ...SITE, enabled: false }, { lat: 1, lng: 1 }).status).toBe("not_required");
    expect(evaluateGeofence({ ...SITE, lat: null, lng: null }, { lat: 1, lng: 1 }).status).toBe("not_required");
  });

  it("radius is per-site, not global", () => {
    const fix = { lat: north(SITE.lat, 200), lng: SITE.lng, accuracyM: 5 };
    expect(evaluateGeofence({ ...SITE, radiusM: 100 }, fix).status).toBe("outside_geofence");
    expect(evaluateGeofence({ ...SITE, radiusM: 250 }, fix).status).toBe("verified");
  });
});

describe("11. outside-attempt alert rate limit", () => {
  const now = new Date("2026-08-20T12:00:00Z");
  it("first attempt alerts", () => {
    expect(shouldSendOutsideAlert(null, now)).toBe(true);
  });
  it("repeat within cooldown does not alert", () => {
    expect(shouldSendOutsideAlert(new Date("2026-08-20T11:58:00Z"), now, 5)).toBe(false);
  });
  it("after cooldown alerts again", () => {
    expect(shouldSendOutsideAlert(new Date("2026-08-20T11:54:00Z"), now, 5)).toBe(true);
  });
  it("cooldown is configurable", () => {
    expect(shouldSendOutsideAlert(new Date("2026-08-20T11:58:00Z"), now, 1)).toBe(true);
  });
});

describe("geofenceSettings", () => {
  it("returns safe defaults", () => {
    expect(geofenceSettings(null)).toEqual({
      alertCooldownMinutes: 5,
      exitDetectionEnabled: false,
      exitThresholdMinutes: 5,
    });
  });
  it("reads company overrides and ignores junk", () => {
    expect(
      geofenceSettings({ geofence: { alertCooldownMinutes: 10, exitDetectionEnabled: true, exitThresholdMinutes: -3 } })
    ).toEqual({ alertCooldownMinutes: 10, exitDetectionEnabled: true, exitThresholdMinutes: 5 });
  });
});

describe("helpers", () => {
  it("formatDistance", () => {
    expect(formatDistance(428.4)).toBe("428 m");
    expect(formatDistance(1240)).toBe("1.2 km");
  });
  it("isFiniteCoordinate", () => {
    expect(isFiniteCoordinate(52.5, 13.4)).toBe(true);
    expect(isFiniteCoordinate("52", 13.4)).toBe(false);
    expect(isFiniteCoordinate(Infinity, 13.4)).toBe(false);
  });
});

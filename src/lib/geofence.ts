/**
 * Geofence evaluation — pure decision logic, unit-tested.
 * The SERVER is the only authority: actions re-run this with coordinates from
 * the request and the location row from the database. Client-computed
 * distances are never trusted.
 */
import { haversineMeters, isFiniteCoordinate } from "@/lib/geo";

/** GPS fixes worse than this are unusable for verification. */
export const MAX_USABLE_ACCURACY_M = 200;

/** Default alert cooldown per assignment (companies.settings.geofence.alertCooldownMinutes). */
export const DEFAULT_ALERT_COOLDOWN_MINUTES = 5;

export type GeofenceSite = {
  lat: number | null;
  lng: number | null;
  radiusM: number;
  enabled: boolean;
};

export type GeoFix = {
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
};

export type ClockVerification =
  | { status: "not_required"; distanceM: null }
  | { status: "unavailable"; distanceM: null }
  | { status: "verified"; distanceM: number }
  | { status: "outside_geofence"; distanceM: number };

/**
 * Decide a clock-in/out verification.
 * - Geofence disabled or site has no coordinates → not_required.
 * - Missing coordinates or accuracy worse than MAX_USABLE_ACCURACY_M → unavailable.
 * - distance <= radius (boundary inclusive) → verified, else outside_geofence.
 */
export function evaluateGeofence(site: GeofenceSite, fix: GeoFix): ClockVerification {
  if (!site.enabled || !isFiniteCoordinate(site.lat, site.lng)) {
    return { status: "not_required", distanceM: null };
  }
  if (!isFiniteCoordinate(fix.lat ?? null, fix.lng ?? null)) {
    return { status: "unavailable", distanceM: null };
  }
  if (
    fix.accuracyM != null &&
    (!Number.isFinite(fix.accuracyM) || fix.accuracyM > MAX_USABLE_ACCURACY_M)
  ) {
    return { status: "unavailable", distanceM: null };
  }

  const distanceM = haversineMeters(
    site.lat as number,
    site.lng as number,
    fix.lat as number,
    fix.lng as number
  );
  return distanceM <= site.radiusM
    ? { status: "verified", distanceM }
    : { status: "outside_geofence", distanceM };
}

/**
 * Outside-attempt alert rate limit: at most one alert per assignment within
 * the cooldown window. Pure — callers pass the newest previous alert time.
 */
export function shouldSendOutsideAlert(
  lastAlertAt: Date | null,
  now: Date,
  cooldownMinutes: number = DEFAULT_ALERT_COOLDOWN_MINUTES
): boolean {
  if (!lastAlertAt) return true;
  return now.getTime() - lastAlertAt.getTime() >= cooldownMinutes * 60_000;
}

/** Read per-company geofence settings with safe defaults. */
export function geofenceSettings(companySettings: Record<string, unknown> | null | undefined): {
  alertCooldownMinutes: number;
  exitDetectionEnabled: boolean;
  exitThresholdMinutes: number;
} {
  const g = (companySettings?.["geofence"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d;
  return {
    alertCooldownMinutes: num(g["alertCooldownMinutes"], DEFAULT_ALERT_COOLDOWN_MINUTES),
    // Exit detection is DESIGNED but not active in the prototype (privacy).
    exitDetectionEnabled: g["exitDetectionEnabled"] === true,
    exitThresholdMinutes: num(g["exitThresholdMinutes"], 5),
  };
}

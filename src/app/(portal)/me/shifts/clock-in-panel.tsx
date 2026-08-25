"use client";

import { useState, useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { MapPin, LocateFixed, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { SiteMap } from "@/components/site-map";
import { haversineMeters, formatDistance } from "@/lib/geo";
import { MAX_USABLE_ACCURACY_M } from "@/lib/geofence";
import { clockIn, clockOut, requestManualClockIn } from "./actions";

type Fix = { lat: number; lng: number; accuracyM: number };
type SiteState = "inside" | "outside" | "required" | "unavailable" | "off";

type Props = {
  assignmentId: string;
  siteName: string | null;
  site: { lat: number | null; lng: number | null; radiusM: number; enabled: boolean };
  runningEntryId: string | null;
  hasPendingRequest: boolean;
};

/**
 * Client half of the geofenced clock-in. The distance shown here is a
 * PREVIEW ONLY — the server independently recomputes and decides.
 */
export function ClockInPanel({
  assignmentId,
  siteName,
  site,
  runningEntryId,
  hasPendingRequest,
}: Props) {
  const t = useTranslations("clockin");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [fix, setFix] = useState<Fix | null>(null);
  const [geoError, setGeoError] = useState(false);
  const [message, setMessage] = useState<
    | {
        kind: "success" | "outside" | "unavailable" | "pending" | "error" | "inactive";
        distanceM?: number;
      }
    | null
  >(null);
  const [showManualForm, setShowManualForm] = useState(false);

  const geofenceActive = site.enabled && site.lat != null && site.lng != null;

  const previewDistance =
    geofenceActive && fix
      ? haversineMeters(site.lat as number, site.lng as number, fix.lat, fix.lng)
      : null;

  const siteState: SiteState = !geofenceActive
    ? "off"
    : geoError
      ? "unavailable"
      : !fix
        ? "required"
        : fix.accuracyM > MAX_USABLE_ACCURACY_M
          ? "unavailable"
          : (previewDistance as number) <= site.radiusM
            ? "inside"
            : "outside";

  const locate = useCallback(() => {
    setGeoError(false);
    if (!("geolocation" in navigator)) {
      setGeoError(true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setFix({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        }),
      () => setGeoError(true),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 15_000 }
    );
  }, []);

  const geoPayload = fix
    ? { lat: fix.lat, lng: fix.lng, accuracyM: Math.round(fix.accuracyM) }
    : {};

  function handleClockIn() {
    setMessage(null);
    startTransition(async () => {
      const result = await clockIn({ shiftAssignmentId: assignmentId, ...geoPayload });
      if (!result.ok) {
        setMessage({ kind: "error" });
        return;
      }
      const data = result.data;
      if (data.outcome === "clocked_in") {
        setMessage({ kind: "success" });
        router.refresh();
      } else if (data.outcome === "outside") {
        setMessage({ kind: "outside", distanceM: data.distanceM });
      } else if (data.outcome === "location_unavailable") {
        setMessage({ kind: "unavailable" });
      } else if (data.outcome === "assignment_not_active") {
        setMessage({ kind: "inactive" });
        router.refresh();
      } else {
        setMessage({ kind: "error" });
      }
    });
  }

  function handleClockOut() {
    if (!runningEntryId) return;
    setMessage(null);
    startTransition(async () => {
      const result = await clockOut({ timeEntryId: runningEntryId, ...geoPayload });
      if (result.ok) router.refresh();
      else setMessage({ kind: "error" });
    });
  }

  function handleManualRequest(formData: FormData) {
    startTransition(async () => {
      const result = await requestManualClockIn({
        shiftAssignmentId: assignmentId,
        reason: String(formData.get("reason")) as
          | "gps_inaccurate"
          | "entrance_moved"
          | "alternate_location"
          | "manager_instructed"
          | "other",
        reasonNote: String(formData.get("note") ?? "").slice(0, 500) || undefined,
        ...geoPayload,
      });
      setShowManualForm(false);
      if (result.ok) {
        setMessage({ kind: "pending" });
        router.refresh();
      } else {
        setMessage({ kind: "error" });
      }
    });
  }

  const stateBadge: Record<SiteState, React.ReactNode> = {
    inside: (
      <Badge variant="success">
        <CheckCircle2 className="mr-1 size-3" /> {t("insideSite")}
      </Badge>
    ),
    outside: (
      <Badge variant="destructive">
        <AlertTriangle className="mr-1 size-3" /> {t("outsideSite")}
      </Badge>
    ),
    required: <Badge variant="warning">{t("locationRequired")}</Badge>,
    unavailable: <Badge variant="secondary">{t("locationUnavailable")}</Badge>,
    off: <Badge variant="secondary">{t("geofenceOff")}</Badge>,
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <MapPin className="size-4 text-muted-foreground" />
          {t("siteStatus")}
        </div>
        {stateBadge[siteState]}
      </div>

      {siteState === "outside" && previewDistance != null && (
        <p className="text-sm text-muted-foreground">
          {t("approxDistance", { distance: formatDistance(previewDistance) })}
        </p>
      )}

      {geofenceActive && (
        <SiteMap
          siteLat={site.lat as number}
          siteLng={site.lng as number}
          radiusM={site.radiusM}
          siteName={siteName ?? ""}
          userLat={fix?.lat}
          userLng={fix?.lng}
        />
      )}

      {geofenceActive && !fix && (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3 text-center">
          <p className="text-sm text-muted-foreground">{t("locationExplainer")}</p>
          <Button variant="outline" onClick={locate} disabled={isPending}>
            <LocateFixed /> {t("enableLocation")}
          </Button>
          {geoError && <p className="text-xs text-destructive">{t("locationDenied")}</p>}
        </div>
      )}
      {geofenceActive && fix && (
        <Button variant="ghost" size="sm" onClick={locate} disabled={isPending} className="self-start">
          <LocateFixed /> {t("refreshLocation")}
        </Button>
      )}

      {message?.kind === "success" && (
        <p role="status" className="text-sm font-medium text-success">{t("clockedIn")}</p>
      )}
      {message?.kind === "outside" && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t("rejectedOutside", {
            distance: formatDistance(message.distanceM ?? 0),
          })}
        </p>
      )}
      {message?.kind === "unavailable" && (
        <p role="alert" className="text-sm text-muted-foreground">{t("rejectedUnavailable")}</p>
      )}
      {/* Only until the server catches up. requestManualClockIn() revalidates
          /me/shifts, so hasPendingRequest becomes true a moment later and the
          persistent notice below says the same sentence — without this guard
          both render at once and the employee sees it twice. */}
      {message?.kind === "pending" && !hasPendingRequest && (
        <p role="status" className="text-sm font-medium text-warning">{t("manualPending")}</p>
      )}
      {message?.kind === "inactive" && (
        <p role="alert" className="text-sm font-medium text-destructive">{t("assignmentInactive")}</p>
      )}
      {message?.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">{t("genericError")}</p>
      )}

      {runningEntryId ? (
        <Button onClick={handleClockOut} disabled={isPending} variant="destructive">
          {t("clockOut")}
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <Button
            onClick={handleClockIn}
            disabled={isPending || (geofenceActive && (siteState === "required" || siteState === "outside"))}
          >
            {t("clockIn")}
          </Button>

          {(siteState === "outside" || siteState === "unavailable") &&
            !hasPendingRequest &&
            message?.kind !== "pending" &&
            (showManualForm ? (
              <form action={handleManualRequest} className="flex flex-col gap-2 rounded-lg border p-3">
                <Label htmlFor="reason">{t("manualReason")}</Label>
                <select
                  id="reason"
                  name="reason"
                  required
                  className="h-9 rounded-md border border-input bg-card px-2 text-sm"
                >
                  <option value="gps_inaccurate">{t("reasonGps")}</option>
                  <option value="entrance_moved">{t("reasonEntrance")}</option>
                  <option value="alternate_location">{t("reasonAlternate")}</option>
                  <option value="manager_instructed">{t("reasonInstructed")}</option>
                  <option value="other">{t("reasonOther")}</option>
                </select>
                <Label htmlFor="note">{t("manualNote")}</Label>
                <textarea
                  id="note"
                  name="note"
                  rows={2}
                  maxLength={500}
                  className="rounded-md border border-input bg-card p-2 text-sm"
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={isPending}>
                    {t("sendRequest")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setShowManualForm(false)}>
                    {t("cancel")}
                  </Button>
                </div>
              </form>
            ) : (
              <Button variant="outline" onClick={() => setShowManualForm(true)}>
                {t("requestManual")}
              </Button>
            ))}

          {hasPendingRequest && (
            <p className="text-sm text-warning">{t("manualPending")}</p>
          )}
        </div>
      )}
    </div>
  );
}

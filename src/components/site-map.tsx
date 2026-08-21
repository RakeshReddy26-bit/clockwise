"use client";

/**
 * Provider-free site map: SVG schematic of the geofence circle, site marker,
 * and (if available) the employee position. Replaceable later by a real map
 * provider behind the same props. "Open in maps" uses a plain URL — no key.
 */
import { useTranslations } from "next-intl";
import { haversineMeters } from "@/lib/geo";

type Props = {
  siteLat: number;
  siteLng: number;
  radiusM: number;
  siteName: string;
  userLat?: number | null;
  userLng?: number | null;
};

export function SiteMap({ siteLat, siteLng, radiusM, siteName, userLat, userLng }: Props) {
  const t = useTranslations("clockin");
  const size = 260;
  const center = size / 2;

  // Scale: geofence circle occupies 38% of the view; clamp the user marker
  // to the edge when far away so the schematic stays readable.
  const circleR = size * 0.38;
  const metersPerPx = radiusM / circleR;

  let user: { x: number; y: number; clamped: boolean } | null = null;
  if (userLat != null && userLng != null) {
    const d = haversineMeters(siteLat, siteLng, userLat, userLng);
    const dxM =
      haversineMeters(siteLat, siteLng, siteLat, userLng) * (userLng >= siteLng ? 1 : -1);
    const dyM =
      haversineMeters(siteLat, siteLng, userLat, siteLng) * (userLat >= siteLat ? -1 : 1);
    let x = center + dxM / metersPerPx;
    let y = center + dyM / metersPerPx;
    const maxR = size * 0.46;
    const dist = Math.hypot(x - center, y - center);
    const clamped = dist > maxR;
    if (clamped) {
      x = center + ((x - center) / dist) * maxR;
      y = center + ((y - center) / dist) * maxR;
    }
    user = { x, y, clamped: clamped || d > radiusM * 4 };
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="w-full max-w-65 rounded-lg border bg-secondary"
        role="img"
        aria-label={siteName}
      >
        <circle
          cx={center}
          cy={center}
          r={circleR}
          fill="var(--accent)"
          fillOpacity="0.5"
          stroke="var(--primary)"
          strokeDasharray="4 3"
        />
        <circle cx={center} cy={center} r={5} fill="var(--primary)" />
        <text
          x={center}
          y={center + 20}
          textAnchor="middle"
          fontSize="11"
          fill="var(--foreground)"
        >
          {siteName}
        </text>
        <text
          x={center}
          y={center - circleR - 6}
          textAnchor="middle"
          fontSize="10"
          fill="var(--muted-foreground)"
        >
          {radiusM} m
        </text>
        {user && (
          <g>
            <circle cx={user.x} cy={user.y} r={6} fill="var(--card)" stroke="var(--destructive)" strokeWidth={user.clamped ? 2 : 0} />
            <circle cx={user.x} cy={user.y} r={4} fill={user.clamped ? "var(--destructive)" : "var(--success)"} />
          </g>
        )}
      </svg>
      <a
        href={`https://www.google.com/maps?q=${siteLat},${siteLng}`}
        target="_blank"
        rel="noreferrer"
        className="text-xs font-medium text-primary underline-offset-4 hover:underline"
      >
        {t("openSiteMap")}
      </a>
    </div>
  );
}

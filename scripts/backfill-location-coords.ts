/**
 * Targeted backfill: set site coordinates on the EXISTING Meridian location
 * rows. Nothing is deleted, no reseed — updates by location name only.
 * Idempotent: safe to run multiple times.
 *
 * Run:  npm run backfill:coords
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
config();

const COMPANY_NAME = "Meridian Facility & Service GmbH";
// Pre-rename name, so this script still works on a database that has not run
// scripts/rename-demo-company.ts yet.
const LEGACY_COMPANY_NAME = "Meridian Sicherheit & Service GmbH";

// name → [lat, lng, geofence radius m]
const COORDS: Record<string, [number, number, number]> = {
  "Zentrale Berlin-Mitte": [52.53245, 13.38344, 100],
  "Bürocampus Adlershof": [52.43033, 13.53245, 150],
  "Logistikpark Großbeeren": [52.35871, 13.30012, 250],
  "Einkaufszentrum Spandau": [52.53514, 13.19825, 100],
  "Klinikum Buch": [52.62612, 13.50291, 150],
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  const { data: companies, error: cErr } = await db
    .from("companies")
    .select("id, name")
    .in("name", [COMPANY_NAME, LEGACY_COMPANY_NAME]);
  if (cErr) throw new Error(cErr.message);
  const company = companies?.[0];
  if (!company) {
    console.error(`Company "${COMPANY_NAME}" not found — nothing changed.`);
    process.exit(1);
  }

  const { data: locations, error: lErr } = await db
    .from("locations")
    .select("id, name, lat, lng")
    .eq("company_id", company.id);
  if (lErr) throw new Error(lErr.message);

  let updated = 0;
  for (const loc of locations ?? []) {
    const target = COORDS[loc.name];
    if (!target) {
      console.log(`skip   ${loc.name} (no coordinates defined)`);
      continue;
    }
    const [lat, lng, radius] = target;

    // Try full update (needs migration 0004); fall back to lat/lng only.
    let error = (
      await db
        .from("locations")
        .update({ lat, lng, geofence_radius_m: radius, geofence_enabled: true })
        .eq("id", loc.id)
    ).error;
    if (error && /geofence/.test(error.message)) {
      console.warn(`note   migration 0004 not applied yet — setting lat/lng only for ${loc.name}`);
      error = (await db.from("locations").update({ lat, lng }).eq("id", loc.id)).error;
    }
    if (error) throw new Error(`${loc.name}: ${error.message}`);
    console.log(
      `${loc.lat == null ? "set   " : "update"} ${loc.name} → ${lat}, ${lng} (r=${radius} m)`
    );
    updated++;
  }

  console.log(`Done. ${updated} location(s) updated, nothing deleted.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

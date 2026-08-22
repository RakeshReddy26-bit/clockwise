/**
 * Idempotent demo data: GE-PACK Services as an external CLIENT of Meridian.
 *
 * Demonstrates the full operational chain:
 *   GE-PACK client → Meridian job → GE-PACK worksite (geofenced)
 *   → shifts → assignments → geofenced clock-in → attendance dashboard
 *
 * Creates only what is missing:
 *   - 1 location  "GE-PACK Services – Werk Nord"   (geofence 150 m, enabled)
 *   - 1 job       client_name "GE-PACK Services"
 *   - 3 shifts    on that job/location, over the next few days
 *   - 2 assignments for the first shift, using existing Meridian employees
 *
 * Never deletes, never reseeds, never edits unrelated rows. Running it twice
 * changes nothing: each object is matched by its natural key first.
 *
 * "GE-PACK Services" and the worksite name are identities — they are never
 * translated (see src/lib/taxonomy.ts).
 *
 * Run:  npm run add:gepack-demo
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
config();

const COMPANY_NAMES = [
  "Meridian Facility & Service GmbH",
  "Meridian Sicherheit & Service GmbH", // legacy, pre-rename
];

const CLIENT_NAME = "GE-PACK Services";
const SITE_NAME = "GE-PACK Services – Werk Nord";
const SITE_ADDRESS = "Nordring 44, 13407 Berlin";
const SITE_LAT = 52.56412;
const SITE_LNG = 13.35107;
const SITE_RADIUS_M = 150;

/** Role is taxonomy — it localizes; the client and site names do not. */
const SHIFT_ROLE = "Logistik & Event";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
function at(dateStr: string, hour: number): string {
  return `${dateStr}T${String(hour).padStart(2, "0")}:00:00+02:00`;
}

/** [dayOffset, startHour, endHour, requiredCount] */
const SHIFT_PLAN: Array<[number, number, number, number]> = [
  [1, 6, 14, 2],
  [1, 14, 22, 1],
  [2, 6, 14, 2],
];

async function main() {
  // ---- Preflight ----------------------------------------------------------
  const { data: companies, error: companyError } = await db
    .from("companies")
    .select("id, name")
    .in("name", COMPANY_NAMES);
  if (companyError) throw new Error(`preflight: ${companyError.message}`);

  if (!companies || companies.length === 0) {
    console.error("Aborting: Meridian demo company not found. Nothing changed.");
    process.exit(1);
  }
  if (companies.length > 1) {
    console.error("Aborting: Meridian company cannot be resolved uniquely. Nothing changed.");
    process.exit(1);
  }
  const company = companies[0];
  const cid = company.id;
  console.log(`Company: ${company.name}`);
  console.log(`company_id: ${cid}\n`);

  let created = 0;

  // ---- Worksite -----------------------------------------------------------
  const { data: existingLocation, error: locationError } = await db
    .from("locations")
    .select("id, name, lat, lng, geofence_radius_m, geofence_enabled")
    .eq("company_id", cid)
    .eq("name", SITE_NAME)
    .maybeSingle();
  if (locationError) throw new Error(`locations: ${locationError.message}`);

  let locationId: string;
  if (existingLocation) {
    locationId = existingLocation.id;
    console.log(`location: exists — "${SITE_NAME}" (${locationId})`);
  } else {
    const { data: inserted, error } = await db
      .from("locations")
      .insert({
        company_id: cid,
        name: SITE_NAME,
        address: SITE_ADDRESS,
        lat: SITE_LAT,
        lng: SITE_LNG,
        geofence_radius_m: SITE_RADIUS_M,
        geofence_enabled: true,
      })
      .select("id")
      .single();
    if (error || !inserted) throw new Error(`locations insert: ${error?.message}`);
    locationId = inserted.id;
    created++;
    console.log(
      `location: created — "${SITE_NAME}" (${locationId}) · ${SITE_LAT}, ${SITE_LNG} · geofence ${SITE_RADIUS_M} m`
    );
  }

  // ---- Job ----------------------------------------------------------------
  const { data: existingJob, error: jobError } = await db
    .from("jobs")
    .select("id")
    .eq("company_id", cid)
    .eq("client_name", CLIENT_NAME)
    .maybeSingle();
  if (jobError) throw new Error(`jobs: ${jobError.message}`);

  let jobId: string;
  if (existingJob) {
    jobId = existingJob.id;
    console.log(`job:      exists — client "${CLIENT_NAME}" (${jobId})`);
  } else {
    const { data: inserted, error } = await db
      .from("jobs")
      .insert({
        company_id: cid,
        client_name: CLIENT_NAME,
        location_id: locationId,
        description: `Personaleinsatz für ${CLIENT_NAME} am Standort ${SITE_NAME}.`,
      })
      .select("id")
      .single();
    if (error || !inserted) throw new Error(`jobs insert: ${error?.message}`);
    jobId = inserted.id;
    created++;
    console.log(`job:      created — client "${CLIENT_NAME}" (${jobId})`);
  }

  // ---- Shifts -------------------------------------------------------------
  const shiftIds: string[] = [];
  for (const [offset, startHour, endHour, requiredCount] of SHIFT_PLAN) {
    const date = day(offset);
    const startTime = at(date, startHour);

    const { data: existingShift, error } = await db
      .from("shifts")
      .select("id")
      .eq("company_id", cid)
      .eq("job_id", jobId)
      .eq("start_time", startTime)
      .maybeSingle();
    if (error) throw new Error(`shifts: ${error.message}`);

    if (existingShift) {
      shiftIds.push(existingShift.id);
      console.log(`shift:    exists — ${date} ${startHour}:00–${endHour}:00`);
      continue;
    }

    const { data: inserted, error: insertError } = await db
      .from("shifts")
      .insert({
        company_id: cid,
        job_id: jobId,
        date,
        start_time: startTime,
        end_time: at(date, endHour),
        required_count: requiredCount,
        required_role: SHIFT_ROLE,
        instructions: "Anmeldung am Werkstor Nord. Sicherheitsschuhe erforderlich.",
        contact_person: "Marco Litfin (+49 152 5550100)",
      })
      .select("id")
      .single();
    if (insertError || !inserted) throw new Error(`shifts insert: ${insertError?.message}`);
    shiftIds.push(inserted.id);
    created++;
    console.log(
      `shift:    created — ${date} ${startHour}:00–${endHour}:00 · needs ${requiredCount}`
    );
  }

  // ---- Assignments on the first shift -------------------------------------
  const firstShiftId = shiftIds[0];
  if (firstShiftId) {
    const { data: employees, error } = await db
      .from("employees")
      .select("id, full_name")
      .eq("company_id", cid)
      .eq("employment_status", "active")
      .order("employee_no", { ascending: true })
      .limit(2);
    if (error) throw new Error(`employees: ${error.message}`);

    for (const employee of employees ?? []) {
      const { data: existingAssignment, error: assignmentError } = await db
        .from("shift_assignments")
        .select("id")
        .eq("shift_id", firstShiftId)
        .eq("employee_id", employee.id)
        .maybeSingle();
      if (assignmentError) throw new Error(`shift_assignments: ${assignmentError.message}`);

      if (existingAssignment) {
        console.log(`assign:   exists — ${employee.full_name}`);
        continue;
      }

      const { error: insertError } = await db.from("shift_assignments").insert({
        company_id: cid,
        shift_id: firstShiftId,
        employee_id: employee.id,
        status: "assigned",
      });
      if (insertError) throw new Error(`shift_assignments insert: ${insertError.message}`);
      created++;
      console.log(`assign:   created — ${employee.full_name}`);
    }
  }

  console.log(`\nCreated ${created} new row(s).`);
  if (created === 0) console.log("Everything already existed — nothing to do.");
  console.log(
    "Untouched: existing locations, jobs, shifts, employees, time entries, alerts, users, memberships."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

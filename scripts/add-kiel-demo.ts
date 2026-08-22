/**
 * Idempotent demo data: Kiel and Rendsburg-Eckernförde worksite geography.
 *
 * Adds a second operational region alongside the existing Berlin and GE-PACK
 * demo data, neither of which is touched. The dataset itself lives in
 * scripts/kiel-demo-plan.ts and is unit-tested; this file only writes it.
 *
 * Creates what is missing — worksites by name, jobs by client name, shifts by
 * (job, start time), assignments by (shift, employee) — and changes nothing on
 * a second run. No deletes, no updates, no reseed.
 *
 * Run:  npm run add:kiel-demo
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { WORKSITES, JOBS, SHIFTS, CREW_SIZE, type ShiftSpec } from "./kiel-demo-plan";

config({ path: ".env.local" });
config();

const COMPANY_NAMES = [
  "Meridian Facility & Service GmbH",
  "Meridian Sicherheit & Service GmbH", // legacy, pre-rename
];

const CONTACT_PERSON = "Aylin Kaya (+49 152 5550101)";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

function isoDate(dayOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

/** Hours >= 24 roll into the following day, so overnight shifts stay valid. */
function isoTimestamp(dayOffset: number, hour: number): string {
  const date = isoDate(dayOffset + Math.floor(hour / 24));
  return `${date}T${String(hour % 24).padStart(2, "0")}:00:00+02:00`;
}

async function resolveCompanyId(): Promise<string> {
  const { data, error } = await db.from("companies").select("id, name").in("name", COMPANY_NAMES);
  if (error) throw new Error(`preflight: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error("Meridian demo company not found. Nothing changed.");
  }
  if (data.length > 1) {
    throw new Error("Meridian company cannot be resolved uniquely. Nothing changed.");
  }
  console.log(`Company: ${data[0].name}`);
  console.log(`company_id: ${data[0].id}\n`);
  return data[0].id;
}

/**
 * Insert a row unless one already matching `match` exists, and return its id.
 * This single helper is what makes the whole script idempotent.
 */
async function findOrCreate(
  table: string,
  match: Record<string, string>,
  row: Record<string, unknown>,
  label: string
): Promise<{ id: string; created: boolean }> {
  let query = db.from(table).select("id");
  for (const [column, value] of Object.entries(match)) query = query.eq(column, value);

  const { data: existing, error } = await query.maybeSingle();
  if (error) throw new Error(`${table}: ${error.message}`);
  if (existing) {
    console.log(`  exists   ${label}`);
    return { id: existing.id, created: false };
  }

  const { data: inserted, error: insertError } = await db
    .from(table)
    .insert(row)
    .select("id")
    .single();
  if (insertError || !inserted) throw new Error(`${table} insert: ${insertError?.message}`);
  console.log(`  created  ${label}`);
  return { id: inserted.id, created: true };
}

async function main() {
  const companyId = await resolveCompanyId();
  const counts = { locations: 0, jobs: 0, shifts: 0, assignments: 0 };

  console.log("Worksites");
  const locationIds = new Map<string, string>();
  for (const site of WORKSITES) {
    const { id, created } = await findOrCreate(
      "locations",
      { company_id: companyId, name: site.name },
      {
        company_id: companyId,
        name: site.name,
        address: site.address,
        lat: site.lat,
        lng: site.lng,
        geofence_radius_m: site.radiusM,
        geofence_enabled: true,
      },
      `${site.name} · ${site.lat}, ${site.lng} · ${site.radiusM} m`
    );
    locationIds.set(site.name, id);
    if (created) counts.locations++;
  }

  console.log("\nJobs");
  const jobIds = new Map<string, string>();
  const jobInstructions = new Map<string, string>();
  for (const job of JOBS) {
    const { id, created } = await findOrCreate(
      "jobs",
      { company_id: companyId, client_name: job.clientName },
      {
        company_id: companyId,
        client_name: job.clientName,
        location_id: locationIds.get(job.siteName) ?? null,
        description: job.description,
      },
      `${job.clientName} → ${job.siteName}`
    );
    jobIds.set(job.clientName, id);
    jobInstructions.set(job.clientName, job.instructions);
    if (created) counts.jobs++;
  }

  console.log("\nShifts");
  const crewAssignments: Array<{ shiftId: string; crew: number }> = [];
  let openShifts = 0;

  for (const shift of SHIFTS) {
    const jobId = jobIds.get(shift.clientName);
    if (!jobId) continue;
    const startTime = isoTimestamp(shift.dayOffset, shift.startHour);

    const { id, created } = await findOrCreate(
      "shifts",
      { company_id: companyId, job_id: jobId, start_time: startTime },
      {
        company_id: companyId,
        job_id: jobId,
        date: isoDate(shift.dayOffset),
        start_time: startTime,
        end_time: isoTimestamp(shift.dayOffset, shift.endHour),
        required_count: shift.requiredCount,
        required_role: shift.role,
        instructions: jobInstructions.get(shift.clientName) ?? null,
        contact_person: CONTACT_PERSON,
      },
      `${shift.siteName} · ${isoDate(shift.dayOffset)} ${shift.startHour}:00–${shift.endHour % 24}:00 · ${shift.role}${shift.crew === null ? " · OPEN" : ""}`
    );
    if (created) counts.shifts++;

    if (shift.crew === null) openShifts++;
    else crewAssignments.push({ shiftId: id, crew: shift.crew });
  }

  console.log("\nAssignments");
  const { data: employees, error } = await db
    .from("employees")
    .select("id, full_name")
    .eq("company_id", companyId)
    .eq("employment_status", "active")
    .order("employee_no", { ascending: true })
    .limit(CREW_SIZE);
  if (error) throw new Error(`employees: ${error.message}`);

  const pool = employees ?? [];
  if (pool.length === 0) {
    console.log("  skipped — no active employees found");
  } else {
    if (pool.length < CREW_SIZE) {
      console.warn(
        `  note: only ${pool.length} active employee(s) available; the plan plans for ${CREW_SIZE}, so some will take more than one shift.`
      );
    }
    for (const { shiftId, crew } of crewAssignments) {
      const employee = pool[crew % pool.length];
      const { created } = await findOrCreate(
        "shift_assignments",
        { shift_id: shiftId, employee_id: employee.id },
        {
          company_id: companyId,
          shift_id: shiftId,
          employee_id: employee.id,
          status: "assigned",
        },
        employee.full_name
      );
      if (created) counts.assignments++;
    }
  }

  console.log(
    `\nCreated ${counts.locations} worksite(s), ${counts.jobs} job(s), ${counts.shifts} shift(s), ${counts.assignments} assignment(s).`
  );
  console.log(`${openShifts} shift(s) intentionally left open for the replacement workflow.`);
  if (Object.values(counts).every((n) => n === 0)) {
    console.log("Everything already existed — nothing to do.");
  }
  console.log("Untouched: Berlin and GE-PACK demo data, employees, time entries, alerts, users.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

export type { ShiftSpec };

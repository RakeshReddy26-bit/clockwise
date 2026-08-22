/**
 * Idempotent demo data: Kiel and Rendsburg-Eckernförde worksite geography.
 *
 * Adds a second operational region alongside the existing Berlin and GE-PACK
 * demo data (neither is touched). Twelve worksites across cruise terminals,
 * ferry quays, a railway station, parking facilities, airport parking and a
 * two-zone wind farm — enough geography to demo:
 *
 *   client → job → worksite geofence → shift → assignment
 *   → clock-in → live attendance board → late / no-show / replacement
 *
 * Coordinates are verified from public map data (see the `source` field on
 * each worksite). Geofence radii are sized to the physical site: a parking
 * deck gets 100 m, the wind-farm field zone 1500 m because crews move between
 * turbines all shift.
 *
 * Creates only what is missing — worksites matched by name, jobs by client
 * name, shifts by (job, start time), assignments by (shift, employee).
 * Running it twice changes nothing. No deletes, no updates, no reseed.
 *
 * Worksite and client names are proper identities: they are absent from
 * SITE_KEYS and render identically in German and English.
 *
 * Run:  npm run add:kiel-demo
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

type Worksite = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusM: number;
  source: string;
};

const WORKSITES: Worksite[] = [
  // --- Kiel: cruise and ferry terminals ------------------------------------
  {
    name: "Ostseekai Cruise Terminal",
    address: "Ostseekai 27, 24103 Kiel",
    lat: 54.32585,
    lng: 10.14658,
    radiusM: 250,
    source: "OSM/Mapcarta",
  },
  {
    name: "Schwedenkai",
    address: "Schwedenkai 1, 24103 Kiel",
    lat: 54.31921,
    lng: 10.13955,
    radiusM: 200,
    source: "OSM/Mapcarta",
  },
  {
    name: "Norwegenkai",
    address: "Norwegenkai, 24143 Kiel",
    lat: 54.31656,
    lng: 10.1398,
    radiusM: 200,
    source: "OSM/Mapcarta",
  },
  {
    name: "Ostuferhafen Cruise Terminal",
    address: "Ostuferhafen, 24149 Kiel",
    lat: 54.33437,
    lng: 10.17439,
    radiusM: 400,
    source: "OSM/Mapcarta",
  },
  // --- Kiel: transport ------------------------------------------------------
  {
    name: "Kiel Hauptbahnhof",
    address: "Sophienblatt 24, 24103 Kiel",
    lat: 54.31347,
    lng: 10.13097,
    radiusM: 150,
    source: "OSM/Mapcarta",
  },
  // --- Kiel: parking --------------------------------------------------------
  {
    name: "Parkhaus ZOB",
    address: "Auguste-Viktoria-Straße, 24103 Kiel",
    lat: 54.31694,
    lng: 10.13349,
    radiusM: 100,
    source: "OSM/Mapcarta",
  },
  {
    name: "Förde-Parkhaus",
    address: "Andreas-Gayk-Straße, 24103 Kiel",
    lat: 54.32033,
    lng: 10.13789,
    radiusM: 100,
    source: "OSM/Mapcarta",
  },
  {
    name: "Port Parking Kiel",
    address: "Gablenzstraße, 24114 Kiel",
    lat: 54.30212,
    lng: 10.13044,
    radiusM: 150,
    source: "OSM/Mapcarta",
  },
  // --- Airport Kiel-Holtenau ------------------------------------------------
  // Street-access reference points: the operator publishes access roads only
  // ("Zufahrt über Boelckestr. 100" / "Zufahrt über Eekbrook"), so the radius
  // absorbs the remaining uncertainty.
  {
    name: "Airport Kiel-Holtenau – North Parking",
    address: "Boelckestraße 100, 24159 Kiel",
    lat: 54.3849,
    lng: 10.1425,
    radiusM: 200,
    source: "airport-kiel.de + onlinestreet (Boelckestraße access)",
  },
  {
    name: "Airport Kiel-Holtenau – South Parking",
    address: "Eekbrook, 24159 Kiel",
    lat: 54.3747,
    lng: 10.1456,
    radiusM: 200,
    source: "airport-kiel.de + onlinestreet (Eekbrook access)",
  },
  // --- Rendsburg-Eckernförde: two-zone wind farm ---------------------------
  {
    name: "Hamdorf Meeting Point",
    address: "Hamdorf, 24805 Hamdorf",
    lat: 54.22522,
    lng: 9.51866,
    radiusM: 200,
    source: "OSM/Mapcarta (Hamdorf Ortsmitte)",
  },
  {
    name: "Windpark Hamdorf – Rendsburg-Eckernförde",
    address: "Windpark Hamdorf, 24805 Hamdorf",
    lat: 54.2407,
    lng: 9.5153,
    radiusM: 1500,
    source: "thewindpower.net (54°14′26.4″N, 9°30′55.1″E)",
  },
];

type JobSpec = {
  clientName: string;
  siteName: string;
  description: string;
};

const JOBS: JobSpec[] = [
  {
    clientName: "Ostsee Terminal Services",
    siteName: "Ostseekai Cruise Terminal",
    description: "Terminalbetreuung und Reinigung an Anlauftagen.",
  },
  {
    clientName: "Fördeparken Kiel GmbH",
    siteName: "Parkhaus ZOB",
    description: "Parkservice an den Innenstadt-Parkhäusern.",
  },
  {
    clientName: "Kiel Port Logistics",
    siteName: "Ostuferhafen Cruise Terminal",
    description: "Logistikunterstützung im Hafenbetrieb.",
  },
  {
    clientName: "Bahnhofsservice Kiel",
    siteName: "Kiel Hauptbahnhof",
    description: "Reinigung und Servicedienste am Hauptbahnhof.",
  },
  {
    clientName: "Airport Services Kiel",
    siteName: "Airport Kiel-Holtenau – North Parking",
    description: "Parkflächenbetreuung am Flughafen Kiel-Holtenau.",
  },
  {
    clientName: "Eiderland Windservice",
    siteName: "Windpark Hamdorf – Rendsburg-Eckernförde",
    description: "Wartungs- und Servicearbeiten im Windpark.",
  },
];

/**
 * [client, worksite, dayOffset, startHour, endHour, requiredCount, role, staffed]
 * `staffed: false` leaves the shift open for the replacement workflow.
 */
type ShiftSpec = [string, string, number, number, number, number, string, boolean];

const SHIFTS: ShiftSpec[] = [
  // Ostseekai — cruise turnaround day
  ["Ostsee Terminal Services", "Ostseekai Cruise Terminal", 1, 6, 14, 3, "Terminalmitarbeiter/in", true],
  ["Ostsee Terminal Services", "Ostseekai Cruise Terminal", 1, 14, 22, 2, "Reinigungskraft", true],
  ["Ostsee Terminal Services", "Schwedenkai", 2, 7, 15, 2, "Servicekraft", true],
  ["Ostsee Terminal Services", "Norwegenkai", 3, 12, 20, 2, "Terminalmitarbeiter/in", false], // open
  // Parking
  ["Fördeparken Kiel GmbH", "Parkhaus ZOB", 1, 8, 16, 1, "Parkservice-Mitarbeiter/in", true],
  ["Fördeparken Kiel GmbH", "Förde-Parkhaus", 2, 8, 16, 1, "Parkservice-Mitarbeiter/in", true],
  ["Fördeparken Kiel GmbH", "Port Parking Kiel", 4, 6, 14, 1, "Parkservice-Mitarbeiter/in", false], // open
  // Port logistics
  ["Kiel Port Logistics", "Ostuferhafen Cruise Terminal", 1, 5, 13, 2, "Logistikmitarbeiter/in", true],
  ["Kiel Port Logistics", "Ostuferhafen Cruise Terminal", 2, 22, 30, 2, "Logistikmitarbeiter/in", true], // overnight
  // Station
  ["Bahnhofsservice Kiel", "Kiel Hauptbahnhof", 1, 5, 11, 2, "Reinigungskraft", true],
  ["Bahnhofsservice Kiel", "Kiel Hauptbahnhof", 3, 14, 21, 1, "Servicekraft", true],
  // Airport parking
  ["Airport Services Kiel", "Airport Kiel-Holtenau – North Parking", 2, 6, 14, 1, "Parkservice-Mitarbeiter/in", true],
  ["Airport Services Kiel", "Airport Kiel-Holtenau – South Parking", 3, 6, 14, 1, "Reinigungskraft", false], // open
  // Wind farm — two zones: muster at the meeting point, then field work
  ["Eiderland Windservice", "Hamdorf Meeting Point", 2, 6, 7, 2, "Vorarbeiter/in", true],
  ["Eiderland Windservice", "Windpark Hamdorf – Rendsburg-Eckernförde", 2, 7, 16, 2, "Servicetechniker/in", true],
  ["Eiderland Windservice", "Windpark Hamdorf – Rendsburg-Eckernförde", 4, 7, 16, 2, "Wartungstechniker/in", true],
];

const INSTRUCTIONS: Record<string, string> = {
  "Ostsee Terminal Services": "Anmeldung am Terminaleingang. Arbeitskleidung erforderlich.",
  "Fördeparken Kiel GmbH": "Schlüsselübergabe im Kassenbereich.",
  "Kiel Port Logistics": "Anmeldung am Hafentor. Sicherheitsschuhe erforderlich.",
  "Bahnhofsservice Kiel": "Treffpunkt Servicepoint Haupthalle.",
  "Airport Services Kiel": "Zufahrt über die ausgeschilderte Parkflächenzufahrt.",
  "Eiderland Windservice": "Treffpunkt Sammelpunkt Hamdorf. Fahrgemeinschaft zur Anlage.",
};

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

/** Hours >= 24 roll into the next day, so overnight shifts stay valid. */
function at(dayOffset: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset + Math.floor(hour / 24));
  return `${d.toISOString().slice(0, 10)}T${String(hour % 24).padStart(2, "0")}:00:00+02:00`;
}

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
  const cid = companies[0].id;
  console.log(`Company: ${companies[0].name}`);
  console.log(`company_id: ${cid}\n`);

  const counts = { locations: 0, jobs: 0, shifts: 0, assignments: 0 };

  // ---- Worksites ----------------------------------------------------------
  console.log("Worksites");
  const locationIds = new Map<string, string>();
  for (const site of WORKSITES) {
    const { data: existing, error } = await db
      .from("locations")
      .select("id")
      .eq("company_id", cid)
      .eq("name", site.name)
      .maybeSingle();
    if (error) throw new Error(`locations: ${error.message}`);

    if (existing) {
      locationIds.set(site.name, existing.id);
      console.log(`  exists   ${site.name}`);
      continue;
    }

    const { data: inserted, error: insertError } = await db
      .from("locations")
      .insert({
        company_id: cid,
        name: site.name,
        address: site.address,
        lat: site.lat,
        lng: site.lng,
        geofence_radius_m: site.radiusM,
        geofence_enabled: true,
      })
      .select("id")
      .single();
    if (insertError || !inserted) throw new Error(`locations insert: ${insertError?.message}`);
    locationIds.set(site.name, inserted.id);
    counts.locations++;
    console.log(
      `  created  ${site.name} · ${site.lat}, ${site.lng} · ${site.radiusM} m · ${site.source}`
    );
  }

  // ---- Jobs ---------------------------------------------------------------
  console.log("\nJobs");
  const jobIds = new Map<string, string>();
  for (const job of JOBS) {
    const { data: existing, error } = await db
      .from("jobs")
      .select("id")
      .eq("company_id", cid)
      .eq("client_name", job.clientName)
      .maybeSingle();
    if (error) throw new Error(`jobs: ${error.message}`);

    if (existing) {
      jobIds.set(job.clientName, existing.id);
      console.log(`  exists   ${job.clientName}`);
      continue;
    }

    const { data: inserted, error: insertError } = await db
      .from("jobs")
      .insert({
        company_id: cid,
        client_name: job.clientName,
        location_id: locationIds.get(job.siteName) ?? null,
        description: job.description,
      })
      .select("id")
      .single();
    if (insertError || !inserted) throw new Error(`jobs insert: ${insertError?.message}`);
    jobIds.set(job.clientName, inserted.id);
    counts.jobs++;
    console.log(`  created  ${job.clientName} → ${job.siteName}`);
  }

  // ---- Shifts -------------------------------------------------------------
  console.log("\nShifts");
  const staffedShiftIds: string[] = [];
  let openShifts = 0;

  for (const [client, siteName, offset, startHour, endHour, required, role, staffed] of SHIFTS) {
    const jobId = jobIds.get(client);
    if (!jobId) continue;
    const startTime = at(offset, startHour);

    const { data: existing, error } = await db
      .from("shifts")
      .select("id")
      .eq("company_id", cid)
      .eq("job_id", jobId)
      .eq("start_time", startTime)
      .maybeSingle();
    if (error) throw new Error(`shifts: ${error.message}`);

    let shiftId: string;
    if (existing) {
      shiftId = existing.id;
      console.log(`  exists   ${siteName} · ${day(offset)} ${startHour}:00`);
    } else {
      const { data: inserted, error: insertError } = await db
        .from("shifts")
        .insert({
          company_id: cid,
          job_id: jobId,
          date: day(offset),
          start_time: startTime,
          end_time: at(offset, endHour),
          required_count: required,
          required_role: role,
          instructions: INSTRUCTIONS[client] ?? null,
          contact_person: "Aylin Kaya (+49 152 5550101)",
        })
        .select("id")
        .single();
      if (insertError || !inserted) throw new Error(`shifts insert: ${insertError?.message}`);
      shiftId = inserted.id;
      counts.shifts++;
      console.log(
        `  created  ${siteName} · ${day(offset)} ${startHour}:00–${endHour % 24}:00 · needs ${required} · ${role}${staffed ? "" : " · OPEN"}`
      );
    }

    if (staffed) staffedShiftIds.push(shiftId);
    else openShifts++;
  }

  // ---- Assignments (existing active employees only) -----------------------
  console.log("\nAssignments");
  const { data: employees, error: employeeError } = await db
    .from("employees")
    .select("id, full_name")
    .eq("company_id", cid)
    .eq("employment_status", "active")
    .order("employee_no", { ascending: true })
    .limit(8);
  if (employeeError) throw new Error(`employees: ${employeeError.message}`);

  const pool = employees ?? [];
  if (pool.length === 0) {
    console.log("  skipped — no active employees found");
  } else {
    let cursor = 0;
    for (const shiftId of staffedShiftIds) {
      // one assignment per staffed shift keeps employees free of overlaps
      const employee = pool[cursor % pool.length];
      cursor++;

      const { data: existing, error } = await db
        .from("shift_assignments")
        .select("id")
        .eq("shift_id", shiftId)
        .eq("employee_id", employee.id)
        .maybeSingle();
      if (error) throw new Error(`shift_assignments: ${error.message}`);

      if (existing) {
        console.log(`  exists   ${employee.full_name}`);
        continue;
      }

      const { error: insertError } = await db.from("shift_assignments").insert({
        company_id: cid,
        shift_id: shiftId,
        employee_id: employee.id,
        status: cursor % 3 === 0 ? "accepted" : "assigned",
      });
      if (insertError) throw new Error(`shift_assignments insert: ${insertError.message}`);
      counts.assignments++;
      console.log(`  created  ${employee.full_name}`);
    }
  }

  // ---- Summary ------------------------------------------------------------
  console.log(
    `\nCreated ${counts.locations} worksite(s), ${counts.jobs} job(s), ${counts.shifts} shift(s), ${counts.assignments} assignment(s).`
  );
  console.log(`${openShifts} shift(s) intentionally left open for the replacement workflow.`);
  if (
    counts.locations + counts.jobs + counts.shifts + counts.assignments === 0
  ) {
    console.log("Everything already existed — nothing to do.");
  }
  console.log("Untouched: Berlin and GE-PACK demo data, employees, time entries, alerts, users.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

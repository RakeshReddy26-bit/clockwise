/**
 * Seed a separate KSK-focused Clockwise demo tenant.
 *
 * Safety rules:
 * - creates a NEW demo company; never deletes or rewrites Meridian data
 * - refuses to run twice for the same demo company
 * - uses fictional people and fictional work orders
 * - real company/worksite names are only used to make the demo geographically
 *   realistic; this does not claim an actual commercial relationship
 *
 * Run: npm run seed:ksk-demo
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  DEPARTMENTS,
  EMPLOYEE_COUNT,
  JOBS,
  KSK_COMPANY_NAME,
  SHIFTS,
  WORKSITES,
} from "./ksk-demo-plan";

config({ path: ".env.local" });
config();

const DEMO_PASSWORD = "Clockwise!KskDemo26";
const DEMO_DOMAIN = "ksk-demo.example";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

type ManagerRole = "COMPANY_ADMIN" | "HR_MANAGER" | "DISPATCHER";
type IdRow = { id: string };

const MANAGERS: Array<[name: string, slug: string, role: ManagerRole]> = [
  ["Katrin Albrecht", "katrin.albrecht", "COMPANY_ADMIN"],
  ["Jonas Weidemann", "jonas.weidemann", "HR_MANAGER"],
  ["Marco Litfin", "marco.litfin", "DISPATCHER"],
  ["Aylin Kaya", "aylin.kaya", "DISPATCHER"],
];

const EMPLOYEE_NAMES = [
  "Lukas Brandt", "Emre Yilmaz", "Sofia Petrova", "Jan Kowalczyk",
  "Miriam Schuster", "David Okafor", "Lena Hoffmann", "Tobias Krüger",
  "Amira Haddad", "Felix Sandmann", "Nina Bergström", "Oskar Lehmann",
  "Dilara Öztürk", "Paul Wenzel", "Chiara Rossi", "Maxim Fedorov",
  "Julia Steinbach", "Kevin Marquardt", "Fatima Benali", "Simon Rademacher",
  "Anja Wolter", "Viktor Hansen", "Melina Vogt", "Adrian Pfeifer",
] as const;

if (EMPLOYEE_NAMES.length !== EMPLOYEE_COUNT) {
  throw new Error(`KSK demo plan expects ${EMPLOYEE_COUNT} employees, found ${EMPLOYEE_NAMES.length}.`);
}

const POSITIONS: Record<(typeof DEPARTMENTS)[number], string[]> = {
  "Cruise & Passenger Services": ["Passenger Service", "Host / Hostess", "Porter Service"],
  "Mooring & Port Operations": ["Mooring Crew", "Hafenarbeiter/in"],
  "Luggage & Logistics": ["Luggage Service", "Logistics Crew"],
  "Shuttle & Transport": ["Shuttle Driver", "Shuttle Coordinator"],
  "Parking Operations": ["Parking Service", "Parking Shuttle Driver"],
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]+/g, ".")
    .replace(/^\.|\.$/g, "");
}

function berlinDay(offset: number): string {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + offset);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(base);
}

/**
 * Build a timestamp for a Berlin wall-clock time without assuming CET/CEST.
 * `shortOffset` gives GMT+1/GMT+2, so the seed stays correct in winter too.
 */
function berlinTimestamp(dayOffset: number, hour: number): string {
  const extraDays = Math.floor(hour / 24);
  const localHour = ((hour % 24) + 24) % 24;
  const date = berlinDay(dayOffset + extraDays);
  const [year, month, day] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, localHour));
  const zoneName = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin",
    timeZoneName: "shortOffset",
  })
    .formatToParts(probe)
    .find((part) => part.type === "timeZoneName")?.value;

  const match = zoneName?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) throw new Error(`Cannot resolve Europe/Berlin offset for ${date}`);

  const sign = match[1];
  const hh = match[2].padStart(2, "0");
  const mm = (match[3] ?? "00").padStart(2, "0");
  return `${date}T${String(localHour).padStart(2, "0")}:00:00${sign}${hh}:${mm}`;
}

async function insert<T extends object>(table: string, rows: T | T[]): Promise<IdRow[]> {
  const { data, error } = await db.from(table).insert(rows).select("id");
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as IdRow[];
}

async function createUser(name: string, slug: string): Promise<string> {
  const email = `${slug}@${DEMO_DOMAIN}`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: name, locale: "de" },
  });
  if (error) throw new Error(`auth user ${email}: ${error.message}`);
  return data.user.id;
}

async function ensureFreshDemo(): Promise<void> {
  const { data, error } = await db
    .from("companies")
    .select("id")
    .eq("name", KSK_COMPANY_NAME)
    .maybeSingle();
  if (error) throw new Error(`preflight: ${error.message}`);
  if (data) {
    throw new Error(`"${KSK_COMPANY_NAME}" already exists. Nothing changed.`);
  }
}

async function main() {
  await ensureFreshDemo();

  console.log("Creating KSK demo tenant …");
  const [company] = await insert("companies", {
    name: KSK_COMPANY_NAME,
    contact_email: "auftrag@ksk-kiel.de",
    contact_phone: "+49 431 209 66 0",
    address: "Ostuferhafen 15, 24149 Kiel",
    settings: {
      branding: { accent: "#0e6e68" },
      demo: { scenario: "ksk-port-operations", fictionalWorkOrders: true },
      vacation: { defaultDays: 28 },
      workingTime: { fullTimeWeeklyHours: 40 },
    },
  });
  const companyId = company.id;

  const locationRows = await insert(
    "locations",
    WORKSITES.map((site) => ({
      company_id: companyId,
      name: site.name,
      address: site.address,
      lat: site.lat,
      lng: site.lng,
      geofence_radius_m: site.radiusM,
      geofence_enabled: true,
    }))
  );
  const locationIdByName = new Map(WORKSITES.map((site, i) => [site.name, locationRows[i].id]));

  const departmentRows = await insert(
    "departments",
    DEPARTMENTS.map((name) => ({ company_id: companyId, name }))
  );
  const departmentIdByName = new Map(DEPARTMENTS.map((name, i) => [name, departmentRows[i].id]));

  console.log("Creating demo managers …");
  const managerProfileIds: string[] = [];
  for (const [name, slug, role] of MANAGERS) {
    const profileId = await createUser(name, slug);
    managerProfileIds.push(profileId);
    await insert("company_memberships", {
      profile_id: profileId,
      company_id: companyId,
      role,
      status: "active",
    });
  }

  console.log(`Creating ${EMPLOYEE_COUNT} demo employees …`);
  const employeeIds: string[] = [];
  const employeeProfileIds: string[] = [];
  for (let index = 0; index < EMPLOYEE_NAMES.length; index++) {
    const name = EMPLOYEE_NAMES[index];
    const slug = slugify(name);
    const profileId = await createUser(name, slug);
    employeeProfileIds.push(profileId);
    await insert("company_memberships", {
      profile_id: profileId,
      company_id: companyId,
      role: "EMPLOYEE",
      status: "active",
    });

    const department = DEPARTMENTS[index % DEPARTMENTS.length];
    const positions = POSITIONS[department];
    const homeSite = WORKSITES[index % WORKSITES.length];
    const [employee] = await insert("employees", {
      company_id: companyId,
      profile_id: profileId,
      employee_no: `KSK-${String(index + 1).padStart(3, "0")}`,
      full_name: name,
      email: `${slug}@${DEMO_DOMAIN}`,
      phone: `+49 152 700${String(1000 + index)}`,
      position: positions[index % positions.length],
      department_id: departmentIdByName.get(department),
      location_id: locationIdByName.get(homeSite.name),
      employment_status: index === 23 ? "probation" : "active",
      contract_type: index % 5 === 4 ? "part_time" : "full_time",
      start_date: berlinDay(-(120 + index * 17)),
      weekly_hours: index % 5 === 4 ? 25 : 40,
      vacation_days_total: 28,
      vacation_days_used: (index * 2) % 12,
      hourly_rate: 15 + (index % 5),
    });
    employeeIds.push(employee.id);
  }

  console.log("Creating demo jobs and shifts …");
  const jobIdByKey = new Map<string, string>();
  for (const job of JOBS) {
    const [row] = await insert("jobs", {
      company_id: companyId,
      client_name: job.clientName,
      location_id: locationIdByName.get(job.siteName),
      description: job.description,
    });
    jobIdByKey.set(job.key, row.id);
  }

  const shiftIdByIndex: string[] = [];
  for (const shift of SHIFTS) {
    const job = JOBS.find((item) => item.key === shift.jobKey);
    if (!job) throw new Error(`Unknown demo job: ${shift.jobKey}`);

    const [shiftRow] = await insert("shifts", {
      company_id: companyId,
      job_id: jobIdByKey.get(job.key),
      date: berlinDay(shift.dayOffset),
      start_time: berlinTimestamp(shift.dayOffset, shift.startHour),
      end_time: berlinTimestamp(shift.dayOffset, shift.endHour),
      required_count: shift.requiredCount,
      required_role: shift.role,
      instructions: job.instructions,
      contact_person: "Marco Litfin — Demo Dispatch",
    });
    shiftIdByIndex.push(shiftRow.id);

    for (const employeeIndex of shift.crew) {
      await insert("shift_assignments", {
        company_id: companyId,
        shift_id: shiftRow.id,
        employee_id: employeeIds[employeeIndex],
        status: "assigned",
        assigned_by: managerProfileIds[2],
      });
    }
  }

  // One realistic replacement case: one seat is still missing and three free
  // employees have been contacted. This is the hero demo workflow.
  const replacementShiftIndex = SHIFTS.findIndex((shift) => shift.scenario === "replacement");
  if (replacementShiftIndex >= 0) {
    const [offer] = await insert("shift_offers", {
      company_id: companyId,
      shift_id: shiftIdByIndex[replacementShiftIndex],
      created_by: managerProfileIds[2],
      message: "Kurzfristige Ersatzbesetzung benötigt. Bitte Verfügbarkeit bestätigen.",
      expires_at: berlinTimestamp(1, 4),
      status: "open",
    });
    await insert("shift_offer_responses", [
      { company_id: companyId, offer_id: offer.id, employee_id: employeeIds[21], response: "interested", responded_at: new Date().toISOString() },
      { company_id: companyId, offer_id: offer.id, employee_id: employeeIds[22], response: "pending" },
      { company_id: companyId, offer_id: offer.id, employee_id: employeeIds[23], response: "declined", responded_at: new Date().toISOString() },
    ]);
  }

  console.log("Creating absences and communication demo data …");
  await insert("vacation_requests", [
    {
      company_id: companyId,
      employee_id: employeeIds[17],
      start_date: berlinDay(10),
      end_date: berlinDay(14),
      days_count: 5,
      note: "Familienurlaub",
      status: "pending",
    },
    {
      company_id: companyId,
      employee_id: employeeIds[20],
      start_date: berlinDay(20),
      end_date: berlinDay(22),
      days_count: 3,
      status: "approved",
      decided_by: managerProfileIds[1],
      decided_at: new Date().toISOString(),
    },
  ]);

  await insert("sick_leaves", {
    company_id: companyId,
    employee_id: employeeIds[18],
    start_date: berlinDay(0),
    expected_end_date: berlinDay(2),
    comment: "Krankmeldung — Demo",
    status: "reported",
  });

  const [conversation] = await insert("conversations", {
    company_id: companyId,
    topic: "schedule",
    subject: "Ersatzbesetzung Ostseekai",
    created_by: managerProfileIds[2],
  });
  await insert("conversation_participants", [
    { company_id: companyId, conversation_id: conversation.id, profile_id: managerProfileIds[2] },
    { company_id: companyId, conversation_id: conversation.id, profile_id: employeeProfileIds[21] },
  ]);
  await insert("messages", [
    {
      company_id: companyId,
      conversation_id: conversation.id,
      sender_id: managerProfileIds[2],
      body: "Morgen früh ist am Ostseekai kurzfristig ein Platz frei. Kannst du übernehmen?",
    },
    {
      company_id: companyId,
      conversation_id: conversation.id,
      sender_id: employeeProfileIds[21],
      body: "Ja, ich bin verfügbar. Ich habe das Angebot in Clockwise bestätigt.",
    },
  ]);

  await insert("news_posts", [
    {
      company_id: companyId,
      title: "Cruise turnaround: briefing",
      body: "Bitte 15 Minuten vor Schichtbeginn am jeweiligen Treffpunkt einchecken. Demo-Mitteilung für den Clockwise-Pilot.",
      category: "Operations",
      author_id: managerProfileIds[2],
      published_at: new Date().toISOString(),
    },
    {
      company_id: companyId,
      title: "Mooring PPE reminder",
      body: "Für Mooring-Einsätze sind Warnkleidung, Sicherheitsschuhe und Funkcheck erforderlich.",
      category: "Arbeitsschutz",
      author_id: managerProfileIds[1],
      published_at: new Date().toISOString(),
    },
  ]);

  await insert("calendar_events", [
    {
      company_id: companyId,
      type: "safety_instruction",
      title: "Mooring safety briefing",
      starts_at: berlinTimestamp(4, 9),
      ends_at: berlinTimestamp(4, 11),
      location_id: locationIdByName.get("KSK Ostuferhafen Base"),
    },
    {
      company_id: companyId,
      type: "training",
      title: "Passenger service briefing",
      starts_at: berlinTimestamp(5, 10),
      ends_at: berlinTimestamp(5, 12),
      location_id: locationIdByName.get("Ostseekai Cruise Terminal"),
    },
  ]);

  console.log("\nKSK demo seed complete.");
  console.log(`Company: ${KSK_COMPANY_NAME}`);
  console.log(`Admin:      katrin.albrecht@${DEMO_DOMAIN}`);
  console.log(`Dispatcher: marco.litfin@${DEMO_DOMAIN}`);
  console.log(`Employee:   lukas.brandt@${DEMO_DOMAIN}`);
  console.log(`Password:   ${DEMO_PASSWORD}`);
  console.log("\nMeridian and all existing tenant data were left untouched.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

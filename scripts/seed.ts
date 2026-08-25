/**
 * Clockwise demo seed — Meridian Facility & Service GmbH (fictional).
 * Run:  npm run seed
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
 * Creates auth users (password below), one tenant, and realistic German data.
 * Refuses to run twice: delete the company in Supabase (cascades) to re-seed.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
config();

const DEMO_PASSWORD = "Clockwise!Demo26";
const COMPANY_NAME = "Meridian Facility & Service GmbH";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const MANAGERS: Array<[string, string, "COMPANY_ADMIN" | "HR_MANAGER" | "DISPATCHER"]> = [
  ["Katrin Albrecht", "katrin.albrecht", "COMPANY_ADMIN"],
  ["Jonas Weidemann", "jonas.weidemann", "HR_MANAGER"],
  ["Sabine Rautenberg", "sabine.rautenberg", "HR_MANAGER"],
  ["Marco Litfin", "marco.litfin", "DISPATCHER"],
  ["Aylin Kaya", "aylin.kaya", "DISPATCHER"],
];

const EMPLOYEES: string[] = [
  "Lukas Brandt", "Emre Yilmaz", "Sofia Petrova", "Jan Kowalczyk", "Miriam Schuster",
  "David Okafor", "Lena Hoffmann", "Tobias Krüger", "Amira Haddad", "Felix Sandmann",
  "Nina Bergström", "Oskar Lehmann", "Dilara Öztürk", "Paul Wenzel", "Chiara Rossi",
  "Maxim Fedorov", "Julia Steinbach", "Kevin Marquardt", "Fatima Benali", "Simon Rademacher",
  "Anja Wolter", "Viktor Hansen", "Melina Vogt", "Adrian Pfeifer", "Sarah Lindner",
  "Ibrahim Demir", "Franziska Ott", "Robert Zielinski", "Hannah Grote", "Tim Fassbender",
];

const DEPARTMENTS = ["Reinigung", "Gebäudetechnik", "Logistik & Event"];
// [name, address, lat, lng, geofence radius m]
const LOCATIONS: Array<[string, string, number, number, number]> = [
  ["Zentrale Berlin-Mitte", "Chausseestraße 12, 10115 Berlin", 52.53245, 13.38344, 100],
  ["Bürocampus Adlershof", "Rudower Chaussee 5, 12489 Berlin", 52.43033, 13.53245, 150],
  ["Logistikpark Großbeeren", "Am Wall 3, 14979 Großbeeren", 52.35871, 13.30012, 250],
  ["Einkaufszentrum Spandau", "Klosterstraße 8, 13581 Berlin", 52.53514, 13.19825, 100],
  ["Klinikum Buch", "Lindenberger Weg 27, 13125 Berlin", 52.62612, 13.50291, 150],
];
const CLIENTS = [
  "Nordfeld Logistik GmbH", "CityCarré Verwaltung", "TechPark Adlershof AG",
  "Klinikum Buch gGmbH", "Handelshof Spandau KG",
];
const POSITIONS: Record<string, string[]> = {
  Reinigung: ["Reinigungskraft", "Vorarbeiter/in"],
  "Gebäudetechnik": ["Haustechniker/in", "Hausmeister/in"],
  "Logistik & Event": ["Lagerhelfer/in", "Servicekraft", "Empfangskraft"],
};

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
function at(dateStr: string, hour: number): string {
  return `${dateStr}T${String(hour).padStart(2, "0")}:00:00+02:00`;
}

async function createUser(name: string, slug: string, locale = "de"): Promise<string> {
  const email = `${slug}@meridian-demo.example`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: name, locale },
  });
  if (error) throw new Error(`auth user ${email}: ${error.message}`);
  return data.user.id;
}

async function insert<T extends object>(table: string, rows: T[] | T): Promise<Record<string, string>[]> {
  const { data, error } = await db.from(table).insert(rows).select("id");
  if (error) throw new Error(`${table}: ${error.message}`);
  return data ?? [];
}

async function main() {
  const { data: existing, error: exErr } = await db
    .from("companies").select("id").eq("name", COMPANY_NAME).maybeSingle();
  if (exErr) throw new Error(`preflight: ${exErr.message} — did you run the migrations?`);
  if (existing) {
    console.error(`"${COMPANY_NAME}" already exists. Delete it in Supabase to re-seed.`);
    process.exit(1);
  }

  console.log("Seeding company …");
  const [company] = await insert("companies", {
    name: COMPANY_NAME,
    contact_email: "verwaltung@meridian-demo.example",
    contact_phone: "+49 30 555 0199",
    address: "Chausseestraße 12, 10115 Berlin",
    settings: {
      branding: { accent: "#0e6e68" },
      vacation: { defaultDays: 28 },
      workingTime: { fullTimeWeeklyHours: 40 },
    },
  });
  const cid = company.id;

  const locations = await insert("locations",
    LOCATIONS.map(([name, address, lat, lng, radius]) => ({
      company_id: cid, name, address, lat, lng,
      geofence_radius_m: radius, geofence_enabled: true,
    })));
  const departments = await insert("departments",
    DEPARTMENTS.map((name) => ({ company_id: cid, name })));

  console.log("Seeding managers …");
  const managerProfileIds: string[] = [];
  for (const [name, slug, role] of MANAGERS) {
    const uid = await createUser(name, slug);
    managerProfileIds.push(uid);
    await insert("company_memberships", { profile_id: uid, company_id: cid, role });
  }

  console.log("Seeding 30 employees …");
  const employeeIds: string[] = [];
  for (let i = 0; i < EMPLOYEES.length; i++) {
    const name = EMPLOYEES[i];
    const slug = name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");

    // The last three are deliberately left WITHOUT an account: no auth user, no
    // membership, profile_id null. That is a legal state the schema has always
    // allowed, and it is the only way the invitation flow can be demonstrated —
    // with everyone pre-linked there is nobody left to invite.
    const withoutAccount = i >= EMPLOYEES.length - 3;
    const uid = withoutAccount ? null : await createUser(name, slug);
    if (uid) {
      await insert("company_memberships", { profile_id: uid, company_id: cid, role: "EMPLOYEE" });
    }

    const dept = departments[i % 3];
    const deptName = DEPARTMENTS[i % 3];
    const positions = POSITIONS[deptName];
    const [emp] = await insert("employees", {
      company_id: cid,
      profile_id: uid,
      employee_no: `CW-${String(i + 1).padStart(3, "0")}`,
      full_name: name,
      email: `${slug}@meridian-demo.example`,
      phone: `+49 152 555${String(1000 + i)}`,
      position: positions[i % positions.length],
      department_id: dept.id,
      location_id: locations[i % 5].id,
      employment_status: i % 11 === 10 ? "probation" : "active",
      contract_type: i % 4 === 3 ? "part_time" : "full_time",
      start_date: day(-(90 + i * 23)),
      weekly_hours: i % 4 === 3 ? 25 : 40,
      vacation_days_total: 28,
      vacation_days_used: (i * 3) % 15,
      hourly_rate: 14 + (i % 6),
    });
    // Only accounted employees are used for assignments below, so an
    // uninvited person never appears mid-shift with no way to clock in.
    if (!withoutAccount) employeeIds.push(emp.id);

    await insert("emergency_contacts", {
      company_id: cid,
      employee_id: emp.id,
      name: `Notfallkontakt ${name.split(" ")[1]}`,
      relationship: i % 2 ? "Partner/in" : "Elternteil",
      phone: `+49 30 555${String(2000 + i)}`,
    });
  }

  console.log("Seeding jobs & shifts …");
  const jobs = await insert("jobs", CLIENTS.map((client, i) => ({
    company_id: cid,
    client_name: client,
    location_id: locations[i].id,
    description: `Regelmäßiger Einsatz bei ${client}.`,
  })));

  // 25 shifts over the next 14 days; 20 staffed, 5 left open
  let empCursor = 0;
  for (let s = 0; s < 25; s++) {
    const d = day(1 + (s % 14));
    const startHour = [6, 8, 14, 22][s % 4];
    const [shift] = await insert("shifts", {
      company_id: cid,
      job_id: jobs[s % 5].id,
      date: d,
      start_time: at(d, startHour),
      end_time: at(d, Math.min(startHour + 8, 23)),
      required_count: 1 + (s % 2),
      required_role: DEPARTMENTS[s % 3],
      instructions: "Treffpunkt Haupteingang. Arbeitskleidung erforderlich.",
      contact_person: "Marco Litfin (+49 152 5550100)",
    });
    if (s < 20) {
      const needed = 1 + (s % 2);
      for (let k = 0; k < needed; k++) {
        await insert("shift_assignments", {
          company_id: cid,
          shift_id: shift.id,
          employee_id: employeeIds[empCursor++ % employeeIds.length],
          status: s % 3 === 0 ? "accepted" : "assigned",
          assigned_by: managerProfileIds[3],
        });
      }
    }
  }

  console.log("Seeding absences, recruitment, comms …");
  await insert("vacation_requests", [
    { company_id: cid, employee_id: employeeIds[2], start_date: day(20), end_date: day(27), days_count: 6, note: "Familienurlaub", status: "pending" },
    { company_id: cid, employee_id: employeeIds[7], start_date: day(35), end_date: day(39), days_count: 5, status: "pending" },
    { company_id: cid, employee_id: employeeIds[11], start_date: day(10), end_date: day(11), days_count: 2, status: "approved", decided_by: managerProfileIds[1], decided_at: new Date().toISOString() },
    { company_id: cid, employee_id: employeeIds[15], start_date: day(5), end_date: day(9), days_count: 5, status: "rejected", decided_by: managerProfileIds[1], decided_at: new Date().toISOString() },
  ]);

  await insert("sick_leaves", [
    { company_id: cid, employee_id: employeeIds[4], start_date: day(-1), expected_end_date: day(3), comment: "Grippe", status: "reported" },
    { company_id: cid, employee_id: employeeIds[19], start_date: day(-4), expected_end_date: day(1), status: "confirmed" },
  ]);

  const postings = await insert("job_postings", [
    { company_id: cid, title: "Haustechniker/in (m/w/d) – Vollzeit", description: "Betreuung von Kundenobjekten im Berliner Stadtgebiet. Führerschein Klasse B erforderlich.", location_id: locations[0].id, employment_type: "full_time", published: true, published_at: new Date().toISOString() },
    { company_id: cid, title: "Reinigungskraft (m/w/d) – Teilzeit", description: "Unterhaltsreinigung Bürocampus Adlershof, Mo–Fr ab 17 Uhr.", location_id: locations[1].id, employment_type: "part_time", published: true, published_at: new Date().toISOString() },
  ]);
  await insert("applications", [
    { company_id: cid, job_posting_id: postings[0].id, applicant_name: "Cem Aydin", applicant_email: "cem.aydin@post-demo.example", applicant_phone: "+49 176 5553001", stage: "applied" },
    { company_id: cid, job_posting_id: postings[0].id, applicant_name: "Martina Keller", applicant_email: "m.keller@post-demo.example", stage: "reviewing" },
    { company_id: cid, job_posting_id: postings[0].id, applicant_name: "Piotr Nowak", applicant_email: "p.nowak@post-demo.example", stage: "interview" },
    { company_id: cid, job_posting_id: postings[1].id, applicant_name: "Leyla Acar", applicant_email: "l.acar@post-demo.example", stage: "applied" },
  ]);

  await insert("news_posts", [
    { company_id: cid, title: "Neuer Standort: Klinikum Buch", body: "Ab September übernehmen wir den Reinigungs- und Facility-Service am Klinikum Buch. Einsatzpläne folgen.", category: "Unternehmen", author_id: managerProfileIds[0], published_at: new Date().toISOString() },
    { company_id: cid, title: "Arbeitsschutzunterweisung Q4", body: "Die jährliche Unterweisung findet im Oktober statt. Termine stehen im Kalender.", category: "Arbeitsschutz", author_id: managerProfileIds[1], published_at: new Date().toISOString() },
    { company_id: cid, title: "Feiertagszuschläge aktualisiert", body: "Ab dem 1. des Monats gelten die neuen Zuschlagssätze laut Aushang.", category: "Lohn", author_id: managerProfileIds[0], published_at: new Date().toISOString() },
  ]);

  const [conv1] = await insert("conversations", { company_id: cid, topic: "schedule", subject: "Schichttausch Samstag", created_by: managerProfileIds[3] });
  const emp0Profile = (await db.from("employees").select("profile_id").eq("id", employeeIds[0]).single()).data!.profile_id as string;
  await insert("conversation_participants", [
    { company_id: cid, conversation_id: conv1.id, profile_id: managerProfileIds[3] },
    { company_id: cid, conversation_id: conv1.id, profile_id: emp0Profile },
  ]);
  await insert("messages", [
    { company_id: cid, conversation_id: conv1.id, sender_id: emp0Profile, body: "Hallo, könnte ich die Samstagsschicht tauschen?" },
    { company_id: cid, conversation_id: conv1.id, sender_id: managerProfileIds[3], body: "Ich schaue, wer einspringen kann, und melde mich heute Nachmittag." },
  ]);

  await insert("calendar_events", [
    { company_id: cid, type: "training", title: "Erste-Hilfe-Auffrischung", starts_at: at(day(12), 9), ends_at: at(day(12), 16), location_id: locations[0].id },
    { company_id: cid, type: "safety_instruction", title: "Arbeitsschutzunterweisung Reinigung", starts_at: at(day(18), 10), ends_at: at(day(18), 12), location_id: locations[1].id },
  ]);

  const [instr] = await insert("safety_instructions", {
    company_id: cid, title: "Grundunterweisung Arbeitssicherheit",
    description: "Pflichtunterweisung für alle Mitarbeitenden.",
  });
  for (let i = 0; i < 10; i++) {
    await insert("safety_completions", { company_id: cid, instruction_id: instr.id, employee_id: employeeIds[i] });
  }

  for (const item of ["personal_info", "contract_received", "contract_signed", "bank_info", "emergency_contact", "safety_instructions", "documents_uploaded", "policies_acknowledged"]) {
    await insert("onboarding_items", {
      company_id: cid, employee_id: employeeIds[29], item,
      completed_at: ["personal_info", "contract_received", "emergency_contact"].includes(item) ? new Date().toISOString() : null,
    });
  }

  console.log("Done.");
  console.log(`Company: ${COMPANY_NAME}`);
  console.log(`Logins:  katrin.albrecht@meridian-demo.example (COMPANY_ADMIN)`);
  console.log(`         jonas.weidemann@meridian-demo.example (HR_MANAGER)`);
  console.log(`         marco.litfin@meridian-demo.example (DISPATCHER)`);
  console.log(`         lukas.brandt@meridian-demo.example (EMPLOYEE)`);
  console.log(`Password (all demo users): ${DEMO_PASSWORD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

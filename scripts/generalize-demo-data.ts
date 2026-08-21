/**
 * Idempotent maintenance script: bring the existing Meridian demo rows in
 * line with the industry-neutral demo data now defined in scripts/seed.ts.
 *
 * Guarantees:
 *   - every write is scoped to the resolved Meridian company_id
 *   - every write is guarded by the OLD value, so a second run changes nothing
 *   - no inserts, no deletes, no ID changes, no reseed, no relationship edits
 *   - departments are RENAMED in place, so employees.department_id stays valid
 *   - locations/geofence data, assignments, time entries, alerts, users and
 *     memberships are never read for modification
 *
 * Run:
 *   npm run generalize:demo-data -- --dry   (plan only, writes nothing)
 *   npm run generalize:demo-data            (apply)
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
config();

const COMPANY_NAMES = [
  "Meridian Facility & Service GmbH", // current
  "Meridian Sicherheit & Service GmbH", // legacy, pre-rename
];

const DRY = process.argv.includes("--dry");

/**
 * Department renames are paired by CONTENT, not list position: each old
 * department keeps the people it already has, and its new name matches the
 * roles those people actually hold. Nobody changes department.
 */
const DEPARTMENT_RENAMES: Array<[string, string]> = [
  ["Gebäudereinigung", "Reinigung"],
  ["Facility Service", "Gebäudetechnik"],
  ["Sicherheitsdienst", "Logistik & Event"],
];

/** shifts.required_role holds department names — same mapping. */
const ROLE_RENAMES = DEPARTMENT_RENAMES;

const POSITION_RENAMES: Array<[string, string]> = [
  ["Sicherheitsmitarbeiter/in", "Lagerhelfer/in"],
  ["Objektschutz", "Servicekraft"],
  ["Empfangsdienst", "Empfangskraft"],
  ["Vorarbeiter/in Reinigung", "Vorarbeiter/in"],
];

const OLD_POSTING_TITLE = "Sicherheitsmitarbeiter/in (m/w/d) – Vollzeit";
const NEW_POSTING_TITLE = "Haustechniker/in (m/w/d) – Vollzeit";
const OLD_POSTING_DESC = "Objektschutz im Berliner Stadtgebiet. §34a erforderlich.";
const NEW_POSTING_DESC =
  "Betreuung von Kundenobjekten im Berliner Stadtgebiet. Führerschein Klasse B erforderlich.";

const OLD_INSTRUCTION_FRAGMENT = "Dienstkleidung erforderlich";
const NEW_INSTRUCTION_FRAGMENT = "Arbeitskleidung erforderlich";

const OLD_NEWS_FRAGMENT = "Empfangs- und Sicherheitsdienst";
const NEW_NEWS_FRAGMENT = "Reinigungs- und Facility-Service";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });

let totalChanged = 0;

function report(table: string, field: string, from: string, to: string, count: number) {
  totalChanged += count;
  const verb = DRY ? "would update" : "updated";
  const suffix = count === 0 ? " (already current)" : "";
  console.log(`  ${table}.${field}: "${from}" → "${to}" — ${verb} ${count} row(s)${suffix}`);
}

/**
 * Exact-match update, guarded by the old value.
 * In --dry mode it only counts the rows that WOULD change.
 */
async function updateExact(
  companyId: string,
  table: string,
  field: string,
  oldValue: string,
  newValue: string
) {
  if (DRY) {
    const { count, error } = await db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq(field, oldValue);
    if (error) throw new Error(`${table}.${field}: ${error.message}`);
    report(table, field, oldValue, newValue, count ?? 0);
    return;
  }

  const { data, error } = await db
    .from(table)
    .update({ [field]: newValue })
    .eq("company_id", companyId)
    .eq(field, oldValue) // guard: idempotent, second run matches nothing
    .select("id");
  if (error) throw new Error(`${table}.${field}: ${error.message}`);
  report(table, field, oldValue, newValue, data?.length ?? 0);
}

/**
 * Substring replacement inside a longer text field. Rows are selected by
 * `like`, then written back individually with their own old-value guard.
 */
async function replaceFragment(
  companyId: string,
  table: string,
  field: string,
  oldFragment: string,
  newFragment: string
) {
  const { data: rows, error } = await db
    .from(table)
    .select(`id, ${field}`)
    .eq("company_id", companyId)
    .like(field, `%${oldFragment}%`);
  if (error) throw new Error(`${table}.${field}: ${error.message}`);

  const matches = (rows ?? []) as unknown as Array<Record<string, string>>;
  if (DRY || matches.length === 0) {
    report(table, field, `…${oldFragment}…`, `…${newFragment}…`, matches.length);
    return;
  }

  let changed = 0;
  for (const row of matches) {
    const current = row[field];
    const next = current.split(oldFragment).join(newFragment);
    const { data: updated, error: updateError } = await db
      .from(table)
      .update({ [field]: next })
      .eq("id", row.id)
      .eq(field, current) // guard against a concurrent edit
      .select("id");
    if (updateError) throw new Error(`${table}.${field}: ${updateError.message}`);
    changed += updated?.length ?? 0;
  }
  report(table, field, `…${oldFragment}…`, `…${newFragment}…`, changed);
}

async function main() {
  // ---- Preflight: resolve exactly one company -----------------------------
  const { data: companies, error } = await db
    .from("companies")
    .select("id, name")
    .in("name", COMPANY_NAMES);
  if (error) throw new Error(`preflight: ${error.message}`);

  if (!companies || companies.length === 0) {
    console.error("Aborting: no Meridian demo company found. Nothing changed.");
    process.exit(1);
  }
  if (companies.length > 1) {
    console.error(
      `Aborting: ${companies.length} companies match the Meridian demo names — cannot resolve uniquely. Nothing changed.`
    );
    for (const c of companies) console.error(`  ${c.id}  ${c.name}`);
    process.exit(1);
  }

  const company = companies[0];
  console.log(DRY ? "DRY RUN — no data will be written.\n" : "Applying updates.\n");
  console.log(`Company: ${company.name}`);
  console.log(`company_id: ${company.id}\n`);

  console.log("Departments (renamed in place — IDs and employee links preserved)");
  for (const [from, to] of DEPARTMENT_RENAMES) {
    await updateExact(company.id, "departments", "name", from, to);
  }

  console.log("\nEmployee positions");
  for (const [from, to] of POSITION_RENAMES) {
    await updateExact(company.id, "employees", "position", from, to);
  }

  console.log("\nShift required roles");
  for (const [from, to] of ROLE_RENAMES) {
    await updateExact(company.id, "shifts", "required_role", from, to);
  }

  console.log("\nShift instructions");
  await replaceFragment(
    company.id,
    "shifts",
    "instructions",
    OLD_INSTRUCTION_FRAGMENT,
    NEW_INSTRUCTION_FRAGMENT
  );

  console.log("\nJob postings");
  await updateExact(company.id, "job_postings", "title", OLD_POSTING_TITLE, NEW_POSTING_TITLE);
  await updateExact(
    company.id,
    "job_postings",
    "description",
    OLD_POSTING_DESC,
    NEW_POSTING_DESC
  );

  console.log("\nCompany news");
  await replaceFragment(company.id, "news_posts", "body", OLD_NEWS_FRAGMENT, NEW_NEWS_FRAGMENT);

  console.log(
    `\n${DRY ? "Planned" : "Total"}: ${totalChanged} row(s) ${DRY ? "would change" : "changed"}.`
  );
  if (!DRY && totalChanged === 0) {
    console.log("Demo data was already industry-neutral — nothing to do.");
  }
  console.log(
    "Untouched: companies, locations/geofence, employees (other fields), assignments,"
  );
  console.log(
    "time entries, alerts, users, memberships, documents, messages, absences, audit logs."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

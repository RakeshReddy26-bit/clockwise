/**
 * One-time, idempotent rename of the demo company row.
 *
 *   "Meridian Sicherheit & Service GmbH"  →  "Meridian Facility & Service GmbH"
 *
 * Touches exactly one column of exactly one row: companies.name.
 * It never deletes, never reseeds, and never reads or writes employees,
 * memberships, shifts, assignments, time entries, alerts, or documents.
 * Safe to run repeatedly — a second run reports "already renamed".
 *
 * Run:  npm run rename:demo-company
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
config();

const OLD_NAME = "Meridian Sicherheit & Service GmbH";
const NEW_NAME = "Meridian Facility & Service GmbH";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  const { data: rows, error } = await db
    .from("companies")
    .select("id, name")
    .in("name", [OLD_NAME, NEW_NAME]);
  if (error) throw new Error(error.message);

  const alreadyRenamed = (rows ?? []).filter((r) => r.name === NEW_NAME);
  const toRename = (rows ?? []).filter((r) => r.name === OLD_NAME);

  if (toRename.length === 0) {
    if (alreadyRenamed.length > 0) {
      console.log(`No change: "${NEW_NAME}" is already the current name.`);
      console.log(`company_id: ${alreadyRenamed[0].id}`);
    } else {
      console.log(`No change: neither "${OLD_NAME}" nor "${NEW_NAME}" exists in this database.`);
    }
    return;
  }

  if (toRename.length > 1) {
    console.error(
      `Refusing to run: ${toRename.length} companies are named "${OLD_NAME}". Rename them manually.`
    );
    process.exit(1);
  }

  const target = toRename[0];
  const { data: updated, error: updateError } = await db
    .from("companies")
    .update({ name: NEW_NAME })
    .eq("id", target.id)
    .eq("name", OLD_NAME) // guard: only rename if it is still the old name
    .select("id, name");
  if (updateError) throw new Error(updateError.message);

  if (!updated || updated.length === 0) {
    console.log("No change: the row was already renamed by another run.");
    return;
  }

  console.log(`Renamed 1 company row (companies.name only).`);
  console.log(`  company_id: ${updated[0].id}`);
  console.log(`  before:     ${OLD_NAME}`);
  console.log(`  after:      ${updated[0].name}`);
  console.log("No other tables were read or modified.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

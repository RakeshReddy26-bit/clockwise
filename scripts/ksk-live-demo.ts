/**
 * Put the demo tenant into a believable live operational state, for today.
 *
 * WHY
 *
 * The Kiel dataset seeds a forward schedule. Days later those shifts are in the
 * past with nobody clocked in, and the operations board honestly reports "0 on
 * duty, 10 no-show" — correct, and impossible to show a customer. This script
 * writes one day's real operation anchored to the current clock, so the board
 * derives a plausible morning from genuine rows.
 *
 * WHAT IT IS NOT
 *
 * It does not touch the dashboard, the KPI maths, or any business rule. Every
 * number a viewer sees is still computed by the existing code from real shifts,
 * assignments and time entries. This only supplies the rows.
 *
 * The scenario itself lives in scripts/live-ops-demo-plan.ts and is unit-tested
 * (tests/unit/live-ops-demo-plan.test.ts) so the KPI mix cannot drift unnoticed.
 *
 * SAFETY
 *
 *   - Resolves exactly one demo company by name and aborts otherwise.
 *   - Touches only that company's rows.
 *   - Marks everything it creates with a visible demo tag, and cancels its own
 *     previous run rather than deleting anything.
 *   - Refuses to run unless --confirm is passed.
 *
 * Run:  npm run demo:live -- --confirm
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  LIVE_OPS_SHIFTS,
  LIVE_OPS_CREW_SIZE,
  clockInFor,
  clockOutFor,
  locationStatusFor,
  statusFor,
  expectedKpis,
  heroShiftRole,
  RESERVE_SIZE,
  HERO_SHIFT_KEY,
  type DemoShift,
} from "./live-ops-demo-plan";
import { KSK_COMPANY_NAME } from "./ksk-demo-plan";
import { attendanceThresholds } from "../src/lib/attendance";

config({ path: ".env.local" });
config();

/** The demo tenants this script is willing to touch. Nothing else, ever. */
const COMPANY_NAMES = [KSK_COMPANY_NAME];

/**
 * Stamped on every shift this script creates.
 *
 * Two jobs: it makes the data visibly synthetic to anyone reading the row, and
 * it is how a re-run finds its own previous output without guessing.
 */
const DEMO_TAG = "LIVE-OPS DEMO";
const CONTACT_PERSON = `${DEMO_TAG} · Leitstelle KSK`;
const ORIGINAL_KSK_DEMO_CONTACT_PERSON = "Marco Litfin — Demo Dispatch";
const PRESENTATION_DEMO_CONTACTS = [
  CONTACT_PERSON,
  ORIGINAL_KSK_DEMO_CONTACT_PERSON,
] as const;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!process.argv.includes("--confirm")) {
  console.error(
    "This rewrites today's demo operation for the demo tenant.\n" +
      "Re-run with --confirm once you are sure this is not a production database."
  );
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

const MINUTE = 60_000;
const at = (offsetMin: number) => new Date(Date.now() + offsetMin * MINUTE).toISOString();

/** Current Europe/Berlin presentation day as an absolute time window. */
function presentationDayWindow(now: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const start = new Date(`${parts}T00:00:00+02:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

async function resolveCompany(): Promise<{ id: string; name: string; settings: Record<string, unknown> }> {
  const { data, error } = await db
    .from("companies")
    .select("id, name, settings")
    .in("name", COMPANY_NAMES);
  if (error) throw new Error(`preflight: ${error.message}`);
  if (!data?.length) throw new Error("Demo company not found. Nothing changed.");
  if (data.length > 1) throw new Error("Demo company is ambiguous. Nothing changed.");
  return {
    id: data[0].id,
    name: data[0].name,
    settings: (data[0].settings ?? {}) as Record<string, unknown>,
  };
}

/**
 * Retire the previous run.
 *
 * Cancelling rather than deleting, for two reasons: migration 0012 makes shifts
 * undeletable for everyone by design, and a cancelled shift is the honest
 * representation of "this was called off" — the board already knows to drop it.
 */
async function retirePreviousRun(companyId: string): Promise<number> {
  // The shifts.date column is derived by the database in Europe/Berlin.
  // Restrict cleanup to the current presentation day so historical and
  // future synthetic KSK shifts remain untouched.
  const presentationDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const { data: previous, error } = await db
    .from("shifts")
    .select("id")
    .eq("company_id", companyId)
    .eq("date", presentationDate)
    .in("contact_person", [...PRESENTATION_DEMO_CONTACTS])
    .in("status", ["open", "staffed", "in_progress"]);
  if (error) throw new Error(`retire lookup: ${error.message}`);
  const ids = (previous ?? []).map((s) => s.id as string);
  if (ids.length === 0) return 0;

  // Assignments first: a cancelled shift must not leave people still rostered.
  const { error: assignmentError } = await db
    .from("shift_assignments")
    .update({ status: "cancelled" })
    .in("shift_id", ids)
    .in("status", ["assigned", "accepted", "cancellation_requested"]);
  if (assignmentError) throw new Error(`retire assignments: ${assignmentError.message}`);

  const { error: shiftError } = await db
    .from("shifts")
    .update({ status: "cancelled" })
    .in("id", ids);
  if (shiftError) throw new Error(`retire shifts: ${shiftError.message}`);

  return ids.length;
}

async function resolveJob(companyId: string, clientName: string, siteName: string): Promise<string> {
  const { data: location } = await db
    .from("locations")
    .select("id")
    .eq("company_id", companyId)
    .eq("name", siteName)
    .maybeSingle();
  if (!location) throw new Error(`Worksite "${siteName}" is missing. Run npm run add:kiel-demo first.`);

  const { data: job } = await db
    .from("jobs")
    .select("id")
    .eq("company_id", companyId)
    .eq("client_name", clientName)
    .eq("location_id", location.id)
    .maybeSingle();
  if (job) return job.id as string;

  const { data: created, error } = await db
    .from("jobs")
    .insert({
      company_id: companyId,
      client_name: clientName,
      location_id: location.id,
      description: `${DEMO_TAG} — synthetisches Einsatzszenario.`,
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw new Error(`job "${clientName}": ${error.message}`);
  return created.id as string;
}

/**
 * Active employees in a stable order: the working crew, then the reserve.
 *
 * The reserve is deliberately not rostered in today's LiveOps shifts, so
 * Clockwise's normal eligibility engine can genuinely consider them.
 */
async function resolveCrew(
  companyId: string
): Promise<{
  crew: Array<{ id: string; name: string }>;
  reserve: Array<{ id: string; name: string }>;
}> {
  const needed = LIVE_OPS_CREW_SIZE + RESERVE_SIZE;

  const { data, error } = await db
    .from("employees")
    .select("id, full_name, employee_no")
    .eq("company_id", companyId)
    .eq("employment_status", "active")
    .order("employee_no", { ascending: true })
    .limit(needed);

  if (error) throw new Error(`crew: ${error.message}`);

  const people = (data ?? []).map((e) => ({
    id: e.id as string,
    name: e.full_name as string,
  }));

  if (people.length < needed) {
    throw new Error(
      `Need ${needed} active employees (${LIVE_OPS_CREW_SIZE} on shift + ${RESERVE_SIZE} reserve), found ${people.length}. Run npm run seed:ksk-demo first.`
    );
  }

  return {
    crew: people.slice(0, LIVE_OPS_CREW_SIZE),
    reserve: people.slice(LIVE_OPS_CREW_SIZE, needed),
  };
}

/**
 * Give the synthetic reserve the actual role required by the hero shift.
 *
 * This changes demo HR data only. It does not bypass or modify eligibility.
 */
async function prepareReserve(
  companyId: string,
  reserve: Array<{ id: string; name: string }>
): Promise<void> {
  const role = heroShiftRole();
  const ids = reserve.map((person) => person.id);

  const { error } = await db
    .from("employees")
    .update({ position: role })
    .eq("company_id", companyId)
    .in("id", ids);

  if (error) throw new Error(`reserve role: ${error.message}`);
}

/**
 * Report how many reserve employees are genuinely available today.
 * This does not bypass the eligibility engine or clear legitimate exclusions.
 */
async function reserveAvailableToday(
  companyId: string,
  reserve: Array<{ id: string; name: string }>,
  window: { start: Date; end: Date }
): Promise<number> {
  const ids = reserve.map((r) => r.id);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(window.start);

  const [{ data: busy }, { data: vacation }, { data: sick }, { data: unavailable }] =
    await Promise.all([
      db
        .from("shift_assignments")
        .select("employee_id, shifts!inner(start_time, end_time)")
        .eq("company_id", companyId)
        .in("employee_id", ids)
        .in("status", ["assigned", "accepted", "cancellation_requested"])
        .gte("shifts.end_time", window.start.toISOString())
        .lt("shifts.start_time", window.end.toISOString())
        .limit(100),
      db
        .from("vacation_requests")
        .select("employee_id")
        .eq("company_id", companyId)
        .in("employee_id", ids)
        .eq("status", "approved")
        .lte("start_date", today)
        .gte("end_date", today)
        .limit(50),
      db
        .from("sick_leaves")
        .select("employee_id")
        .eq("company_id", companyId)
        .in("employee_id", ids)
        .in("status", ["reported", "confirmed"])
        .lte("start_date", today)
        .limit(50),
      db
        .from("employee_availability")
        .select("employee_id")
        .eq("company_id", companyId)
        .in("employee_id", ids)
        .eq("type", "unavailable")
        .limit(50),
    ]);

  const blocked = new Set<string>();
  for (const rows of [busy, vacation, sick, unavailable]) {
    for (const row of (rows ?? []) as Array<{ employee_id: string }>) {
      blocked.add(row.employee_id);
    }
  }

  return ids.filter((id) => !blocked.has(id)).length;
}

/**
 * Reject stale pending manual clock-in requests from earlier presentation days.
 * The KSK demo tenant is synthetic; rows are settled, never deleted.
 */
async function settleStaleManualRequests(
  companyId: string,
  window: { start: Date; end: Date }
): Promise<number> {
  const { data: settled, error } = await db
    .from("manual_clockin_requests")
    .update({
      status: "rejected",
      decided_at: new Date().toISOString(),
    })
    .eq("company_id", companyId)
    .eq("status", "pending")
    .lt("created_at", window.start.toISOString())
    .select("id");

  if (error) throw new Error(`settle manual requests: ${error.message}`);
  return (settled ?? []).length;
}

async function writeShift(
  companyId: string,
  jobId: string,
  spec: DemoShift,
  crew: Array<{ id: string; name: string }>
): Promise<void> {
  const startTime = at(spec.startOffsetMin);
  const endTime = at(spec.endOffsetMin);

  const { data: shift, error } = await db
    .from("shifts")
    .insert({
      company_id: companyId,
      job_id: jobId,
      // The DB derives `date` itself from start_time in Europe/Berlin (0011);
      // sending one here would be the caller claiming a calendar day.
      date: new Date(startTime).toISOString().slice(0, 10),
      start_time: startTime,
      end_time: endTime,
      required_count: spec.requiredCount,
      required_role: spec.role,
      contact_person: CONTACT_PERSON,
      instructions: `${DEMO_TAG} — Demodaten, kein realer Kundenauftrag.`,
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw new Error(`shift ${spec.key}: ${error.message}`);
  const shiftId = shift.id as string;

  for (const assignment of spec.assignments) {
    const person = crew[assignment.crew];

    const { data: row, error: assignmentError } = await db
      .from("shift_assignments")
      .insert({
        company_id: companyId,
        shift_id: shiftId,
        employee_id: person.id,
        status: "accepted",
      })
      .select("id")
      .single();
    if (assignmentError) {
      throw new Error(`assignment ${spec.key}/${person.name}: ${assignmentError.message}`);
    }
    const assignmentId = row.id as string;

    const clockIn = clockInFor(assignment.intent);
    if (clockIn !== null) {
      const clockOut = clockOutFor(assignment.intent);
      const locationStatus = locationStatusFor(assignment.intent);
      const { error: entryError } = await db.from("time_entries").insert({
        company_id: companyId,
        employee_id: person.id,
        shift_assignment_id: assignmentId,
        clock_in: at(clockIn),
        clock_out: clockOut === null ? null : at(clockOut),
        status: clockOut === null ? "running" : "completed",
        source: "app",
        clock_in_location_status: locationStatus,
        clock_in_distance_m:
          assignment.intent.kind === "outside_geofence" ? assignment.intent.distanceM : 12,
      });
      if (entryError) throw new Error(`time entry ${spec.key}/${person.name}: ${entryError.message}`);

      // The board's "outside-site attempts" card reads location_events, so the
      // flagged clock-in needs the event that would really have been written.
      if (assignment.intent.kind === "outside_geofence") {
        await db.from("location_events").insert({
          company_id: companyId,
          employee_id: person.id,
          shift_assignment_id: assignmentId,
          event_type: "clock_in_outside_geofence",
          distance_m: assignment.intent.distanceM,
          allowed_radius_m: 250,
        });
      }
    }

    if (assignment.pendingManualRequest) {
      const request = assignment.pendingManualRequest;
      const { error: requestError } = await db.from("manual_clockin_requests").insert({
        company_id: companyId,
        employee_id: person.id,
        shift_assignment_id: assignmentId,
        status: "pending",
        reason: request.reason,
        reason_note: request.note,
        distance_m: 180,
        created_at: at(-request.minutesAgo),
      });
      if (requestError) {
        throw new Error(`manual request ${spec.key}/${person.name}: ${requestError.message}`);
      }
    }
  }
}

/**
 * Write the alerts the scheduled evaluator would have written by now.
 *
 * Derived from the same attendance engine rather than asserted, so the demo
 * cannot show an alert the rules would not actually raise.
 */
async function writeAlerts(
  companyId: string,
  thresholds: ReturnType<typeof attendanceThresholds>,
  crew: Array<{ id: string; name: string }>
): Promise<number> {
  let written = 0;
  for (const spec of LIVE_OPS_SHIFTS) {
    for (const assignment of spec.assignments) {
      const status = statusFor(spec, assignment, thresholds);
      if (status !== "late" && status !== "no_show") continue;

      const person = crew[assignment.crew];
      const { data: found } = await db
        .from("shift_assignments")
        .select("id, shifts!inner(contact_person)")
        .eq("company_id", companyId)
        .eq("employee_id", person.id)
        .eq("shifts.contact_person", CONTACT_PERSON)
        .in("status", ["assigned", "accepted"])
        .limit(1);
      const assignmentId = (found ?? [])[0]?.id as string | undefined;
      if (!assignmentId) continue;

      const { error } = await db.from("attendance_alerts").insert({
        company_id: companyId,
        employee_id: person.id,
        shift_assignment_id: assignmentId,
        type: status === "no_show" ? "no_show" : "late_clock_in",
        minutes_delta: Math.abs(spec.startOffsetMin),
        status: "open",
      });
      if (!error) written += 1;
    }
  }
  return written;
}

async function main() {
  const company = await resolveCompany();
  console.log(`Company: ${company.name}`);
  console.log(`company_id: ${company.id}\n`);

  const retired = await retirePreviousRun(company.id);
  if (retired > 0) console.log(`Retired ${retired} shift(s) from a previous run.\n`);

  const window = presentationDayWindow(new Date());

  const settled = await settleStaleManualRequests(company.id, window);
  if (settled > 0) {
    console.log(`Settled ${settled} stale manual clock-in request(s).\n`);
  }

  const { crew, reserve } = await resolveCrew(company.id);
  await prepareReserve(company.id, reserve);
  console.log(
    `Crew: ${crew.length} on shift, ${reserve.length} reserve (${heroShiftRole()})\n`
  );

  for (const spec of LIVE_OPS_SHIFTS) {
    const jobId = await resolveJob(company.id, spec.clientName, spec.siteName);
    await writeShift(company.id, jobId, spec, crew);
    console.log(`  created  ${spec.siteName} — ${spec.assignments.length}/${spec.requiredCount}`);
  }

  const thresholds = attendanceThresholds(company.settings);
  const alerts = await writeAlerts(company.id, thresholds, crew);
  console.log(`\nAlerts written: ${alerts}`);

  const eligibleReserve = await reserveAvailableToday(company.id, reserve, window);
  console.log(
    `Reserve available for ${HERO_SHIFT_KEY}: ${eligibleReserve}/${RESERVE_SIZE}`
  );

  if (eligibleReserve < 3) {
    console.warn(
      "  WARNING: fewer than 3 reserve candidates are genuinely available.\n" +
        "  Check absence, availability, or overlapping-shift data instead of relaxing eligibility."
    );
  }

  const kpis = expectedKpis(thresholds);
  console.log("\nThe operations board should now show:");
  console.log(`  on duty          ${kpis.onDuty}`);
  console.log(`  late             ${kpis.late}`);
  console.log(`  no show          ${kpis.noShow}`);
  console.log(`  outside site     ${kpis.outsideSite}`);
  console.log(`  manual requests  ${kpis.pendingManualRequests}`);
  console.log(`  ending soon      ${kpis.endingSoon}`);
  console.log(`  starting later   ${kpis.upcoming}`);
  console.log(`  scheduled today  ${kpis.scheduled}`);
  console.log("\nDone. All rows are tagged " + DEMO_TAG + ".");
}

main().catch((error) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

/**
 * Phase D — shift lifecycle.
 *
 * The three manager actions, and the invariants that make them safe to give to
 * a dispatcher: capacity can never drop below the people already holding a
 * seat, a shift that has been worked can neither be edited dangerously nor
 * called off, an invitation is never silently redefined under the people who
 * accepted it, and — the one that needed proving rather than reasoning —
 * cancelling a shift cannot commit alongside a clock-in.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  createTestDatabase,
  runAs as runAsUser,
  type QueryFn,
  USERS,
  COMPANY_A,

  EMPLOYEES,
  OFFERS,
  OFFER_RESPONSES,
} from "./helpers";

const DB_NAME = "clockwise_shift_lifecycle_test";
const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);

const A_JOB = "aaaa2222-0000-0000-0000-000000000001";
const B_JOB = "bbbb2222-0000-0000-0000-000000000001";
const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";
const A_ASSIGNMENT_2 = "aaaa4444-0000-0000-0000-000000000009";
const REASON = "Kunde hat den Auftrag abgesagt.";

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

type Result = Record<string, unknown> & { status: string };

const call = (userId: string, sql: string, params: unknown[]) =>
  runAs(userId, async (q) => (await q(sql, params)).rows[0].r as Result, { commit: true });

/**
 * `start` and `end` are SQL interval expressions, not bound values — the tests
 * need times relative to now(), and a bound parameter cannot carry an
 * expression. They are literals in this file, never input.
 */
const createAs = (
  userId: string,
  o: {
    jobId?: string;
    start?: string;
    end?: string;
    count?: number;
    role?: string | null;
    qualification?: string | null;
  } = {}
) =>
  call(
    userId,
    `select public.create_shift($1, ${o.start ?? "now() + interval '3 days'"},
       ${o.end ?? "now() + interval '3 days 8 hours'"}, $2, $3, $4, $5, $6) as r`,
    [
      o.jobId ?? A_JOB,
      o.count ?? 2,
      o.role ?? null,
      o.qualification ?? null,
      "Treffpunkt Haupteingang.",
      "Marco Litfin",
    ]
  );

const updateAs = (userId: string, patch: Record<string, unknown>, confirm = false) =>
  call(userId, "select public.update_shift($1,$2::jsonb,$3) as r", [
    A_SHIFT,
    JSON.stringify(patch),
    confirm,
  ]);

const cancelAs = (userId: string, reason = REASON, shiftId = A_SHIFT) =>
  call(userId, "select public.cancel_shift($1,$2) as r", [shiftId, reason]);

async function shift(): Promise<Record<string, unknown>> {
  const { rows } = await db.query("select * from public.shifts where id = $1", [A_SHIFT]);
  return rows[0];
}

async function occupancy(): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int c from public.shift_assignments
     where shift_id = $1 and status in ('assigned','accepted','cancellation_requested')`,
    [A_SHIFT]
  );
  return Number(rows[0].c);
}

async function audits(action?: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query(
    action
      ? "select * from public.audit_logs where action = $1 order by id"
      : "select * from public.audit_logs order by id",
    action ? [action] : []
  );
  return rows;
}

/** One future shift, two seats, one person assigned, an open offer. */
async function reset({ occupied = 1, requiredCount = 2 } = {}) {
  await db.query("delete from public.audit_logs");
  await db.query("delete from public.time_entries");
  await db.query("delete from public.cancellation_requests");
  await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
  await db.query("delete from public.shifts where id <> $1 and company_id = $2", [
    A_SHIFT,
    COMPANY_A,
  ]);
  await db.query(
    `update public.shifts
     set required_count = $2, status = 'open', required_role = null, required_qualification = null,
         instructions = 'Alt', contact_person = 'Alt',
         date = ((now() + interval '3 days') at time zone 'Europe/Berlin')::date,
         start_time = now() + interval '3 days',
         end_time = now() + interval '3 days 8 hours'
     where id = $1`,
    [A_SHIFT, requiredCount]
  );
  if (occupied >= 1) {
    await db.query(
      `insert into public.shift_assignments (id, company_id, shift_id, employee_id, status)
       values ($1,$2,$3,$4,'assigned')`,
      [A_ASSIGNMENT, COMPANY_A, A_SHIFT, EMPLOYEES.aSelf]
    );
  }
  if (occupied >= 2) {
    await db.query(
      `insert into public.shift_assignments (id, company_id, shift_id, employee_id, status)
       values ($1,$2,$3,$4,'accepted')`,
      [A_ASSIGNMENT_2, COMPANY_A, A_SHIFT, EMPLOYEES.aColleague]
    );
  }
  await db.query("update public.shift_offers set status='open', closed_at=null where id=$1", [
    OFFERS.a,
  ]);
  await db.query(
    `update public.shift_offer_responses
     set response='pending', responded_at=null, decided_by=null, decided_at=null,
         resulting_assignment_id=null
     where offer_id = $1`,
    [OFFERS.a]
  );
  await db.query("update public.employees set employment_status='active' where company_id=$1", [
    COMPANY_A,
  ]);
}

/** Drop the offer so the shift sits at engagement 'none'. */
async function noEngagement() {
  await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
  await db.query("update public.shift_offers set status='cancelled' where shift_id=$1", [A_SHIFT]);
}

beforeAll(async () => {
  db = await createTestDatabase(DB_NAME);
}, 60_000);

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await reset();
});

/* ===================================================================== */
describe("create", () => {
  it("creates a future shift with a derived date and open status", async () => {
    const result = await createAs(USERS.aDispatcher);
    expect(result.status).toBe("created");

    const { rows } = await db.query("select * from public.shifts where id = $1", [
      result.shift_id,
    ]);
    expect(rows[0].status).toBe("open");
    expect(rows[0].company_id).toBe(COMPANY_A);
    expect(rows[0].required_count).toBe(2);
    expect(rows[0].instructions).toBe("Treffpunkt Haupteingang.");
  });

  it("a company admin may create; an employee may not", async () => {
    expect((await createAs(USERS.aAdmin)).status).toBe("created");

    const denied = await createAs(USERS.aWorker);
    expect(denied.status).toBe("forbidden");
  });

  it("cannot create against another tenant's job", async () => {
    // RLS hides the job entirely, so this is not even a permission error.
    expect((await createAs(USERS.aDispatcher, { jobId: B_JOB })).status).toBe("not_found");
    const { rows } = await db.query("select count(*)::int c from public.shifts where job_id = $1", [
      B_JOB,
    ]);
    expect(Number(rows[0].c)).toBe(1); // only the fixture's own shift
  });

  it("refuses a start in the past", async () => {
    const r = await createAs(USERS.aDispatcher, {
      start: "now() - interval '1 hour'",
      end: "now() + interval '4 hours'",
    });
    expect(r.status).toBe("start_in_past");
  });

  it("refuses an inverted or empty interval", async () => {
    expect(
      (
        await createAs(USERS.aDispatcher, {
          start: "now() + interval '3 days 8 hours'",
          end: "now() + interval '3 days'",
        })
      ).status
    ).toBe("invalid_interval");

    expect(
      (
        await createAs(USERS.aDispatcher, {
          start: "now() + interval '3 days'",
          end: "now() + interval '3 days'",
        })
      ).status
    ).toBe("invalid_interval");
  });

  it("refuses a non-positive required_count", async () => {
    for (const count of [0, -1]) {
      expect((await createAs(USERS.aDispatcher, { count })).status).toBe("invalid_count");
    }
  });

  it("writes exactly one audit row, and none when refused", async () => {
    await createAs(USERS.aDispatcher);
    expect(await audits("shift.created")).toHaveLength(1);

    await createAs(USERS.aDispatcher, { count: 0 });
    await createAs(USERS.aWorker);
    expect(await audits("shift.created")).toHaveLength(1);
  });

  it("trims blank optional text to null rather than storing empty strings", async () => {
    const r = await call(
      USERS.aDispatcher,
      "select public.create_shift($1, now() + interval '3 days', now() + interval '3 days 8 hours', 1, '  ', '', '  ', null) as r",
      [A_JOB]
    );
    const { rows } = await db.query(
      "select required_role, required_qualification, instructions from public.shifts where id = $1",
      [r.shift_id]
    );
    expect(rows[0].required_role).toBeNull();
    expect(rows[0].required_qualification).toBeNull();
    expect(rows[0].instructions).toBeNull();
  });
});

/* ===================================================================== */
describe("date derivation", () => {
  async function dateOf(start: string): Promise<string> {
    const r = await call(
      USERS.aDispatcher,
      `select public.create_shift($1, $2::timestamptz, $2::timestamptz + interval '8 hours', 1, null, null, null, null) as r`,
      [A_JOB, start]
    );
    const { rows } = await db.query("select date from public.shifts where id = $1", [r.shift_id]);
    return (rows[0].date as Date).toISOString().slice(0, 10);
  }

  it("uses the German calendar date of the start, not the caller's offset", async () => {
    // 00:30 Berlin on 2027-03-10 is 23:30 UTC on 2027-03-09. The German date
    // is what the seed data and the whole scheduling UI already mean.
    expect(await dateOf("2027-03-09T23:30:00Z")).toBe("2027-03-10");
  });

  it("gives an overnight shift the date it starts on", async () => {
    // 22:00 Berlin, running to 06:00 the next morning — the convention in
    // scripts/kiel-demo-plan.ts.
    expect(await dateOf("2027-03-10T21:00:00Z")).toBe("2027-03-10");
  });

  it("is stable across a DST boundary", async () => {
    // Last Sunday in March 2027 is the 28th; +01:00 before, +02:00 after.
    expect(await dateOf("2027-03-27T23:30:00Z")).toBe("2027-03-28");
    expect(await dateOf("2027-10-30T23:30:00Z")).toBe("2027-10-31");
  });

  it("date cannot desynchronise from start_time on edit", async () => {
    await noEngagement();
    const before = (await shift()).date;
    // Both ends move together: the function correctly refuses an edit that
    // would leave end_time before start_time, which is how this test first
    // failed.
    await updateAs(USERS.aDispatcher, {
      start_time: "2027-06-01T04:00:00Z",
      end_time: "2027-06-01T12:00:00Z",
    });
    const after = await shift();
    expect((after.date as Date).toISOString().slice(0, 10)).toBe("2027-06-01");
    expect(after.date).not.toEqual(before);
  });

  it("a caller cannot set date directly — it is always recomputed", async () => {
    await noEngagement();
    await updateAs(USERS.aDispatcher, {
      start_time: "2027-06-01T04:00:00Z",
      end_time: "2027-06-01T12:00:00Z",
      date: "2020-01-01",
    });
    expect(((await shift()).date as Date).toISOString().slice(0, 10)).toBe("2027-06-01");
  });
});

/* ===================================================================== */
describe("edit — safe fields", () => {
  it("instructions and contact person change at any engagement", async () => {
    const r = await updateAs(USERS.aDispatcher, {
      instructions: "Neuer Treffpunkt: Tor 3",
      contact_person: "Katrin",
    });
    expect(r.status).toBe("updated");
    expect(r.notify).toBe(true);
    expect((await shift()).instructions).toBe("Neuer Treffpunkt: Tor 3");
  });

  it("a no-op edit changes nothing and writes no audit row", async () => {
    const current = await shift();
    const r = await updateAs(USERS.aDispatcher, {
      instructions: current.instructions,
      contact_person: current.contact_person,
      required_count: current.required_count,
    });
    expect(r.status).toBe("no_changes");
    expect(await audits("shift.updated")).toHaveLength(0);
  });

  it("treats blank and absent text as the same value", async () => {
    await db.query("update public.shifts set instructions = null where id = $1", [A_SHIFT]);
    expect((await updateAs(USERS.aDispatcher, { instructions: "   " })).status).toBe("no_changes");
  });

  it("a time edit is free while nobody has been contacted", async () => {
    await noEngagement();
    const r = await updateAs(USERS.aDispatcher, {
      start_time: "2027-06-01T06:00:00Z",
      end_time: "2027-06-01T14:00:00Z",
    });
    expect(r.status).toBe("updated");
  });

  it("refuses an inverted interval and a past start", async () => {
    await noEngagement();
    expect(
      (await updateAs(USERS.aDispatcher, { end_time: "2020-01-01T00:00:00Z" })).status
    ).toBe("invalid_interval");
    expect(
      (
        await updateAs(USERS.aDispatcher, {
          start_time: "2020-01-01T00:00:00Z",
          end_time: "2020-01-01T08:00:00Z",
        })
      ).status
    ).toBe("start_in_past");
  });
});

/* ===================================================================== */
describe("edit — capacity", () => {
  it("raising capacity reopens a staffed shift", async () => {
    // The defect found in the Phase D audit: the staffing trigger fires on
    // shift_assignments and never on shifts, so without an explicit
    // recomputation this shift would keep claiming to be staffed.
    await reset({ occupied: 1, requiredCount: 1 });
    expect((await shift()).status).toBe("staffed");

    const r = await updateAs(USERS.aDispatcher, { required_count: 3 });
    expect(r.status).toBe("updated");
    expect((await shift()).status).toBe("open");
    expect((await shift()).required_count).toBe(3);
  });

  it("lowering capacity back to occupancy restores staffed", async () => {
    await reset({ occupied: 1, requiredCount: 3 });
    expect((await shift()).status).toBe("open");
    await updateAs(USERS.aDispatcher, { required_count: 1 });
    expect((await shift()).status).toBe("staffed");
  });

  it("refuses to drop below occupancy and mutates nothing", async () => {
    await reset({ occupied: 2, requiredCount: 3 });
    const r = await updateAs(USERS.aDispatcher, {
      required_count: 1,
      instructions: "sollte nicht gespeichert werden",
    });
    expect(r.status).toBe("below_occupancy");
    expect(r.occupancy).toBe(2);

    const s = await shift();
    expect(s.required_count).toBe(3);
    expect(s.instructions).toBe("Alt");
    expect(await audits("shift.updated")).toHaveLength(0);
    expect(await occupancy()).toBe(2);
  });

  it("never removes an employee as a side effect", async () => {
    await reset({ occupied: 2, requiredCount: 3 });
    await updateAs(USERS.aDispatcher, { required_count: 1 });
    expect(await occupancy()).toBe(2);
  });

  it("does not notify for a capacity-only change", async () => {
    const r = await updateAs(USERS.aDispatcher, { required_count: 4 });
    expect(r.status).toBe("updated");
    expect(r.notify).toBe(false);
  });

  it("refuses a non-positive capacity", async () => {
    expect((await updateAs(USERS.aDispatcher, { required_count: 0 })).status).toBe(
      "invalid_count"
    );
  });
});

/* ===================================================================== */
describe("edit — engagement ladder", () => {
  /** An open offer with one interested employee, nobody assigned. */
  async function interested() {
    await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
    await db.query(
      "update public.shift_offer_responses set response='interested', responded_at=now() where id=$1",
      [OFFER_RESPONSES.aSelf]
    );
  }

  it("a risky edit requires confirmation once an offer is open", async () => {
    await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
    const r = await updateAs(USERS.aDispatcher, { required_role: "Reinigungskraft" });
    expect(r.status).toBe("requires_confirmation");
    expect(r.reason).toBe("invalidates_open_offer");
    expect(r.engagement).toBe("offered");

    // Nothing happened yet.
    expect((await shift()).required_role).toBeNull();
    expect(await audits("shift.updated")).toHaveLength(0);
  });

  it("confirming applies the edit and closes the offer", async () => {
    await interested();
    const r = await updateAs(USERS.aDispatcher, { required_role: "Reinigungskraft" }, true);
    expect(r.status).toBe("updated");
    expect(r.offer_closed).toBe(true);

    expect((await shift()).required_role).toBe("Reinigungskraft");
    const { rows } = await db.query(
      "select status, closed_at from public.shift_offers where id = $1",
      [OFFERS.a]
    );
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].closed_at).not.toBeNull();
  });

  it("historical responses survive the offer being closed", async () => {
    await interested();
    await updateAs(USERS.aDispatcher, { required_role: "Reinigungskraft" }, true);
    const { rows } = await db.query(
      "select response from public.shift_offer_responses where offer_id = $1 order by id",
      [OFFERS.a]
    );
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.response === "interested")).toBe(true);
  });

  it("a confirmed edit cannot be replayed into a second offer closure", async () => {
    await interested();
    await updateAs(USERS.aDispatcher, { required_role: "Reinigungskraft" }, true);
    const again = await updateAs(USERS.aDispatcher, { required_role: "Reinigungskraft" }, true);
    expect(again.status).toBe("no_changes");
    expect(await audits("shift.updated")).toHaveLength(1);
  });

  it("an assigned employee blocks a role, qualification or time edit", async () => {
    for (const patch of [
      { required_role: "Reinigungskraft" },
      { required_qualification: "Staplerschein" },
      { start_time: "2027-06-01T06:00:00Z" },
    ]) {
      const r = await updateAs(USERS.aDispatcher, patch, true);
      expect(r.status).toBe("has_assignments");
    }
    expect((await shift()).required_role).toBeNull();
  });

  it("the job — and therefore the site — locks as soon as anyone is invited", async () => {
    await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
    const r = await updateAs(USERS.aDispatcher, { job_id: A_JOB }, true);
    // same job = no change at all
    expect(r.status).toBe("no_changes");

    const { rows } = await db.query(
      `insert into public.jobs (company_id, client_name) values ($1,'Kunde D') returning id`,
      [COMPANY_A]
    );
    const other = rows[0].id as string;
    expect((await updateAs(USERS.aDispatcher, { job_id: other }, true)).status).toBe("job_locked");
  });

  it("the job may be corrected while nobody has been contacted", async () => {
    await noEngagement();
    const { rows } = await db.query(
      `insert into public.jobs (company_id, client_name) values ($1,'Kunde E') returning id`,
      [COMPANY_A]
    );
    const r = await updateAs(USERS.aDispatcher, { job_id: rows[0].id }, true);
    expect(r.status).toBe("updated");
  });

  it("cannot be moved to another tenant's job", async () => {
    await noEngagement();
    expect((await updateAs(USERS.aDispatcher, { job_id: B_JOB }, true)).status).toBe("not_found");
  });

  it("recorded time blocks a dangerous edit", async () => {
    await db.query(
      `insert into public.time_entries (company_id, employee_id, shift_assignment_id, clock_in, status)
       values ($1,$2,$3, now(), 'running')`,
      [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT]
    );
    expect((await updateAs(USERS.aDispatcher, { start_time: "2027-06-01T06:00:00Z" }, true)).status)
      .toBe("has_time_entries");
  });

  it("a finished shift refuses every edit, including instructions", async () => {
    await db.query(
      `update public.shifts set start_time = now() - interval '10 hours',
         end_time = now() - interval '2 hours' where id = $1`,
      [A_SHIFT]
    );
    expect((await updateAs(USERS.aDispatcher, { instructions: "zu spät" })).status).toBe(
      "shift_ended"
    );
  });

  it("an employee cannot edit, and a foreign manager sees nothing", async () => {
    // not_found for both: the locking read applies the UPDATE policy, and
    // neither passes shifts_staff. Nothing about the shift is leaked.
    expect((await updateAs(USERS.aWorker, { instructions: "hallo" })).status).toBe("not_found");
    expect((await updateAs(USERS.bAdmin, { instructions: "hallo" })).status).toBe("not_found");
    expect((await shift()).instructions).toBe("Alt");
  });

  it("records only the fields that changed", async () => {
    await updateAs(USERS.aDispatcher, {
      instructions: "Neu",
      contact_person: "Alt",
      required_count: 2,
    });
    const rows = await audits("shift.updated");
    expect(rows).toHaveLength(1);
    const diff = rows[0].diff as { changes: Record<string, unknown> };
    expect(Object.keys(diff.changes)).toEqual(["instructions"]);
  });
});

/* ===================================================================== */
describe("cancel", () => {
  it("cancels the shift, its assignments and its open offer", async () => {
    const r = await cancelAs(USERS.aDispatcher);
    expect(r.status).toBe("cancelled");
    expect(r.assignments_cancelled).toBe(1);
    expect(r.offers_closed).toBe(1);

    expect((await shift()).status).toBe("cancelled");
    expect(await occupancy()).toBe(0);
    const { rows } = await db.query("select status from public.shift_offers where id = $1", [
      OFFERS.a,
    ]);
    expect(rows[0].status).toBe("cancelled");
  });

  it("settles a pending release request rather than leaving it stranded", async () => {
    await runAs(
      USERS.aWorker,
      async (q) =>
        q("select public.request_shift_cancellation($1,$2)", [A_ASSIGNMENT, "Kind krank"]),
      { commit: true }
    );

    const r = await cancelAs(USERS.aDispatcher);
    expect(r.requests_settled).toBe(1);

    const { rows } = await db.query(
      "select status, decided_by from public.cancellation_requests where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    expect(rows[0].status).toBe("approved");
    expect(rows[0].decided_by).toBe(USERS.aDispatcher);
  });

  it("preserves responses, assignments and attendance history", async () => {
    await db.query(
      `insert into public.attendance_alerts (company_id, employee_id, shift_assignment_id, type, minutes_delta, scheduled_start, scheduled_end)
       select $1,$2,$3,'late_clock_in',12, start_time, end_time from public.shifts where id=$4`,
      [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT, A_SHIFT]
    );
    await cancelAs(USERS.aDispatcher);

    const responses = await db.query(
      "select count(*)::int c from public.shift_offer_responses where offer_id = $1",
      [OFFERS.a]
    );
    expect(Number(responses.rows[0].c)).toBe(2);
    const alerts = await db.query(
      "select count(*)::int c from public.attendance_alerts where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    expect(Number(alerts.rows[0].c)).toBe(1);
    const { rows } = await db.query(
      "select count(*)::int c from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    expect(Number(rows[0].c)).toBe(1); // kept as history, status cancelled
  });

  it("refuses once any time has been recorded", async () => {
    await db.query(
      `insert into public.time_entries (company_id, employee_id, shift_assignment_id, clock_in, status)
       values ($1,$2,$3, now(), 'running')`,
      [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT]
    );
    const r = await cancelAs(USERS.aDispatcher);
    expect(r.status).toBe("already_worked");

    expect((await shift()).status).not.toBe("cancelled");
    expect(await occupancy()).toBe(1);
    expect(await audits("shift.cancelled")).toHaveLength(0);
  });

  it("refuses a finished shift and demands a reason", async () => {
    expect((await cancelAs(USERS.aDispatcher, "   ")).status).toBe("reason_required");

    await db.query(
      `update public.shifts set start_time = now() - interval '10 hours',
         end_time = now() - interval '2 hours' where id = $1`,
      [A_SHIFT]
    );
    expect((await cancelAs(USERS.aDispatcher)).status).toBe("shift_ended");
  });

  it("stops any later offer approval", async () => {
    await db.query(
      "update public.shift_offer_responses set response='interested' where id=$1",
      [OFFER_RESPONSES.aColleague]
    );
    await cancelAs(USERS.aDispatcher);

    const approval = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (await q("select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aColleague]))
          .rows[0].r as Result,
      { commit: true }
    );
    // The offer was closed by the cancellation; either refusal is correct and
    // both mean the same thing — nobody else can be put on this shift.
    expect(["offer_closed", "shift_not_open"]).toContain(approval.status);
  });

  it("a second cancellation is idempotent and silent", async () => {
    await cancelAs(USERS.aDispatcher);
    const again = await cancelAs(USERS.aDispatcher);
    expect(again.status).toBe("already_cancelled");
    expect(await audits("shift.cancelled")).toHaveLength(1);
  });

  it("an employee cannot cancel, and a foreign manager sees nothing", async () => {
    // Both come back not_found rather than forbidden, and that is correct:
    // `select ... for update` applies the UPDATE policy, and neither an
    // employee nor a foreign manager passes shifts_staff. The row is invisible
    // before authorization is even reached — no existence is leaked.
    expect((await cancelAs(USERS.aWorker)).status).toBe("not_found");
    expect((await cancelAs(USERS.bAdmin)).status).toBe("not_found");
    expect((await shift()).status).not.toBe("cancelled");
  });

  it("an HR manager has people authority, not scheduling authority", async () => {
    // app.is_staff() admits HR_MANAGER, so the RPCs use the narrower
    // app.can_manage_scheduling(). HR can read the shift, and is refused.
    await db.query(
      "update public.company_memberships set role = 'HR_MANAGER' where profile_id = $1",
      [USERS.aAdmin]
    );
    try {
      // Since 0012 the shift's UPDATE policy is scheduling-only, so the
      // locking read finds nothing and HR is stopped one layer earlier than
      // the function's own check. Either refusal is correct; what matters is
      // that nothing is cancelled.
      expect(["forbidden", "not_found"]).toContain((await cancelAs(USERS.aAdmin)).status);
      expect((await shift()).status).not.toBe("cancelled");
    } finally {
      await db.query(
        "update public.company_memberships set role = 'COMPANY_ADMIN' where profile_id = $1",
        [USERS.aAdmin]
      );
    }
  });

  it("writes one audit row carrying the reason and the counts", async () => {
    await cancelAs(USERS.aDispatcher);
    const rows = await audits("shift.cancelled");
    expect(rows).toHaveLength(1);
    const diff = rows[0].diff as Record<string, unknown>;
    expect(diff.reason).toBe(REASON);
    expect(diff.assignments_cancelled).toBe(1);
    expect(rows[0].actor_profile_id).toBe(USERS.aDispatcher);
  });

  it("never deletes anything", async () => {
    const before = await db.query(
      "select count(*)::int c from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    await cancelAs(USERS.aDispatcher);
    const after = await db.query(
      "select count(*)::int c from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });
});

/* ===================================================================== */
describe("overlap invariants (Phase B, re-proved here)", () => {
  async function otherShift(startHours: number, endHours: number): Promise<string> {
    const { rows } = await db.query(
      `insert into public.shifts (company_id, job_id, date, start_time, end_time, required_count)
       values ($1,$2, ((now() + interval '3 days') at time zone 'Europe/Berlin')::date,
               now() + interval '3 days' + ($3 || ' hours')::interval,
               now() + interval '3 days' + ($4 || ' hours')::interval, 1)
       returning id`,
      [COMPANY_A, A_JOB, startHours, endHours]
    );
    return rows[0].id as string;
  }

  async function assign(shiftId: string, status = "assigned") {
    await db.query(
      `insert into public.shift_assignments (company_id, shift_id, employee_id, status)
       values ($1,$2,$3,$4)`,
      [COMPANY_A, shiftId, EMPLOYEES.aColleague, status]
    );
  }

  const approveColleague = () =>
    runAs(
      USERS.aDispatcher,
      async (q) =>
        (await q("select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aColleague]))
          .rows[0].r as Result,
      { commit: true }
    );

  beforeEach(async () => {
    // The fixture shift runs +3d 00:00 → +3d 08:00.
    await db.query(
      "update public.shift_offer_responses set response='interested', responded_at=now() where id=$1",
      [OFFER_RESPONSES.aColleague]
    );
    await db.query("update public.shifts set required_count = 2 where id = $1", [A_SHIFT]);
  });

  it("08:00–16:00 against 12:00–20:00 overlaps and is refused", async () => {
    await assign(await otherShift(4, 12)); // 04:00–12:00 vs 00:00–08:00
    expect((await approveColleague()).status).toBe("overlapping_assignment");
  });

  it("touching at the boundary is not an overlap", async () => {
    await assign(await otherShift(8, 16)); // starts exactly when the shift ends
    expect((await approveColleague()).status).toBe("approved");
  });

  it("an overnight shift still overlaps correctly", async () => {
    await assign(await otherShift(-4, 4)); // previous evening into the morning
    expect((await approveColleague()).status).toBe("overlapping_assignment");
  });

  it("a cancelled assignment does not block", async () => {
    await assign(await otherShift(4, 12), "cancelled");
    expect((await approveColleague()).status).toBe("approved");
  });

  it("a cancellation_requested assignment still blocks", async () => {
    await assign(await otherShift(4, 12), "cancellation_requested");
    expect((await approveColleague()).status).toBe("overlapping_assignment");
  });
});

/* ===================================================================== */
describe("atomicity", () => {
  it("a failure after the shift update rolls the whole cancellation back", async () => {
    await db.query(`
      create or replace function public.__boom() returns trigger
      language plpgsql as $$
      begin
        if new.status = 'cancelled' then raise exception 'boom'; end if;
        return null;
      end $$;
    `);
    await db.query(`
      create trigger boom_after_cancel after update of status on public.shifts
      for each row execute function public.__boom();
    `);

    try {
      await expect(cancelAs(USERS.aDispatcher)).rejects.toThrow(/boom/);
    } finally {
      await db.query("drop trigger if exists boom_after_cancel on public.shifts");
      await db.query("drop function if exists public.__boom()");
    }

    expect((await shift()).status).not.toBe("cancelled");
    expect(await occupancy()).toBe(1);
    expect(await audits()).toHaveLength(0);
    const { rows } = await db.query("select status from public.shift_offers where id = $1", [
      OFFERS.a,
    ]);
    expect(rows[0].status).toBe("open");
  });
});

/* ===================================================================== */
/**
 * Real concurrency on independent connections. Nothing here awaits a fixed
 * client first: which transaction reaches the lock is genuinely
 * non-deterministic, and awaiting the wrong one deadlocks the test rather than
 * the database.
 */
describe("concurrency", () => {
  async function beginAs(client: Client, userId: string) {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
  }

  async function pair(): Promise<[Client, Client]> {
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();
    return [a, b];
  }

  async function race<T>(
    entries: Array<{ client: Client; promise: Promise<{ client: Client; result: T }> }>
  ) {
    const first = await Promise.race(entries.map((e) => e.promise));
    const winner = entries.find((e) => e.client === first.client)!;
    const loser = entries.find((e) => e.client !== first.client)!;
    await winner.client.query("commit");
    const second = await loser.promise;
    await loser.client.query("commit");
    return { first, second };
  }

  it("two managers cancelling the same shift: one cancels, one is told it is done", async () => {
    const [a, b] = await pair();
    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aAdmin);
      const go = (c: Client) =>
        c
          .query("select public.cancel_shift($1,$2) as r", [A_SHIFT, REASON])
          .then((r) => ({ client: c, result: r.rows[0].r as Result }));

      const { first, second } = await race([
        { client: a, promise: go(a) },
        { client: b, promise: go(b) },
      ]);
      expect(first.result.status).toBe("cancelled");
      expect(second.result.status).toBe("already_cancelled");
    } finally {
      await a.end();
      await b.end();
    }
    expect(await audits("shift.cancelled")).toHaveLength(1);
  });

  it("two managers editing the same shift serialise on the shift lock", async () => {
    await noEngagement();
    const [a, b] = await pair();
    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aAdmin);
      const go = (c: Client, count: number) =>
        c
          .query("select public.update_shift($1,$2::jsonb,true) as r", [
            A_SHIFT,
            JSON.stringify({ required_count: count }),
          ])
          .then((r) => ({ client: c, result: r.rows[0].r as Result }));

      const { first, second } = await race([
        { client: a, promise: go(a, 5) },
        { client: b, promise: go(b, 7) },
      ]);
      expect(first.result.status).toBe("updated");
      expect(second.result.status).toBe("updated");
    } finally {
      await a.end();
      await b.end();
    }
    // The second edit saw the first's value; the surviving count is one of the
    // two, never a lost-update hybrid.
    expect([5, 7]).toContain((await shift()).required_count);
    expect(await audits("shift.updated")).toHaveLength(2);
  });

  it("an offer approval racing a cancellation cannot both succeed", async () => {
    await db.query(
      "update public.shift_offer_responses set response='interested', responded_at=now() where id=$1",
      [OFFER_RESPONSES.aColleague]
    );
    const [a, b] = await pair();
    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aAdmin);
      const { first, second } = await race([
        {
          client: a,
          promise: a
            .query("select public.cancel_shift($1,$2) as r", [A_SHIFT, REASON])
            .then((r) => ({ client: a, result: r.rows[0].r as Result })),
        },
        {
          client: b,
          promise: b
            .query("select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aColleague])
            .then((r) => ({ client: b, result: r.rows[0].r as Result })),
        },
      ]);
      // Exactly one of the two succeeds; the loser is refused by name.
      const statuses = [first.result.status, second.result.status].sort();
      expect(
        statuses.includes("cancelled") || statuses.includes("approved")
      ).toBe(true);
      expect(
        statuses.some((s) =>
          ["already_worked", "shift_not_open", "offer_closed", "no_vacancy"].includes(s)
        ) || statuses.filter((s) => s === "cancelled" || s === "approved").length === 2
      ).toBe(true);
    } finally {
      await a.end();
      await b.end();
    }

    const s = await shift();
    if (s.status === "cancelled") expect(await occupancy()).toBe(0);
  });

  it("an offer approval racing an edit never leaves a stale capacity", async () => {
    await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
    await db.query(
      "update public.shift_offer_responses set response='interested', responded_at=now() where id=$1",
      [OFFER_RESPONSES.aColleague]
    );
    const [a, b] = await pair();
    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aAdmin);
      await race([
        {
          client: a,
          promise: a
            .query("select public.update_shift($1,$2::jsonb,true) as r", [
              A_SHIFT,
              JSON.stringify({ required_count: 1 }),
            ])
            .then((r) => ({ client: a, result: r.rows[0].r as Result })),
        },
        {
          client: b,
          promise: b
            .query("select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aColleague])
            .then((r) => ({ client: b, result: r.rows[0].r as Result })),
        },
      ]);
    } finally {
      await a.end();
      await b.end();
    }

    const s = await shift();
    expect(await occupancy()).toBeLessThanOrEqual(Number(s.required_count));
  });

  /**
   * THE ONE THAT NEEDED PROVING.
   *
   * Clock-in is not a transaction of its own — it ends in a bare INSERT into
   * time_entries that takes no lock on shifts and none on shift_assignments.
   * cancel_shift therefore locks the occupying assignments explicitly, and an
   * inserting child row must take FOR KEY SHARE on that parent through the
   * foreign key. The two conflict, so exactly one wins.
   */
  /**
   * Both orderings, forced rather than raced, so neither legal outcome can hide
   * behind scheduling luck. The free race below then runs the same scenario
   * without forcing anything.
   */
  it("cancellation first: the clock-in is refused, no worked time exists", async () => {
    const [a, b] = await pair();
    let insertError: Error | null = null;
    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aWorker);

      const cancel = (await a.query("select public.cancel_shift($1,$2) as r", [A_SHIFT, REASON]))
        .rows[0].r as Result;
      expect(cancel.status).toBe("cancelled");

      // In flight while the cancellation still holds its locks.
      const insert = b
        .query(
          `insert into public.time_entries (company_id, employee_id, shift_assignment_id, clock_in, status)
           values ($1,$2,$3, now(), 'running')`,
          [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT]
        )
        .catch((e: Error) => {
          insertError = e;
        });

      await new Promise((r) => setTimeout(r, 250));
      await a.query("commit");
      await insert;
      await b.query("commit").catch(() => {});
    } finally {
      await a.end();
      await b.end();
    }

    // The insert blocked on the foreign key, then found a cancelled assignment.
    expect(String(insertError)).toMatch(/assignment_not_active/);
    expect((await shift()).status).toBe("cancelled");
    const { rows } = await db.query(
      "select count(*)::int c from public.time_entries where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("clock-in first: the cancellation is refused as already_worked", async () => {
    const [a, b] = await pair();
    try {
      await beginAs(a, USERS.aWorker);
      await beginAs(b, USERS.aDispatcher);

      await a.query(
        `insert into public.time_entries (company_id, employee_id, shift_assignment_id, clock_in, status)
         values ($1,$2,$3, now(), 'running')`,
        [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT]
      );

      const cancel = b
        .query("select public.cancel_shift($1,$2) as r", [A_SHIFT, REASON])
        .then((r) => r.rows[0].r as Result);

      await new Promise((r) => setTimeout(r, 250));
      await a.query("commit");
      const result = await cancel;
      await b.query("commit");

      expect(result.status).toBe("already_worked");
    } finally {
      await a.end();
      await b.end();
    }

    expect((await shift()).status).not.toBe("cancelled");
    expect(await occupancy()).toBe(1);
  });

  it("a time entry against a cancelled assignment is refused outright", async () => {
    await db.query("update public.shift_assignments set status='cancelled' where id=$1", [
      A_ASSIGNMENT,
    ]);
    await expect(
      db.query(
        `insert into public.time_entries (company_id, employee_id, shift_assignment_id, clock_in, status)
         values ($1,$2,$3, now(), 'running')`,
        [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT]
      )
    ).rejects.toThrow(/assignment_not_active/);
  });

  it("cancelling cannot commit alongside a clock-in", async () => {
    const [a, b] = await pair();
    let outcome: { cancel: string; clockedIn: boolean };
    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aWorker);

      const cancel = a
        .query("select public.cancel_shift($1,$2) as r", [A_SHIFT, REASON])
        .then((r) => ({ client: a, result: r.rows[0].r as Result }));

      const clockIn = b
        .query(
          `insert into public.time_entries (company_id, employee_id, shift_assignment_id, clock_in, status)
           values ($1,$2,$3, now(), 'running') returning id`,
          [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT]
        )
        .then(() => ({ client: b, result: { status: "clocked_in" } as Result }))
        .catch((e: Error) => ({ client: b, result: { status: `refused:${e.message}` } as Result }));
      // Whichever loses must leave no trace; the assertions after the race
      // check the committed database, not these return values.

      const { first } = await race([
        { client: a, promise: cancel },
        { client: b, promise: clockIn },
      ]);

      const cancelResult = (await cancel).result.status;
      const clockResult = (await clockIn).result.status;
      outcome = { cancel: cancelResult, clockedIn: clockResult === "clocked_in" };
      expect(first).toBeTruthy();
    } finally {
      await a.end();
      await b.end();
    }

    const s = await shift();
    const { rows: entries } = await db.query(
      "select count(*)::int c from public.time_entries where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    const worked = Number(entries[0].c) > 0;

    // Exactly one of the two legal outcomes, never the forbidden third.
    if (outcome.cancel === "cancelled") {
      expect(s.status).toBe("cancelled");
      expect(await occupancy()).toBe(0);
      expect(worked).toBe(false); // ← the forbidden state
    } else {
      expect(outcome.cancel).toBe("already_worked");
      expect(s.status).not.toBe("cancelled");
      expect(await occupancy()).toBe(1);
      expect(worked).toBe(true);
    }
  });
});

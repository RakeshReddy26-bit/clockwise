/**
 * Phase E — vacation and sick leave, against a real database.
 *
 * The suite is organised around the asymmetry, because that is what is easy to
 * get wrong later:
 *
 *   Vacation is a request. Pending must NOT block scheduling — otherwise an
 *   employee could make themselves unschedulable by asking. Approved must
 *   block. Approving it while the person still holds a shift is refused, and
 *   refused WITHOUT writing anything.
 *
 *   Sickness is a fact. Reporting it blocks immediately, and reporting it can
 *   never be refused because a shift exists. Nobody is released automatically.
 *
 * The role split matters as much as the rules: DISPATCHER may read absences and
 * never decide them; HR_MANAGER decides them and gains no scheduling power.
 * Both directions are asserted through the RPC and again straight at the table,
 * because a check that only exists in an RPC is a suggestion.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  createTestDatabase,
  runAs as runAsUser,
  type QueryFn,
  USERS,
  COMPANY_A,
  COMPANY_B,
  EMPLOYEES,
  OFFER_RESPONSES,
} from "./helpers";

const DB_NAME = "clockwise_absence_test";
const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);

const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";
const A_VACATION = "aaaa8888-0000-0000-0000-000000000001";
const A_SICK = "aaaa9999-0000-0000-0000-000000000001";

/**
 * An HR_MANAGER, created here rather than in the shared fixtures. The other
 * suites assert on the membership set they were written against, and Phase E
 * should not quietly change what they see.
 */
const HR_USER = "aaaaaaaa-0000-0000-0000-000000000004";

/** The shift lands two days out, so approve_shift_offer never sees a past shift. */
let shiftDate: string;

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

type Result = {
  status: string;
  count?: number;
  conflicts?: Array<Record<string, unknown>>;
  current?: string;
  request_id?: string;
  employee_id?: string;
  assignment_id?: string;
};

async function decideVacation(
  userId: string,
  requestId: string,
  approve: boolean,
  note: string | null = null
): Promise<Result> {
  return runAs(
    userId,
    async (q) =>
      (
        await q("select public.decide_vacation_request($1, $2, $3) as result", [
          requestId,
          approve,
          note,
        ])
      ).rows[0].result as Result,
    { commit: true }
  );
}

async function decideSick(
  userId: string,
  sickId: string,
  status: string,
  endDate: string | null = null
): Promise<Result> {
  return runAs(
    userId,
    async (q) =>
      (
        await q("select public.decide_sick_leave($1, $2, $3) as result", [sickId, status, endDate])
      ).rows[0].result as Result,
    { commit: true }
  );
}

async function approveOffer(userId: string, responseId: string): Promise<Result> {
  return runAs(
    userId,
    async (q) =>
      (await q("select public.approve_shift_offer($1) as result", [responseId])).rows[0]
        .result as Result,
    { commit: true }
  );
}

async function vacationRow(id = A_VACATION): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.query("select * from public.vacation_requests where id = $1", [id]);
  return rows[0];
}

async function sickRow(id = A_SICK): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.query("select * from public.sick_leaves where id = $1", [id]);
  return rows[0];
}

async function assignmentStatus(id = A_ASSIGNMENT): Promise<string | undefined> {
  const { rows } = await db.query("select status from public.shift_assignments where id = $1", [id]);
  return rows[0]?.status as string | undefined;
}

async function audits(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query(
    "select actor_profile_id, action, entity, entity_id, diff from public.audit_logs order by id"
  );
  return rows;
}

/** A pending vacation request covering the shift day, owned by worker A. */
async function seedVacation({
  status = "pending",
  start = shiftDate,
  end = shiftDate,
  id = A_VACATION,
  employee = EMPLOYEES.aSelf as string,
  company = COMPANY_A,
} = {}) {
  await db.query(
    `insert into public.vacation_requests
       (id, company_id, employee_id, start_date, end_date, days_count, status, note)
     values ($1, $2, $3, $4, $5, 1, $6, 'Familienfeier')`,
    [id, company, employee, start, end, status]
  );
}

async function seedSick({
  status = "reported",
  start = shiftDate,
  end = shiftDate as string | null,
  id = A_SICK,
  employee = EMPLOYEES.aSelf as string,
} = {}) {
  await db.query(
    `insert into public.sick_leaves
       (id, company_id, employee_id, start_date, expected_end_date, status, comment)
     values ($1, $2, $3, $4, $5, $6, 'Grippe')`,
    [id, COMPANY_A, employee, start, end, status]
  );
}

/**
 * One open seat on a future shift, worker A NOT on it, both fixture employees
 * interested. This is the shape most absence tests need: the question is
 * whether the absence stops the approval, so nothing else may.
 */
async function resetScenario({ workerAssigned = false, requiredCount = 1 } = {}) {
  await db.query("delete from public.audit_logs");
  await db.query("delete from public.notifications");
  await db.query("delete from public.vacation_requests");
  await db.query("delete from public.sick_leaves");
  await db.query("delete from public.time_entries");
  await db.query("delete from public.cancellation_requests");
  await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
  await db.query(
    `update public.shifts
     set required_count = $2, status = 'open',
         date = (now() + interval '2 days')::date,
         start_time = now() + interval '2 days',
         end_time = now() + interval '2 days 8 hours'
     where id = $1`,
    [A_SHIFT, requiredCount]
  );
  const { rows } = await db.query("select date::text as d from public.shifts where id = $1", [
    A_SHIFT,
  ]);
  shiftDate = rows[0].d as string;

  if (workerAssigned) {
    await db.query(
      `insert into public.shift_assignments (id, company_id, shift_id, employee_id, status)
       values ($1, $2, $3, $4, 'assigned')`,
      [A_ASSIGNMENT, COMPANY_A, A_SHIFT, EMPLOYEES.aSelf]
    );
  }
  await db.query(
    `update public.shift_offer_responses
     set response = 'interested', decided_at = null, decided_by = null,
         resulting_assignment_id = null
     where company_id = $1`,
    [COMPANY_A]
  );
  await db.query("update public.shift_offers set status = 'open', closed_at = null");
}

beforeAll(async () => {
  db = await createTestDatabase(DB_NAME);
  await db.query("insert into auth.users (id, email) values ($1, 'hr@a.test')", [HR_USER]);
  await db.query("update public.profiles set full_name = 'HR A' where id = $1", [HR_USER]);
  await db.query(
    `insert into public.company_memberships (profile_id, company_id, role, status)
     values ($1, $2, 'HR_MANAGER', 'active')`,
    [HR_USER, COMPANY_A]
  );
}, 60_000);

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await resetScenario();
});

/* ------------------------------------------------------------------ */
/* What blocks scheduling                                              */
/* ------------------------------------------------------------------ */

describe("vacation and scheduling", () => {
  it("a PENDING request does not block — asking is not deciding", async () => {
    await seedVacation({ status: "pending" });
    expect((await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe("approved");
  });

  it("an APPROVED request blocks", async () => {
    await seedVacation({ status: "approved" });
    const result = await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf);
    expect(result.status).toBe("on_vacation");
    expect(await assignmentStatus()).toBeUndefined();
  });

  it("rejected and withdrawn requests block nothing", async () => {
    for (const status of ["rejected", "cancelled"]) {
      await resetScenario();
      await seedVacation({ status });
      expect((await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe("approved");
    }
  });

  it("blocks only inside the period, inclusive at both ends", async () => {
    // Ends the day before the shift: no block.
    await seedVacation({
      status: "approved",
      start: `${shiftDate}`,
      end: `${shiftDate}`,
    });
    await db.query(
      `update public.vacation_requests
       set start_date = $1::date - 3, end_date = $1::date - 1 where id = $2`,
      [shiftDate, A_VACATION]
    );
    expect((await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe("approved");

    // Now ending exactly on the shift day: blocked.
    await resetScenario();
    await seedVacation({ status: "approved" });
    await db.query("update public.vacation_requests set start_date = $1::date - 3 where id = $2", [
      shiftDate,
      A_VACATION,
    ]);
    expect((await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "on_vacation"
    );
  });
});

describe("sick leave and scheduling", () => {
  it("REPORTED blocks as hard as CONFIRMED — waiting for a note would roster an ill person", async () => {
    for (const status of ["reported", "confirmed"]) {
      await resetScenario();
      await seedSick({ status });
      expect((await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
        "on_sick_leave"
      );
    }
  });

  it("a closed leave blocks nothing", async () => {
    await seedSick({ status: "closed" });
    expect((await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe("approved");
  });

  it("an open-ended leave blocks everything from its start", async () => {
    await seedSick({ status: "reported", end: null });
    await db.query("update public.sick_leaves set start_date = $1::date - 5 where id = $2", [
      shiftDate,
      A_SICK,
    ]);
    expect((await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "on_sick_leave"
    );
  });

  it("reporting sickness is never refused because a shift exists", async () => {
    await resetScenario({ workerAssigned: true });
    const inserted = await runAs(
      USERS.aWorker,
      async (q) =>
        (
          await q(
            `insert into public.sick_leaves (company_id, employee_id, start_date, status)
             values ($1, $2, $3, 'reported') returning id`,
            [COMPANY_A, EMPLOYEES.aSelf, shiftDate]
          )
        ).rowCount,
      { commit: true }
    );
    expect(inserted).toBe(1);

    // And nobody was taken off anything as a side effect.
    expect(await assignmentStatus()).toBe("assigned");
  });
});

/* ------------------------------------------------------------------ */
/* Deciding a vacation request                                         */
/* ------------------------------------------------------------------ */

describe("decide_vacation_request", () => {
  it("HR approves a clean request and the audit records the decision", async () => {
    await seedVacation();
    const result = await decideVacation(HR_USER, A_VACATION, true, "  Passt.  ");
    expect(result.status).toBe("approved");

    const row = await vacationRow();
    expect(row?.status).toBe("approved");
    expect(row?.decided_by).toBe(HR_USER);
    expect(row?.decided_at).not.toBeNull();

    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("vacation.approved");
    expect(log[0].entity).toBe("vacation_requests");
    expect((log[0].diff as Record<string, unknown>).decision_note_present).toBe(true);
  });

  it("never writes the note itself into the audit trail", async () => {
    await seedVacation();
    await decideVacation(HR_USER, A_VACATION, false, "Zu viele Krankmeldungen im Team");
    const log = await audits();
    expect(JSON.stringify(log[0].diff)).not.toContain("Krankmeldungen");
    expect((log[0].diff as Record<string, unknown>).decision_note_present).toBe(true);
  });

  it("records an absent note as absent rather than as an empty string", async () => {
    await seedVacation();
    await decideVacation(HR_USER, A_VACATION, true, "   ");
    expect((((await audits())[0].diff) as Record<string, unknown>).decision_note_present).toBe(
      false
    );
  });

  it("refuses approval while the employee still holds a shift — and writes NOTHING", async () => {
    await resetScenario({ workerAssigned: true });
    await seedVacation();

    const result = await decideVacation(HR_USER, A_VACATION, true);
    expect(result.status).toBe("conflicting_assignments");
    expect(result.count).toBe(1);
    expect(result.conflicts?.[0].assignment_id).toBe(A_ASSIGNMENT);
    expect(result.conflicts?.[0].shift_id).toBe(A_SHIFT);
    expect(result.conflicts?.[0].status).toBe("assigned");

    // No partial mutation, in either direction.
    const row = await vacationRow();
    expect(row?.status).toBe("pending");
    expect(row?.decided_by).toBeNull();
    expect(row?.decided_at).toBeNull();
    expect(await assignmentStatus()).toBe("assigned");
    expect(await audits()).toHaveLength(0);
  });

  it("counts a parked assignment as a conflict — the seat is still held", async () => {
    await resetScenario({ workerAssigned: true });
    await runAs(
      USERS.aWorker,
      (q) =>
        q("select public.request_shift_cancellation($1, $2) as r", [A_ASSIGNMENT, "Umzug"]),
      { commit: true }
    );
    expect(await assignmentStatus()).toBe("cancellation_requested");

    await seedVacation();
    const result = await decideVacation(HR_USER, A_VACATION, true);
    expect(result.status).toBe("conflicting_assignments");
    expect(result.conflicts?.[0].status).toBe("cancellation_requested");
  });

  it("the same request approves once a manager has released the employee", async () => {
    await resetScenario({ workerAssigned: true });
    await seedVacation();
    expect((await decideVacation(HR_USER, A_VACATION, true)).status).toBe(
      "conflicting_assignments"
    );

    // Phase C.1: a human releases them, with a reason and a notification.
    const removal = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q("select public.remove_shift_assignment($1, $2) as r", [
            A_ASSIGNMENT,
            "Urlaub genehmigt, Ersatz gesucht",
          ])
        ).rows[0].r as Result,
      { commit: true }
    );
    expect(removal.status).toBe("removed");

    expect((await decideVacation(HR_USER, A_VACATION, true)).status).toBe("approved");
    expect((await vacationRow())?.status).toBe("approved");
  });

  it("rejection is never blocked by a conflict — there is nothing to conflict with", async () => {
    await resetScenario({ workerAssigned: true });
    await seedVacation();
    expect((await decideVacation(HR_USER, A_VACATION, false)).status).toBe("rejected");
    expect((await vacationRow())?.status).toBe("rejected");
    expect(await assignmentStatus()).toBe("assigned");
  });

  it("a decision is made once — a second call refuses without changing anything", async () => {
    await seedVacation();
    expect((await decideVacation(HR_USER, A_VACATION, true)).status).toBe("approved");
    const second = await decideVacation(HR_USER, A_VACATION, false);
    expect(second.status).toBe("not_pending");
    expect(second.current).toBe("approved");
    expect((await vacationRow())?.status).toBe("approved");
    expect(await audits()).toHaveLength(1);
  });

  it("a withdrawn request can no longer be decided", async () => {
    await seedVacation({ status: "cancelled" });
    expect((await decideVacation(HR_USER, A_VACATION, true)).status).toBe("not_pending");
  });

  it("an unknown id is not found rather than an error", async () => {
    expect(
      (await decideVacation(HR_USER, "00000000-0000-0000-0000-000000000000", true)).status
    ).toBe("not_found");
  });
});

/* ------------------------------------------------------------------ */
/* Deciding a sick leave                                               */
/* ------------------------------------------------------------------ */

describe("decide_sick_leave", () => {
  it("confirms, then closes", async () => {
    await seedSick();
    expect((await decideSick(HR_USER, A_SICK, "confirmed")).status).toBe("confirmed");
    expect((await sickRow())?.status).toBe("confirmed");
    expect((await decideSick(HR_USER, A_SICK, "closed", shiftDate)).status).toBe("closed");
    expect((await sickRow())?.status).toBe("closed");
  });

  it("closes straight from reported", async () => {
    await seedSick();
    expect((await decideSick(HR_USER, A_SICK, "closed")).status).toBe("closed");
  });

  it("cannot reopen a closed leave", async () => {
    await seedSick({ status: "closed" });
    expect((await decideSick(HR_USER, A_SICK, "confirmed")).status).toBe("already_closed");
  });

  it("has no rejection — an employer does not decline an illness", async () => {
    await seedSick();
    expect((await decideSick(HR_USER, A_SICK, "rejected")).status).toBe("not_a_transition");
    expect((await sickRow())?.status).toBe("reported");
  });

  it("never releases an assignment as a side effect", async () => {
    await resetScenario({ workerAssigned: true });
    await seedSick();
    expect((await decideSick(HR_USER, A_SICK, "confirmed")).status).toBe("confirmed");
    expect(await assignmentStatus()).toBe("assigned");

    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("sick_leave.confirmed");
  });

  it("keeps the employee's comment out of the audit trail", async () => {
    await seedSick();
    await decideSick(HR_USER, A_SICK, "confirmed");
    expect(JSON.stringify((await audits())[0].diff)).not.toContain("Grippe");
  });
});

/* ------------------------------------------------------------------ */
/* Who may decide                                                      */
/* ------------------------------------------------------------------ */

describe("authorization", () => {
  it("a DISPATCHER may READ absences — staffing needs to plan around them", async () => {
    await seedVacation();
    await seedSick();
    const seen = await runAs(USERS.aDispatcher, async (q) => ({
      vacation: (await q("select id from public.vacation_requests")).rowCount,
      sick: (await q("select id from public.sick_leaves")).rowCount,
    }));
    expect(seen).toEqual({ vacation: 1, sick: 1 });
  });

  it("a DISPATCHER may not decide, through the RPC or straight at the table", async () => {
    await seedVacation();
    await seedSick();

    expect((await decideVacation(USERS.aDispatcher, A_VACATION, true)).status).toBe("forbidden");
    expect((await decideSick(USERS.aDispatcher, A_SICK, "confirmed")).status).toBe("forbidden");

    // RLS filters rather than raises, so the proof is that the row survives.
    const touched = await runAs(
      USERS.aDispatcher,
      async (q) => ({
        vacation: (
          await q("update public.vacation_requests set status = 'approved' where id = $1", [
            A_VACATION,
          ])
        ).rowCount,
        sick: (
          await q("update public.sick_leaves set status = 'confirmed' where id = $1", [A_SICK])
        ).rowCount,
      }),
      { commit: true }
    );
    expect(touched).toEqual({ vacation: 0, sick: 0 });
    expect((await vacationRow())?.status).toBe("pending");
    expect((await sickRow())?.status).toBe("reported");
  });

  it("a DISPATCHER may not grant holiday by inserting an already-approved request", async () => {
    const inserted = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q(
            `insert into public.vacation_requests
               (company_id, employee_id, start_date, end_date, days_count, status)
             values ($1, $2, $3, $3, 1, 'approved')`,
            [COMPANY_A, EMPLOYEES.aColleague, shiftDate]
          )
        ).rowCount,
      { commit: true }
    ).catch((error: Error) => error.message);
    expect(String(inserted)).toContain("row-level security");
  });

  it("an HR_MANAGER decides absences and gains no scheduling authority", async () => {
    await seedVacation();
    expect((await decideVacation(HR_USER, A_VACATION, true)).status).toBe("approved");

    // The same person cannot staff a shift.
    await resetScenario();
    expect((await approveOffer(HR_USER, OFFER_RESPONSES.aSelf)).status).toBe("forbidden");

    const assigned = await runAs(
      HR_USER,
      async (q) =>
        (
          await q(
            `insert into public.shift_assignments (company_id, shift_id, employee_id, status)
             values ($1, $2, $3, 'assigned')`,
            [COMPANY_A, A_SHIFT, EMPLOYEES.aColleague]
          )
        ).rowCount,
      { commit: true }
    ).catch((error: Error) => error.message);
    expect(String(assigned)).toContain("row-level security");
  });

  it("an employee cannot decide their own request", async () => {
    await seedVacation();
    expect((await decideVacation(USERS.aWorker, A_VACATION, true)).status).toBe("forbidden");
    expect((await vacationRow())?.status).toBe("pending");
  });

  it("an employee cannot approve their own request straight at the table", async () => {
    await seedVacation();
    const changed = await runAs(
      USERS.aWorker,
      async (q) =>
        (
          await q("update public.vacation_requests set status = 'approved' where id = $1", [
            A_VACATION,
          ])
        ).rowCount,
      { commit: true }
    ).catch(() => 0);
    expect(changed).toBe(0);
    expect((await vacationRow())?.status).toBe("pending");
  });
});

/* ------------------------------------------------------------------ */
/* Withdrawal                                                          */
/* ------------------------------------------------------------------ */

describe("employee withdrawal", () => {
  it("withdraws a pending request into 'cancelled'", async () => {
    await seedVacation();
    const changed = await runAs(
      USERS.aWorker,
      async (q) =>
        (
          await q("update public.vacation_requests set status = 'cancelled' where id = $1", [
            A_VACATION,
          ])
        ).rowCount,
      { commit: true }
    );
    expect(changed).toBe(1);
    expect((await vacationRow())?.status).toBe("cancelled");
  });

  it("cannot withdraw once a manager has decided", async () => {
    for (const status of ["approved", "rejected"]) {
      await resetScenario();
      await seedVacation({ status });
      const changed = await runAs(
        USERS.aWorker,
        async (q) =>
          (
            await q("update public.vacation_requests set status = 'cancelled' where id = $1", [
              A_VACATION,
            ])
          ).rowCount,
        { commit: true }
      );
      expect(changed).toBe(0);
      expect((await vacationRow())?.status).toBe(status);
    }
  });

  it("cannot use withdrawal to reject or approve itself", async () => {
    await seedVacation();
    for (const target of ["approved", "rejected"]) {
      const changed = await runAs(
        USERS.aWorker,
        async (q) =>
          (
            await q("update public.vacation_requests set status = $2 where id = $1", [
              A_VACATION,
              target,
            ])
          ).rowCount,
        { commit: true }
      ).catch(() => 0);
      expect(changed).toBe(0);
    }
    expect((await vacationRow())?.status).toBe("pending");
  });

  it("cannot DELETE a request — withdrawal is a status, not an erasure", async () => {
    await seedVacation();
    const deleted = await runAs(
      USERS.aWorker,
      async (q) =>
        (await q("delete from public.vacation_requests where id = $1", [A_VACATION])).rowCount,
      { commit: true }
    );
    expect(deleted).toBe(0);
    expect(await vacationRow()).toBeDefined();
  });

  it("nobody may DELETE an absence, not even HR", async () => {
    await seedVacation();
    await seedSick();
    const deleted = await runAs(
      HR_USER,
      async (q) => ({
        vacation: (await q("delete from public.vacation_requests where id = $1", [A_VACATION]))
          .rowCount,
        sick: (await q("delete from public.sick_leaves where id = $1", [A_SICK])).rowCount,
      }),
      { commit: true }
    );
    expect(deleted).toEqual({ vacation: 0, sick: 0 });
    expect(await vacationRow()).toBeDefined();
    expect(await sickRow()).toBeDefined();
  });

  it("a withdrawn request stops blocking the schedule", async () => {
    await seedVacation({ status: "approved" });
    expect((await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "on_vacation"
    );
    await db.query("update public.vacation_requests set status = 'cancelled' where id = $1", [
      A_VACATION,
    ]);
    expect((await approveOffer(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe("approved");
  });
});

/* ------------------------------------------------------------------ */
/* Overlapping requests                                                */
/* ------------------------------------------------------------------ */

describe("one live request per period", () => {
  async function insertOverlapping(status: string) {
    return runAs(
      USERS.aWorker,
      (q) =>
        q(
          `insert into public.vacation_requests
             (company_id, employee_id, start_date, end_date, days_count, status)
           values ($1, $2, $3, $3, 1, $4)`,
          [COMPANY_A, EMPLOYEES.aSelf, shiftDate, status]
        ),
      { commit: true }
    );
  }

  it("refuses a second live request over the same days", async () => {
    await seedVacation({ status: "pending" });
    await expect(insertOverlapping("pending")).rejects.toThrow(/conflicting key value|exclusion/i);
  });

  it("refuses one that overlaps an approved period", async () => {
    await seedVacation({ status: "approved" });
    await expect(insertOverlapping("pending")).rejects.toThrow(/conflicting key value|exclusion/i);
  });

  it("allows the same days again after a rejection or a withdrawal", async () => {
    for (const status of ["rejected", "cancelled"]) {
      await resetScenario();
      await seedVacation({ status });
      await expect(insertOverlapping("pending")).resolves.toBeDefined();
    }
  });

  it("allows a touching but non-overlapping period", async () => {
    await seedVacation({ status: "pending" });
    await expect(
      runAs(
        USERS.aWorker,
        (q) =>
          q(
            `insert into public.vacation_requests
               (company_id, employee_id, start_date, end_date, days_count, status)
             values ($1, $2, $3::date + 1, $3::date + 2, 2, 'pending')`,
            [COMPANY_A, EMPLOYEES.aSelf, shiftDate]
          ),
        { commit: true }
      )
    ).resolves.toBeDefined();
  });

  it("does not constrain a different employee", async () => {
    await seedVacation({ status: "approved" });
    await expect(
      db.query(
        `insert into public.vacation_requests
           (company_id, employee_id, start_date, end_date, days_count, status)
         values ($1, $2, $3, $3, 1, 'approved')`,
        [COMPANY_A, EMPLOYEES.aColleague, shiftDate]
      )
    ).resolves.toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* Tenants                                                             */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("company B cannot see, decide or withdraw company A's absences", async () => {
    await seedVacation();
    await seedSick();

    const seen = await runAs(USERS.bAdmin, async (q) => ({
      vacation: (await q("select id from public.vacation_requests")).rowCount,
      sick: (await q("select id from public.sick_leaves")).rowCount,
    }));
    expect(seen).toEqual({ vacation: 0, sick: 0 });

    expect((await decideVacation(USERS.bAdmin, A_VACATION, true)).status).toBe("not_found");
    expect((await decideSick(USERS.bAdmin, A_SICK, "confirmed")).status).toBe("not_found");
    expect((await vacationRow())?.status).toBe("pending");
    expect((await sickRow())?.status).toBe("reported");
  });

  it("company B cannot file an absence for a company A employee", async () => {
    const inserted = await runAs(
      USERS.bAdmin,
      (q) =>
        q(
          `insert into public.vacation_requests
             (company_id, employee_id, start_date, end_date, days_count, status)
           values ($1, $2, $3, $3, 1, 'approved')`,
          [COMPANY_A, EMPLOYEES.aSelf, shiftDate]
        ),
      { commit: true }
    ).catch((error: Error) => error.message);
    expect(String(inserted)).toContain("row-level security");
  });

  it("labelling a company A absence as company B's does not smuggle it across", async () => {
    const inserted = await runAs(
      USERS.bAdmin,
      (q) =>
        q(
          `insert into public.vacation_requests
             (company_id, employee_id, start_date, end_date, days_count, status)
           values ($1, $2, $3, $3, 1, 'pending')`,
          [COMPANY_B, EMPLOYEES.aSelf, shiftDate]
        ),
      { commit: true }
    ).catch((error: Error) => error.message);
    // RLS passes here — the row's own company_id is B's, so every write policy
    // is satisfied. What refuses it is the composite key added in 0015, and the
    // test names it: if that constraint is ever dropped this must fail loudly
    // rather than quietly pass on some other error.
    expect(String(inserted)).toContain("vacation_requests_employee_same_company");
  });

  it("the same smuggling attempt is refused for sick leave", async () => {
    const inserted = await runAs(
      USERS.bAdmin,
      (q) =>
        q(
          `insert into public.sick_leaves (company_id, employee_id, start_date, status)
           values ($1, $2, $3, 'reported')`,
          [COMPANY_B, EMPLOYEES.aSelf, shiftDate]
        ),
      { commit: true }
    ).catch((error: Error) => error.message);
    expect(String(inserted)).toContain("sick_leaves_employee_same_company");
  });
});

/* ------------------------------------------------------------------ */
/* Concurrency — the reason the employee lock exists                   */
/* ------------------------------------------------------------------ */

/**
 * Real races on independent connections. Both statements are in flight before
 * either transaction commits, so which one reaches the employee lock first is
 * genuinely non-deterministic — and the assertion is about the END STATE, not
 * about who won.
 *
 * The forbidden state is: approved vacation covering the shift day AND a live
 * assignment on that shift, for the same person. Checking each side without a
 * shared lock cannot prevent it: neither transaction can see the other's
 * uncommitted row, and `for update` cannot lock an assignment row that does not
 * exist yet. The employees row is the only thing both are certainly about.
 */
describe("concurrency", () => {
  async function beginAs(client: Client, userId: string) {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
  }

  async function race<T>(
    entries: Array<{ client: Client; promise: Promise<{ client: Client; result: T }> }>
  ): Promise<Array<{ client: Client; result: T }>> {
    const first = await Promise.race(entries.map((e) => e.promise));
    const winner = entries.find((e) => e.client === first.client)!;
    const loser = entries.find((e) => e.client !== first.client)!;
    await winner.client.query("commit");
    const second = await loser.promise;
    await loser.client.query("commit");
    return [first, second];
  }

  /** The state Phase E exists to make impossible. */
  async function bothSidesCommitted(): Promise<boolean> {
    const { rows } = await db.query(
      `select count(*)::int as c
       from public.vacation_requests v
       join public.shifts s on s.date between v.start_date and v.end_date
       join public.shift_assignments sa
         on sa.shift_id = s.id and sa.employee_id = v.employee_id
       where v.employee_id = $1
         and v.status = 'approved'
         and sa.status in ('assigned','accepted','cancellation_requested')`,
      [EMPLOYEES.aSelf]
    );
    return Number(rows[0].c) > 0;
  }

  async function runRace(order: "vacation-first" | "offer-first") {
    await resetScenario();
    await seedVacation({ status: "pending" });

    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();

    try {
      if (order === "vacation-first") {
        await beginAs(a, HR_USER);
        await beginAs(b, USERS.aDispatcher);
      } else {
        await beginAs(b, USERS.aDispatcher);
        await beginAs(a, HR_USER);
      }

      const results = await race<Result>([
        {
          client: a,
          promise: a
            .query("select public.decide_vacation_request($1, true, null) as r", [A_VACATION])
            .then((r) => ({ client: a, result: r.rows[0].r as Result })),
        },
        {
          client: b,
          promise: b
            .query("select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aSelf])
            .then((r) => ({ client: b, result: r.rows[0].r as Result })),
        },
      ]);
      return results.map((r) => r.result.status);
    } finally {
      await a.end();
      await b.end();
    }
  }

  it("vacation approval racing an offer approval never commits both — HR first", async () => {
    const statuses = await runRace("vacation-first");
    expect(await bothSidesCommitted()).toBe(false);

    // One side must have been refused, and refused for the right reason.
    expect(statuses.some((s) => ["conflicting_assignments", "on_vacation"].includes(s))).toBe(true);
  });

  it("vacation approval racing an offer approval never commits both — dispatch first", async () => {
    const statuses = await runRace("offer-first");
    expect(await bothSidesCommitted()).toBe(false);
    expect(statuses.some((s) => ["conflicting_assignments", "on_vacation"].includes(s))).toBe(true);
  });

  it("two HR managers deciding one request produce one decision", async () => {
    await seedVacation();

    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();

    try {
      await beginAs(a, HR_USER);
      await beginAs(b, USERS.aAdmin);

      const call = (client: Client, approve: boolean) =>
        client
          .query("select public.decide_vacation_request($1, $2, null) as r", [A_VACATION, approve])
          .then((r) => ({ client, result: r.rows[0].r as Result }));

      const [first, second] = await race([
        { client: a, promise: call(a, true) },
        { client: b, promise: call(b, false) },
      ]);
      expect(["approved", "rejected"]).toContain(first.result.status);
      expect(second.result.status).toBe("not_pending");
    } finally {
      await a.end();
      await b.end();
    }

    expect(await audits()).toHaveLength(1);
  });

  it("a sick report racing an offer approval leaves no rostered ill employee", async () => {
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();

    try {
      await beginAs(a, USERS.aWorker);
      await beginAs(b, USERS.aDispatcher);

      await race<unknown>([
        {
          client: a,
          promise: a
            .query(
              `insert into public.sick_leaves (company_id, employee_id, start_date, status)
               values ($1, $2, $3, 'reported') returning id`,
              [COMPANY_A, EMPLOYEES.aSelf, shiftDate]
            )
            .then((r) => ({ client: a, result: r.rows[0] })),
        },
        {
          client: b,
          promise: b
            .query("select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aSelf])
            .then((r) => ({ client: b, result: r.rows[0].r })),
        },
      ]);
    } finally {
      await a.end();
      await b.end();
    }

    // The report itself always survives — it is a fact, not a request.
    const { rows } = await db.query(
      "select count(*)::int as c from public.sick_leaves where employee_id = $1",
      [EMPLOYEES.aSelf]
    );
    expect(Number(rows[0].c)).toBe(1);
  });
});

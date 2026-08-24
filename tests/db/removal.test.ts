/**
 * Phase C.1 — manager-initiated assignment removal.
 *
 * A different business event from an employee-requested cancellation, and the
 * tests are written to keep it that way: the audit row must say a manager
 * removed someone, no cancellation request may be fabricated, and history that
 * already happened — worked time, completed shifts, past shifts — must be
 * refused rather than rewritten.
 *
 * The seat this frees goes back to the ONE existing offer engine. Several
 * tests below exist purely to prove nothing about that engine changed.
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

const DB_NAME = "clockwise_removal_test";
const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);

const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";
const B_ASSIGNMENT = "bbbb4444-0000-0000-0000-000000000001";
/** A second seat on the same shift, for the multi-seat cases. */
const A_ASSIGNMENT_2 = "aaaa4444-0000-0000-0000-000000000009";
const REASON = "Nicht erreichbar — Kunde braucht Ersatz.";

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

type RemovalResult = {
  status: string;
  assignment_id?: string;
  employee_id?: string;
  shift_id?: string;
  previous_status?: string;
  resolved_request?: boolean;
  seats_open?: number;
  shift_status?: string;
};

async function removeAs(
  userId: string,
  assignmentId: string,
  reason = REASON
): Promise<RemovalResult> {
  return runAs(
    userId,
    async (q) =>
      (
        await q("select public.remove_shift_assignment($1, $2) as result", [assignmentId, reason])
      ).rows[0].result as RemovalResult,
    { commit: true }
  );
}

async function assignmentStatus(id = A_ASSIGNMENT): Promise<string | undefined> {
  const { rows } = await db.query("select status from public.shift_assignments where id = $1", [id]);
  return rows[0]?.status as string | undefined;
}

async function shiftStatus(): Promise<string> {
  const { rows } = await db.query("select status from public.shifts where id = $1", [A_SHIFT]);
  return rows[0].status as string;
}

async function occupiedSeats(): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as c from public.shift_assignments
     where shift_id = $1 and status in ('assigned','accepted','cancellation_requested')`,
    [A_SHIFT]
  );
  return Number(rows[0].c);
}

async function removalAudits(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query(
    `select actor_profile_id, entity, entity_id, diff
     from public.audit_logs
     where action = 'shift_assignment.removed_by_manager'
     order by id`
  );
  return rows;
}

/**
 * One seat, worker A holding it, an open offer with both fixture employees
 * interested, no cancellation history, no recorded time.
 */
async function resetScenario({ requiredCount = 1, secondSeat = false } = {}) {
  await db.query("delete from public.audit_logs");
  await db.query("delete from public.time_entries");
  await db.query("delete from public.cancellation_requests");
  await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
  await db.query(
    `update public.shifts
     set required_count = $2, status = 'open',
         start_time = now() + interval '2 days',
         end_time = now() + interval '2 days 8 hours'
     where id = $1`,
    [A_SHIFT, requiredCount]
  );
  await db.query(
    `insert into public.shift_assignments (id, company_id, shift_id, employee_id, status)
     values ($1, $2, $3, $4, 'assigned')`,
    [A_ASSIGNMENT, COMPANY_A, A_SHIFT, EMPLOYEES.aSelf]
  );
  if (secondSeat) {
    await db.query(
      `insert into public.shift_assignments (id, company_id, shift_id, employee_id, status)
       values ($1, $2, $3, $4, 'accepted')`,
      [A_ASSIGNMENT_2, COMPANY_A, A_SHIFT, EMPLOYEES.aColleague]
    );
  }
  await db.query("update public.shift_offers set status = 'open', closed_at = null where id = $1", [
    OFFERS.a,
  ]);
  await db.query(
    `update public.shift_offer_responses
     set response = 'interested', responded_at = now(),
         decided_by = null, decided_at = null, resulting_assignment_id = null
     where offer_id = $1`,
    [OFFERS.a]
  );
  await db.query("update public.employees set employment_status = 'active' where company_id = $1", [
    COMPANY_A,
  ]);
}

beforeAll(async () => {
  db = await createTestDatabase(DB_NAME);
}, 60_000);

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await resetScenario();
});

describe("authorization", () => {
  it("a dispatcher can remove", async () => {
    expect((await removeAs(USERS.aDispatcher, A_ASSIGNMENT)).status).toBe("removed");
  });

  it("a company admin can remove", async () => {
    expect((await removeAs(USERS.aAdmin, A_ASSIGNMENT)).status).toBe("removed");
  });

  it("an employee cannot remove anyone — including themselves", async () => {
    // Releasing yourself is Flow A and goes through a manager.
    const result = await removeAs(USERS.aWorker, A_ASSIGNMENT);
    expect(result.status).toBe("forbidden");
    expect(await assignmentStatus()).toBe("assigned");
    expect(await removalAudits()).toHaveLength(0);
  });

  it("a manager from another tenant sees nothing to remove", async () => {
    const result = await removeAs(USERS.bAdmin, A_ASSIGNMENT);
    expect(result.status).toBe("not_found");
    expect(await assignmentStatus()).toBe("assigned");
  });

  it("a manager cannot reach into another tenant's assignment", async () => {
    const result = await removeAs(USERS.aAdmin, B_ASSIGNMENT);
    expect(result.status).toBe("not_found");
    expect(await assignmentStatus(B_ASSIGNMENT)).toBe("assigned");
  });

  it("refuses without a reason", async () => {
    for (const reason of ["", "   "]) {
      const result = await removeAs(USERS.aDispatcher, A_ASSIGNMENT, reason);
      expect(result.status).toBe("reason_required");
    }
    expect(await assignmentStatus()).toBe("assigned");
    expect(await removalAudits()).toHaveLength(0);
  });
});

describe("assignment state", () => {
  it("removes a future assigned employee", async () => {
    const result = await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(result.status).toBe("removed");
    expect(result.previous_status).toBe("assigned");
    expect(result.employee_id).toBe(EMPLOYEES.aSelf);
    expect(await assignmentStatus()).toBe("cancelled");
  });

  it("removes a future accepted employee", async () => {
    await db.query(
      "update public.shift_assignments set status = 'accepted', accepted_at = now() where id = $1",
      [A_ASSIGNMENT]
    );
    const result = await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(result.status).toBe("removed");
    expect(result.previous_status).toBe("accepted");
  });

  it("keeps the row as history rather than deleting it", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    const { rows } = await db.query(
      "select id, employee_id, status from public.shift_assignments where id = $1",
      [A_ASSIGNMENT]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_id).toBe(EMPLOYEES.aSelf);
  });

  it("refuses an already removed assignment", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    const repeat = await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(repeat.status).toBe("already_removed");
  });

  it("refuses a completed assignment", async () => {
    await db.query("update public.shift_assignments set status = 'completed' where id = $1", [
      A_ASSIGNMENT,
    ]);
    expect((await removeAs(USERS.aDispatcher, A_ASSIGNMENT)).status).toBe("completed");
    expect(await assignmentStatus()).toBe("completed");
  });

  it("refuses once the shift has ended", async () => {
    await db.query(
      `update public.shifts
       set start_time = now() - interval '10 hours', end_time = now() - interval '2 hours'
       where id = $1`,
      [A_SHIFT]
    );
    expect((await removeAs(USERS.aDispatcher, A_ASSIGNMENT)).status).toBe("shift_ended");
    expect(await assignmentStatus()).toBe("assigned");
  });

  it("allows removal from a shift that has started but not ended", async () => {
    // The most useful moment for this function: they never turned up.
    await db.query(
      `update public.shifts
       set start_time = now() - interval '1 hour', end_time = now() + interval '6 hours'
       where id = $1`,
      [A_SHIFT]
    );
    expect((await removeAs(USERS.aDispatcher, A_ASSIGNMENT)).status).toBe("removed");
  });
});

describe("time-entry safety", () => {
  async function recordTime(clockOut: string | null) {
    await db.query(
      `insert into public.time_entries
         (company_id, employee_id, shift_assignment_id, clock_in, clock_out, status)
       values ($1, $2, $3, now() - interval '1 hour', $4, $5)`,
      [
        COMPANY_A,
        EMPLOYEES.aSelf,
        A_ASSIGNMENT,
        clockOut,
        clockOut ? "completed" : "running",
      ]
    );
  }

  it("refuses while the employee is clocked in", async () => {
    await recordTime(null);
    expect((await removeAs(USERS.aDispatcher, A_ASSIGNMENT)).status).toBe("already_clocked_in");
    expect(await assignmentStatus()).toBe("assigned");
  });

  it("refuses when time was already worked and closed", async () => {
    // Removing here would leave worked time hanging off a cancelled
    // assignment — the timesheet would stop describing what happened.
    await recordTime(new Date().toISOString());
    expect((await removeAs(USERS.aDispatcher, A_ASSIGNMENT)).status).toBe("already_clocked_in");
  });

  it("writes no audit row when it refuses", async () => {
    await recordTime(null);
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(await removalAudits()).toHaveLength(0);
  });
});

describe("capacity and staffing", () => {
  it("frees exactly one seat and reopens the shift", async () => {
    expect(await shiftStatus()).toBe("staffed");
    const result = await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(Number(result.seats_open)).toBe(1);
    expect(result.shift_status).toBe("open");
    expect(await occupiedSeats()).toBe(0);
    expect(await shiftStatus()).toBe("open");
  });

  it("a multi-seat shift opens exactly one vacancy, not the whole shift", async () => {
    await resetScenario({ requiredCount: 2, secondSeat: true });
    expect(await occupiedSeats()).toBe(2);
    expect(await shiftStatus()).toBe("staffed");

    const result = await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(Number(result.seats_open)).toBe(1);
    expect(await occupiedSeats()).toBe(1);
    expect(await shiftStatus()).toBe("open");
    // The colleague is untouched.
    expect(await assignmentStatus(A_ASSIGNMENT_2)).toBe("accepted");
  });

  it("stays staffed when capacity is still satisfied", async () => {
    // Two people on a one-seat shift is over-staffing; removing one leaves it
    // correctly staffed rather than open.
    await resetScenario({ requiredCount: 1, secondSeat: true });
    const result = await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(Number(result.seats_open)).toBe(0);
    expect(result.shift_status).toBe("staffed");
    expect(await shiftStatus()).toBe("staffed");
  });

  it("a removed employee no longer holds a seat", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    const { rows } = await db.query(
      `select count(*)::int as c from public.shift_assignments
       where shift_id = $1 and employee_id = $2
         and status in ('assigned','accepted','cancellation_requested')`,
      [A_SHIFT, EMPLOYEES.aSelf]
    );
    expect(Number(rows[0].c)).toBe(0);
  });
});

describe("vacancy meets the existing offer engine", () => {
  it("leaves the open offer untouched and creates no second one", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);

    const { rows: offers } = await db.query(
      "select id, status, closed_at from public.shift_offers where shift_id = $1 and status = 'open'",
      [A_SHIFT]
    );
    expect(offers).toHaveLength(1);
    expect(offers[0].id).toBe(OFFERS.a);
    expect(offers[0].closed_at).toBeNull();
  });

  it("the freed seat is filled through approve_shift_offer", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);

    const approved = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q("select public.approve_shift_offer($1) as result", [OFFER_RESPONSES.aColleague])
        ).rows[0].result as { status: string; shift_filled?: boolean },
      { commit: true }
    );
    expect(approved.status).toBe("approved");
    expect(approved.shift_filled).toBe(true);
    expect(await occupiedSeats()).toBe(1);
    expect(await shiftStatus()).toBe("staffed");
  });

  it("cannot overfill once the freed seat is taken", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    await runAs(
      USERS.aDispatcher,
      async (q) => q("select public.approve_shift_offer($1)", [OFFER_RESPONSES.aColleague]),
      { commit: true }
    );

    const overfill = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q("select public.approve_shift_offer($1) as result", [OFFER_RESPONSES.aSelf])
        ).rows[0].result as { status: string; assignment_id?: string },
      { commit: true }
    );
    expect(["no_vacancy", "offer_closed"]).toContain(overfill.status);
    expect(overfill.assignment_id).toBeUndefined();
    expect(await occupiedSeats()).toBe(1);
  });

  it("the unique key — not a rule — is what stops re-approving a removed employee", async () => {
    // Documents the constraint the application layer now checks for. A
    // cancelled assignment holds no seat but still holds (shift_id,
    // employee_id), so putting the same person back through the offer is a
    // constraint violation at this level. approveOfferResponse() looks for the
    // prior row first and refuses with 'already_assigned' instead.
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);

    await expect(
      runAs(
        USERS.aDispatcher,
        async (q) => q("select public.approve_shift_offer($1)", [OFFER_RESPONSES.aSelf]),
        { commit: true }
      )
    ).rejects.toThrow(/shift_assignments_shift_id_employee_id_key/);

    // Nothing partial survived the failed transaction.
    expect(await occupiedSeats()).toBe(0);
  });

  it("before removal the offer cannot take the occupied seat", async () => {
    const blocked = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q("select public.approve_shift_offer($1) as result", [OFFER_RESPONSES.aColleague])
        ).rows[0].result as { status: string },
      { commit: true }
    );
    expect(blocked.status).toBe("no_vacancy");
  });
});

describe("a pending employee cancellation", () => {
  let requestId: string;

  beforeEach(async () => {
    const result = await runAs(
      USERS.aWorker,
      async (q) =>
        (
          await q("select public.request_shift_cancellation($1, $2) as result", [
            A_ASSIGNMENT,
            "Kind krank",
          ])
        ).rows[0].result as { status: string; request_id: string },
      { commit: true }
    );
    expect(result.status).toBe("requested");
    requestId = result.request_id;
  });

  it("can be removed, and the request is settled rather than left hanging", async () => {
    // The manager is granting the release. Leaving the request pending against
    // a cancelled assignment would be a state nothing could ever resolve.
    const result = await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(result.status).toBe("removed");
    expect(result.previous_status).toBe("cancellation_requested");
    expect(result.resolved_request).toBe(true);

    const { rows } = await db.query(
      "select status, decided_by, decided_at from public.cancellation_requests where id = $1",
      [requestId]
    );
    expect(rows[0].status).toBe("approved");
    expect(rows[0].decided_by).toBe(USERS.aDispatcher);
    expect(rows[0].decided_at).not.toBeNull();
  });

  it("records it as a manager removal, not as an employee request approval", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    const audits = await removalAudits();
    expect(audits).toHaveLength(1);
    expect((audits[0].diff as Record<string, unknown>).resolved_cancellation_request).toBe(true);
    expect((audits[0].diff as Record<string, unknown>).previous_status).toBe(
      "cancellation_requested"
    );
  });

  it("leaves no pending request behind", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    const { rows } = await db.query(
      "select count(*)::int as c from public.cancellation_requests where status = 'pending'"
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("the ordinary decide path is unaffected once removal happened", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    const late = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q("select public.decide_cancellation_request($1, true) as result", [requestId])
        ).rows[0].result as { status: string },
      { commit: true }
    );
    expect(late.status).toBe("not_pending");
  });
});

describe("no fabricated cancellation request", () => {
  it("an ordinary removal creates no cancellation_requests row at all", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    const { rows } = await db.query("select count(*)::int as c from public.cancellation_requests");
    expect(Number(rows[0].c)).toBe(0);
  });
});

describe("audit trail", () => {
  it("writes exactly one durable record naming the manager and the reason", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    const audits = await removalAudits();
    expect(audits).toHaveLength(1);

    const row = audits[0];
    const diff = row.diff as Record<string, unknown>;
    expect(row.actor_profile_id).toBe(USERS.aDispatcher);
    expect(row.entity).toBe("shift_assignments");
    expect(row.entity_id).toBe(A_ASSIGNMENT);
    expect(diff.reason).toBe(REASON);
    expect(diff.employee_id).toBe(EMPLOYEES.aSelf);
    expect(diff.shift_id).toBe(A_SHIFT);
    expect(diff.previous_status).toBe("assigned");
  });

  it("writes no second record on a repeated removal", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(await removalAudits()).toHaveLength(1);
  });

  it("is distinguishable from an approved employee cancellation", async () => {
    await removeAs(USERS.aDispatcher, A_ASSIGNMENT);
    const { rows } = await db.query(
      "select action from public.audit_logs order by id"
    );
    expect(rows.map((r) => r.action)).toEqual(["shift_assignment.removed_by_manager"]);
  });
});

describe("atomicity", () => {
  it("rolls the whole operation back when a later step fails", async () => {
    // Raise after the assignment update. If removal were not one transaction,
    // the seat would be freed with no audit row to explain it.
    await db.query(`
      create or replace function public.__boom() returns trigger
      language plpgsql as $$
      begin
        if new.status = 'cancelled' then
          raise exception 'boom';
        end if;
        return null;
      end $$;
    `);
    await db.query(`
      create trigger boom_after_cancel
      after update of status on public.shift_assignments
      for each row execute function public.__boom();
    `);

    try {
      await expect(removeAs(USERS.aDispatcher, A_ASSIGNMENT)).rejects.toThrow(/boom/);
    } finally {
      await db.query("drop trigger if exists boom_after_cancel on public.shift_assignments");
      await db.query("drop function if exists public.__boom()");
    }

    expect(await assignmentStatus()).toBe("assigned");
    expect(await occupiedSeats()).toBe(1);
    expect(await shiftStatus()).toBe("staffed");
    expect(await removalAudits()).toHaveLength(0);
  });
});

/**
 * Real races on independent connections. Both statements are in flight before
 * either transaction commits, and the test never awaits a fixed client first —
 * which order reaches the shift lock is genuinely non-deterministic.
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

  it("two managers removing the same assignment produce one removal and one refusal", async () => {
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();

    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aAdmin);

      const call = (client: Client) =>
        client
          .query("select public.remove_shift_assignment($1, $2) as result", [
            A_ASSIGNMENT,
            REASON,
          ])
          .then((r) => ({ client, result: r.rows[0].result as RemovalResult }));

      const [first, second] = await race([
        { client: a, promise: call(a) },
        { client: b, promise: call(b) },
      ]);

      expect(first.result.status).toBe("removed");
      expect(second.result.status).toBe("already_removed");
    } finally {
      await a.end();
      await b.end();
    }

    // One state change, one audit row, therefore one employee notification.
    expect(await assignmentStatus()).toBe("cancelled");
    expect(await removalAudits()).toHaveLength(1);
  });

  it("removal racing an offer approval never overfills the shift", async () => {
    // Genuinely contended: one seat, held by worker A, and the candidate the
    // other manager is approving holds nothing. Whether the approval sees a
    // vacancy depends entirely on which transaction commits first.
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();

    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aAdmin);

      await race<unknown>([
        {
          client: a,
          promise: a
            .query("select public.remove_shift_assignment($1, $2) as result", [
              A_ASSIGNMENT,
              REASON,
            ])
            .then((r) => ({ client: a, result: r.rows[0].result })),
        },
        {
          client: b,
          promise: b
            // A third person, not one of the two already on the shift.
            .query("select public.approve_shift_offer($1) as result", [
              OFFER_RESPONSES.aColleague,
            ])
            .then((r) => ({ client: b, result: r.rows[0].result })),
        },
      ]);
    } finally {
      await a.end();
      await b.end();
    }

    const { rows } = await db.query("select required_count from public.shifts where id = $1", [
      A_SHIFT,
    ]);
    expect(Number(rows[0].required_count)).toBe(1);
    expect(await occupiedSeats()).toBeLessThanOrEqual(1);

    // And exactly one person ends up holding it, or nobody does — never two.
    const { rows: holders } = await db.query(
      `select count(*)::int as c from public.shift_assignments
       where shift_id = $1 and status in ('assigned','accepted','cancellation_requested')`,
      [A_SHIFT]
    );
    expect(Number(holders[0].c)).toBeLessThanOrEqual(1);
  });

  it("removal racing an employee cancellation request leaves no contradictory state", async () => {
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();

    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aWorker);

      await race<unknown>([
        {
          client: a,
          promise: a
            .query("select public.remove_shift_assignment($1, $2) as result", [
              A_ASSIGNMENT,
              REASON,
            ])
            .then((r) => ({ client: a, result: r.rows[0].result })),
        },
        {
          client: b,
          promise: b
            .query("select public.request_shift_cancellation($1, $2) as result", [
              A_ASSIGNMENT,
              "Kind krank",
            ])
            .then((r) => ({ client: b, result: r.rows[0].result })),
        },
      ]);
    } finally {
      await a.end();
      await b.end();
    }

    // Whichever landed first: the assignment ends up cancelled, and no request
    // is left pending against a cancelled assignment.
    expect(await assignmentStatus()).toBe("cancelled");
    const { rows } = await db.query(
      "select count(*)::int as c from public.cancellation_requests where status = 'pending'"
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("removal racing a cancellation decision releases the seat only once", async () => {
    await runAs(
      USERS.aWorker,
      async (q) =>
        q("select public.request_shift_cancellation($1, $2)", [A_ASSIGNMENT, "Kind krank"]),
      { commit: true }
    );
    const { rows: reqRows } = await db.query(
      "select id from public.cancellation_requests where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    const requestId = reqRows[0].id as string;

    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();

    try {
      await beginAs(a, USERS.aDispatcher);
      await beginAs(b, USERS.aAdmin);

      await race<unknown>([
        {
          client: a,
          promise: a
            .query("select public.remove_shift_assignment($1, $2) as result", [
              A_ASSIGNMENT,
              REASON,
            ])
            .then((r) => ({ client: a, result: r.rows[0].result })),
        },
        {
          client: b,
          promise: b
            .query("select public.decide_cancellation_request($1, true) as result", [requestId])
            .then((r) => ({ client: b, result: r.rows[0].result })),
        },
      ]);
    } finally {
      await a.end();
      await b.end();
    }

    expect(await assignmentStatus()).toBe("cancelled");
    expect(await occupiedSeats()).toBe(0);
    // At most one of the two paths recorded a manager removal.
    expect((await removalAudits()).length).toBeLessThanOrEqual(1);

    const { rows } = await db.query(
      "select count(*)::int as c from public.cancellation_requests where status = 'pending'"
    );
    expect(Number(rows[0].c)).toBe(0);
  });
});

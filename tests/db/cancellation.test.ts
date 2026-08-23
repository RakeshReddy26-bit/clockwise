/**
 * Phase C — the cancellation loop, end to end at the database level.
 *
 * Two functions carry the whole feature: request_shift_cancellation() parks an
 * assignment without freeing the seat, and decide_cancellation_request()
 * either frees it or puts the assignment back. What is tested here is what
 * those two must guarantee on their own — that a repeated submit produces one
 * request and not two, that a decision is final, that an employee cannot
 * decide and a manager from another tenant cannot see, and above all that a
 * seat freed by a cancellation cannot be handed out twice by the Phase B
 * offer approval that is still running against the same shift.
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

const DB_NAME = "clockwise_cancellation_test";
const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);

const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";
const REASON = "Kind krank — ich kann die Schicht nicht übernehmen.";

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

type RequestResult = {
  status: string;
  request_id?: string;
  assignment_status?: string;
};

type DecisionResult = {
  status: string;
  assignment_id?: string;
  shift_id?: string;
  assignment_status?: string;
  seats_open?: number;
  decision?: string;
};

async function requestAs(
  userId: string,
  assignmentId: string,
  reason = REASON
): Promise<RequestResult> {
  return runAs(
    userId,
    async (q) =>
      (
        await q("select public.request_shift_cancellation($1, $2) as result", [
          assignmentId,
          reason,
        ])
      ).rows[0].result as RequestResult,
    { commit: true }
  );
}

async function decideAs(
  userId: string,
  requestId: string,
  approve: boolean
): Promise<DecisionResult> {
  return runAs(
    userId,
    async (q) =>
      (
        await q("select public.decide_cancellation_request($1, $2) as result", [
          requestId,
          approve,
        ])
      ).rows[0].result as DecisionResult,
    { commit: true }
  );
}

async function assignmentStatus(id = A_ASSIGNMENT): Promise<string> {
  const { rows } = await db.query("select status from public.shift_assignments where id = $1", [id]);
  return rows[0]?.status as string;
}

async function shiftStatus(): Promise<string> {
  const { rows } = await db.query("select status from public.shifts where id = $1", [A_SHIFT]);
  return rows[0].status as string;
}

/** Assignments that currently hold a seat on the shift. */
async function occupiedSeats(): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as c from public.shift_assignments
     where shift_id = $1 and status in ('assigned','accepted','cancellation_requested')`,
    [A_SHIFT]
  );
  return Number(rows[0].c);
}

async function pendingRequestId(): Promise<string | null> {
  const { rows } = await db.query(
    "select id from public.cancellation_requests where shift_assignment_id = $1 and status = 'pending'",
    [A_ASSIGNMENT]
  );
  return (rows[0]?.id as string) ?? null;
}

/**
 * One seat, worker A holding it, an open offer on the same shift with both
 * fixture employees interested, and no cancellation history.
 */
async function resetScenario({ requiredCount = 1 } = {}) {
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
  await db.query(
    "update public.shift_offers set status = 'open', closed_at = null where id = $1",
    [OFFERS.a]
  );
  await db.query(
    `update public.shift_offer_responses
     set response = 'interested', responded_at = now(),
         decided_by = null, decided_at = null, resulting_assignment_id = null
     where offer_id = $1`,
    [OFFERS.a]
  );
  await db.query(
    "update public.employees set employment_status = 'active' where company_id = $1",
    [COMPANY_A]
  );
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

describe("employee raises a request", () => {
  it("records the request and parks the assignment", async () => {
    const result = await requestAs(USERS.aWorker, A_ASSIGNMENT);
    expect(result.status).toBe("requested");
    expect(result.request_id).toBeTruthy();

    expect(await assignmentStatus()).toBe("cancellation_requested");

    const { rows } = await db.query(
      "select status, decided_by, decided_at from public.cancellation_requests where id = $1",
      [result.request_id]
    );
    expect(rows[0].status).toBe("pending");
    expect(rows[0].decided_by).toBeNull();
    expect(rows[0].decided_at).toBeNull();
  });

  it("does NOT free the seat", async () => {
    // The whole point of the parking state: nobody is left uncovered while a
    // manager is still deciding.
    expect(await shiftStatus()).toBe("staffed");
    await requestAs(USERS.aWorker, A_ASSIGNMENT);
    expect(await occupiedSeats()).toBe(1);
    expect(await shiftStatus()).toBe("staffed");
  });

  it("refuses a duplicate request idempotently", async () => {
    const first = await requestAs(USERS.aWorker, A_ASSIGNMENT);
    const second = await requestAs(USERS.aWorker, A_ASSIGNMENT, "noch einmal, aus Versehen");

    expect(first.status).toBe("requested");
    expect(second.status).toBe("already_requested");
    expect(second.request_id).toBeUndefined();

    const { rows } = await db.query(
      "select count(*)::int as c from public.cancellation_requests where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    expect(Number(rows[0].c)).toBe(1);
    expect(await assignmentStatus()).toBe("cancellation_requested");
  });

  it("keeps the first reason when a duplicate is refused", async () => {
    await requestAs(USERS.aWorker, A_ASSIGNMENT);
    await requestAs(USERS.aWorker, A_ASSIGNMENT, "ein anderer Grund");
    const { rows } = await db.query(
      "select reason from public.cancellation_requests where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe(REASON);
  });

  it("stores the reason exactly as submitted", async () => {
    const raw = "  Ärztlicher Termin \"dringend\";\nBitte um Ersatz — danke!  ";
    const result = await requestAs(USERS.aWorker, A_ASSIGNMENT, raw);
    expect(result.status).toBe("requested");

    const { rows } = await db.query(
      "select reason, length(reason) as len from public.cancellation_requests where id = $1",
      [result.request_id]
    );
    expect(rows[0].reason).toBe(raw);
    expect(Number(rows[0].len)).toBe(raw.length);
  });

  it("refuses once the shift has ended", async () => {
    await db.query(
      `update public.shifts
       set start_time = now() - interval '10 hours', end_time = now() - interval '2 hours'
       where id = $1`,
      [A_SHIFT]
    );
    const result = await requestAs(USERS.aWorker, A_ASSIGNMENT);
    expect(result.status).toBe("shift_ended");

    expect(await pendingRequestId()).toBeNull();
    expect(await assignmentStatus()).toBe("assigned");
  });

  it("allows a request while the shift is running but not finished", async () => {
    await db.query(
      `update public.shifts
       set start_time = now() - interval '1 hour', end_time = now() + interval '4 hours'
       where id = $1`,
      [A_SHIFT]
    );
    expect((await requestAs(USERS.aWorker, A_ASSIGNMENT)).status).toBe("requested");
  });

  it("refuses an assignment that is no longer live", async () => {
    await db.query("update public.shift_assignments set status = 'cancelled' where id = $1", [
      A_ASSIGNMENT,
    ]);
    const result = await requestAs(USERS.aWorker, A_ASSIGNMENT);
    expect(result.status).toBe("not_cancellable");
    expect(await pendingRequestId()).toBeNull();
  });
});

describe("ownership", () => {
  it("an employee of another tenant cannot see the assignment at all", async () => {
    const result = await requestAs(USERS.bWorker, A_ASSIGNMENT);
    expect(result.status).toBe("not_found");
    expect(await assignmentStatus()).toBe("assigned");
  });

  it("a manager cannot raise a cancellation on an employee's behalf", async () => {
    // The dispatcher can read the row — this is refused by the ownership check
    // in the function, not by RLS, which is exactly what it is there for.
    const result = await requestAs(USERS.aDispatcher, A_ASSIGNMENT);
    expect(result.status).toBe("forbidden");
    expect(await assignmentStatus()).toBe("assigned");
    expect(await pendingRequestId()).toBeNull();
  });

  it("the database itself refuses a second pending row", async () => {
    // The app checks first and the function checks again, but the index is
    // what makes it impossible — including for a race neither check can see.
    await requestAs(USERS.aWorker, A_ASSIGNMENT);
    await expect(
      db.query(
        `insert into public.cancellation_requests (company_id, shift_assignment_id, reason)
         values ($1, $2, 'zweiter Antrag')`,
        [COMPANY_A, A_ASSIGNMENT]
      )
    ).rejects.toThrow(/cancellation_requests_one_open_per_assignment/);
  });

  it("a decided request does not block a later one", async () => {
    // The index is partial: only pending rows are unique, so an employee whose
    // request was rejected may ask again later.
    const first = await requestAs(USERS.aWorker, A_ASSIGNMENT);
    await decideAs(USERS.aDispatcher, first.request_id as string, false);

    const second = await requestAs(USERS.aWorker, A_ASSIGNMENT, "neuer Grund");
    expect(second.status).toBe("requested");

    const { rows } = await db.query(
      "select count(*)::int as c from public.cancellation_requests where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    expect(Number(rows[0].c)).toBe(2);
  });

  it("an employee sees only their own requests", async () => {
    await requestAs(USERS.aWorker, A_ASSIGNMENT);

    const mine = await runAs(USERS.aWorker, async (q) =>
      Number((await q("select count(*)::int as c from cancellation_requests")).rows[0].c)
    );
    const theirs = await runAs(USERS.bWorker, async (q) =>
      Number((await q("select count(*)::int as c from cancellation_requests")).rows[0].c)
    );
    expect(mine).toBe(1);
    expect(theirs).toBe(0);
  });
});

describe("manager decides", () => {
  let requestId: string;

  beforeEach(async () => {
    const result = await requestAs(USERS.aWorker, A_ASSIGNMENT);
    requestId = result.request_id as string;
  });

  it("approval cancels the assignment and reopens the shift", async () => {
    const result = await decideAs(USERS.aDispatcher, requestId, true);
    expect(result.status).toBe("approved");
    expect(result.assignment_status).toBe("cancelled");
    expect(Number(result.seats_open)).toBe(1);

    expect(await assignmentStatus()).toBe("cancelled");
    expect(await occupiedSeats()).toBe(0);
    expect(await shiftStatus()).toBe("open");

    const { rows } = await db.query(
      "select status, decided_by, decided_at from public.cancellation_requests where id = $1",
      [requestId]
    );
    expect(rows[0].status).toBe("approved");
    expect(rows[0].decided_by).toBe(USERS.aDispatcher);
    expect(rows[0].decided_at).not.toBeNull();
  });

  it("rejection restores an assignment that was never accepted", async () => {
    const result = await decideAs(USERS.aDispatcher, requestId, false);
    expect(result.status).toBe("rejected");
    expect(result.assignment_status).toBe("assigned");

    expect(await assignmentStatus()).toBe("assigned");
    expect(await occupiedSeats()).toBe(1);
    expect(await shiftStatus()).toBe("staffed");

    const { rows } = await db.query(
      "select status from public.cancellation_requests where id = $1",
      [requestId]
    );
    expect(rows[0].status).toBe("rejected");
  });

  it("rejection restores an accepted assignment as accepted", async () => {
    await db.query("update public.shift_assignments set accepted_at = now() where id = $1", [
      A_ASSIGNMENT,
    ]);
    const result = await decideAs(USERS.aDispatcher, requestId, false);
    expect(result.assignment_status).toBe("accepted");
    expect(await assignmentStatus()).toBe("accepted");
  });

  it("a company admin may decide as well as a dispatcher", async () => {
    expect((await decideAs(USERS.aAdmin, requestId, true)).status).toBe("approved");
  });

  it("a second decision is refused and changes nothing", async () => {
    // The manager's second click, or a retried request.
    const first = await decideAs(USERS.aDispatcher, requestId, true);
    const second = await decideAs(USERS.aDispatcher, requestId, true);
    expect(first.status).toBe("approved");
    expect(second.status).toBe("not_pending");
    expect(second.decision).toBe("approved");
    expect(await assignmentStatus()).toBe("cancelled");
  });

  it("cannot be flipped by deciding the other way afterwards", async () => {
    await decideAs(USERS.aDispatcher, requestId, true);
    const flip = await decideAs(USERS.aDispatcher, requestId, false);
    expect(flip.status).toBe("not_pending");
    expect(await assignmentStatus()).toBe("cancelled");
    expect(await shiftStatus()).toBe("open");
  });

  it("refuses when the assignment left the parking state behind the manager's back", async () => {
    await db.query("update public.shift_assignments set status = 'cancelled' where id = $1", [
      A_ASSIGNMENT,
    ]);
    const result = await decideAs(USERS.aDispatcher, requestId, false);
    expect(result.status).toBe("assignment_not_active");

    // The request stays visible rather than silently disappearing.
    const { rows } = await db.query(
      "select status from public.cancellation_requests where id = $1",
      [requestId]
    );
    expect(rows[0].status).toBe("pending");
  });

  it("an employee calling the function directly is refused", async () => {
    const result = await decideAs(USERS.aWorker, requestId, true);
    expect(result.status).toBe("forbidden");
    expect(await assignmentStatus()).toBe("cancellation_requested");

    const { rows } = await db.query(
      "select status from public.cancellation_requests where id = $1",
      [requestId]
    );
    expect(rows[0].status).toBe("pending");
  });

  it("a manager from another tenant cannot resolve the request", async () => {
    const result = await decideAs(USERS.bAdmin, requestId, true);
    expect(result.status).toBe("not_found");
    expect(await assignmentStatus()).toBe("cancellation_requested");
  });
});

/**
 * The interaction the whole phase hangs on: a shift that already has an open
 * offer, whose seat is freed by an approved cancellation. The offer must stay
 * usable, the seat count must be recomputed from the assignments rather than
 * remembered, and B4's approval must still refuse to overfill.
 */
describe("freed seat meets an open offer", () => {
  let requestId: string;

  beforeEach(async () => {
    const result = await requestAs(USERS.aWorker, A_ASSIGNMENT);
    requestId = result.request_id as string;
  });

  it("leaves the existing open offer untouched", async () => {
    const before = await db.query(
      "select status, closed_at from public.shift_offers where id = $1",
      [OFFERS.a]
    );
    expect(before.rows[0].status).toBe("open");

    await decideAs(USERS.aDispatcher, requestId, true);

    const after = await db.query(
      "select status, closed_at from public.shift_offers where id = $1",
      [OFFERS.a]
    );
    expect(after.rows[0].status).toBe("open");
    expect(after.rows[0].closed_at).toBeNull();

    // Both responses survive as history and stay undecided.
    const { rows } = await db.query(
      "select count(*)::int as c from public.shift_offer_responses where offer_id = $1 and decided_at is null",
      [OFFERS.a]
    );
    expect(Number(rows[0].c)).toBe(2);
  });

  it("recomputes the seat count from assignments, not from memory", async () => {
    await decideAs(USERS.aDispatcher, requestId, true);

    // The cancelled row is still there; it just does not occupy anything.
    const { rows: all } = await db.query(
      "select count(*)::int as c from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    expect(Number(all[0].c)).toBe(1);
    expect(await occupiedSeats()).toBe(0);
    expect(await shiftStatus()).toBe("open");
  });

  it("the freed seat can be filled through the existing offer approval", async () => {
    await decideAs(USERS.aDispatcher, requestId, true);

    const approved = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q("select public.approve_shift_offer($1) as result", [
            OFFER_RESPONSES.aColleague,
          ])
        ).rows[0].result as { status: string; shift_filled?: boolean },
      { commit: true }
    );
    expect(approved.status).toBe("approved");
    expect(approved.shift_filled).toBe(true);

    expect(await occupiedSeats()).toBe(1);
    expect(await shiftStatus()).toBe("staffed");

    const { rows } = await db.query(
      "select employee_id from public.shift_assignments where shift_id = $1 and status = 'assigned'",
      [A_SHIFT]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_id).toBe(EMPLOYEES.aColleague);
  });

  it("approve_shift_offer cannot overfill the shift once the freed seat is taken", async () => {
    await decideAs(USERS.aDispatcher, requestId, true);

    await runAs(
      USERS.aDispatcher,
      async (q) =>
        q("select public.approve_shift_offer($1) as result", [OFFER_RESPONSES.aColleague]),
      { commit: true }
    );

    // Worker A's own response is still undecided and still interested.
    // Approving it would put two people on a one-seat shift.
    const overfill = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q("select public.approve_shift_offer($1) as result", [OFFER_RESPONSES.aSelf])
        ).rows[0].result as { status: string; assignment_id?: string },
      { commit: true }
    );

    // Either refusal is correct and both are load-bearing: taking the last
    // seat also closes the offer, so whichever guard is reached first, no
    // second assignment exists.
    expect(["no_vacancy", "offer_closed"]).toContain(overfill.status);
    expect(overfill.assignment_id).toBeUndefined();

    const { rows } = await db.query(
      "select required_count from public.shifts where id = $1",
      [A_SHIFT]
    );
    expect(await occupiedSeats()).toBe(1);
    expect(await occupiedSeats()).toBeLessThanOrEqual(Number(rows[0].required_count));
  });

  it("refuses the second candidate outright while a seat is still held", async () => {
    // The no_vacancy guard itself, with the offer still open: the cancellation
    // is rejected, so the seat was never freed.
    await decideAs(USERS.aDispatcher, requestId, false);

    const attempt = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q("select public.approve_shift_offer($1) as result", [
            OFFER_RESPONSES.aColleague,
          ])
        ).rows[0].result as { status: string },
      { commit: true }
    );
    expect(attempt.status).toBe("no_vacancy");

    const { rows } = await db.query(
      "select status from public.shift_offers where id = $1",
      [OFFERS.a]
    );
    expect(rows[0].status).toBe("open");
  });

  it("a rejected cancellation leaves no vacancy for the offer to fill", async () => {
    await decideAs(USERS.aDispatcher, requestId, false);

    const attempt = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (
          await q("select public.approve_shift_offer($1) as result", [
            OFFER_RESPONSES.aColleague,
          ])
        ).rows[0].result as { status: string },
      { commit: true }
    );
    expect(attempt.status).toBe("no_vacancy");
    expect(await occupiedSeats()).toBe(1);
  });
});

/**
 * Genuine concurrency on two connections. The shift row lock is taken in the
 * same order by both functions, which is what makes these deterministic in
 * outcome (exactly one decision wins) and free of deadlocks.
 */
describe("concurrency", () => {
  async function beginAs(client: Client, userId: string) {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
  }

  it("two managers deciding the same request produce exactly one decision", async () => {
    const { request_id: requestId } = await requestAs(USERS.aWorker, A_ASSIGNMENT);

    const clientA = new Client({ connectionString: DB_URL });
    const clientB = new Client({ connectionString: DB_URL });
    await clientA.connect();
    await clientB.connect();

    try {
      await beginAs(clientA, USERS.aDispatcher);
      await beginAs(clientB, USERS.aAdmin);

      // Which one reaches the shift lock first is not deterministic, so the
      // test must not await a fixed client — that deadlocks whenever the other
      // one won the race.
      const tagged = (client: Client, approve: boolean) =>
        client
          .query("select public.decide_cancellation_request($1, $2) as result", [
            requestId,
            approve,
          ])
          .then((r) => ({ client, result: r.rows[0].result as DecisionResult }));

      const inFlight = [
        { client: clientA, promise: tagged(clientA, true) },
        { client: clientB, promise: tagged(clientB, false) },
      ];

      const first = await Promise.race(inFlight.map((e) => e.promise));
      const winner = inFlight.find((e) => e.client === first.client)!;
      const loser = inFlight.find((e) => e.client !== first.client)!;
      await winner.client.query("commit");

      const second = await loser.promise;
      await loser.client.query("commit");

      expect(["approved", "rejected"]).toContain(first.result.status);
      expect(second.result.status).toBe("not_pending");
    } finally {
      await clientA.end();
      await clientB.end();
    }

    const { rows } = await db.query(
      "select count(*)::int as c from public.cancellation_requests where status = 'pending'"
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("a cancellation approval racing an offer approval never overfills the shift", async () => {
    const { request_id: requestId } = await requestAs(USERS.aWorker, A_ASSIGNMENT);

    const clientA = new Client({ connectionString: DB_URL });
    const clientB = new Client({ connectionString: DB_URL });
    await clientA.connect();
    await clientB.connect();

    try {
      await beginAs(clientA, USERS.aDispatcher);
      await beginAs(clientB, USERS.aAdmin);

      const inFlight = [
        {
          client: clientA,
          promise: clientA
            .query("select public.decide_cancellation_request($1, true) as result", [requestId])
            .then((r) => ({ client: clientA, result: r.rows[0].result as DecisionResult })),
        },
        {
          client: clientB,
          promise: clientB
            .query("select public.approve_shift_offer($1) as result", [
              OFFER_RESPONSES.aColleague,
            ])
            .then((r) => ({ client: clientB, result: r.rows[0].result as { status: string } })),
        },
      ];

      const first = await Promise.race(inFlight.map((e) => e.promise));
      const winner = inFlight.find((e) => e.client === first.client)!;
      const loser = inFlight.find((e) => e.client !== first.client)!;
      await winner.client.query("commit");
      await loser.promise;
      await loser.client.query("commit");
    } finally {
      await clientA.end();
      await clientB.end();
    }

    // Whichever order they landed in, the invariant holds.
    const { rows } = await db.query("select required_count from public.shifts where id = $1", [
      A_SHIFT,
    ]);
    expect(await occupiedSeats()).toBeLessThanOrEqual(Number(rows[0].required_count));
  });
});

/**
 * approve_shift_offer(): the atomic half of B4.
 *
 * The scheduling rules are revalidated in TypeScript before this runs; what is
 * tested here is what the function itself must guarantee — that the last seat
 * cannot be taken twice, that a decided response is final, and that an
 * employee cannot approve themselves even by calling it directly.
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

const DB_NAME = "clockwise_approval_test";
const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);

const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

type ApprovalResult = {
  status: string;
  assignment_id?: string;
  shift_filled?: boolean;
};

async function approveAs(userId: string, responseId: string): Promise<ApprovalResult> {
  return runAs(
    userId,
    async (q) =>
      (await q("select public.approve_shift_offer($1) as result", [responseId])).rows[0]
        .result as ApprovalResult,
    { commit: true }
  );
}

/**
 * Reset to a known starting point: one open offer on a shift with one seat,
 * both fixture employees interested, nothing assigned or decided.
 */
async function resetScenario({ requiredCount = 1 } = {}) {
  await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
  await db.query(
    "update public.shifts set required_count = $2, status = 'open', start_time = now() + interval '2 days', end_time = now() + interval '2 days 8 hours' where id = $1",
    [A_SHIFT, requiredCount]
  );
  await db.query(
    "update public.shift_offers set status = 'cancelled' where shift_id = $1 and id <> $2",
    [A_SHIFT, OFFERS.a]
  );
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
  await db.query(
    "update public.employees set employment_status = 'active' where company_id = $1",
    [COMPANY_A]
  );
}

beforeAll(async () => {
  db = await createTestDatabase(DB_NAME);
  // The fixture assignment would otherwise occupy the only seat.
  await db.query("delete from public.shift_assignments where id = $1", [A_ASSIGNMENT]);
}, 60_000);

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await resetScenario();
});

describe("approval", () => {
  it("assigns an interested candidate and reports the shift filled", async () => {
    const result = await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf);
    expect(result.status).toBe("approved");
    expect(result.assignment_id).toBeTruthy();
    expect(result.shift_filled).toBe(true);

    const { rows } = await db.query(
      "select employee_id, status from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_id).toBe(EMPLOYEES.aSelf);
  });

  it("records the decision on the response", async () => {
    const result = await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf);
    const { rows } = await db.query(
      "select decided_by, decided_at, resulting_assignment_id from public.shift_offer_responses where id = $1",
      [OFFER_RESPONSES.aSelf]
    );
    expect(rows[0].decided_by).toBe(USERS.aDispatcher);
    expect(rows[0].decided_at).not.toBeNull();
    expect(rows[0].resulting_assignment_id).toBe(result.assignment_id);
  });

  it("the staffing trigger flips the shift to staffed", async () => {
    await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf);
    const { rows } = await db.query("select status from public.shifts where id = $1", [A_SHIFT]);
    expect(rows[0].status).toBe("staffed");
  });

  it("closes the offer as filled once the last seat goes", async () => {
    await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf);
    const { rows } = await db.query(
      "select status, closed_at from public.shift_offers where id = $1",
      [OFFERS.a]
    );
    expect(rows[0].status).toBe("filled");
    expect(rows[0].closed_at).not.toBeNull();
  });

  it("keeps the offer open while seats remain", async () => {
    await resetScenario({ requiredCount: 2 });
    const result = await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf);
    expect(result.shift_filled).toBe(false);

    const { rows } = await db.query("select status from public.shift_offers where id = $1", [
      OFFERS.a,
    ]);
    expect(rows[0].status).toBe("open");

    // and the second interested candidate can still be approved
    const second = await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aColleague);
    expect(second.status).toBe("approved");
    expect(second.shift_filled).toBe(true);
  });

  it("leaves undecided responses intact as history when the offer closes", async () => {
    await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf);
    const { rows } = await db.query(
      "select count(*)::int as c from public.shift_offer_responses where offer_id = $1",
      [OFFERS.a]
    );
    expect(Number(rows[0].c)).toBe(2);
  });
});

describe("refusals", () => {
  it("a second approval of the same response is already_decided", async () => {
    await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf);
    const repeat = await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf);
    expect(repeat.status).toBe("already_decided");

    const { rows } = await db.query(
      "select count(*)::int as c from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    expect(Number(rows[0].c)).toBe(1);
  });

  it("a declined candidate cannot be approved", async () => {
    await db.query("update public.shift_offer_responses set response = 'declined' where id = $1", [
      OFFER_RESPONSES.aSelf,
    ]);
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "not_interested"
    );
  });

  it("a withdrawn candidate cannot be approved", async () => {
    await db.query("update public.shift_offer_responses set response = 'withdrawn' where id = $1", [
      OFFER_RESPONSES.aSelf,
    ]);
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "not_interested"
    );
  });

  it("a candidate who has not answered cannot be approved", async () => {
    await db.query("update public.shift_offer_responses set response = 'pending' where id = $1", [
      OFFER_RESPONSES.aSelf,
    ]);
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "not_interested"
    );
  });

  it("a closed offer cannot be approved from", async () => {
    await db.query("update public.shift_offers set status = 'cancelled' where id = $1", [OFFERS.a]);
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe("offer_closed");
  });

  it("a shift that has already started cannot be approved", async () => {
    await db.query(
      "update public.shifts set start_time = now() - interval '1 hour', end_time = now() + interval '4 hours' where id = $1",
      [A_SHIFT]
    );
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "shift_in_past"
    );
  });

  it("a cancelled shift cannot be approved", async () => {
    await db.query("update public.shifts set status = 'cancelled' where id = $1", [A_SHIFT]);
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "shift_not_open"
    );
  });

  it("an employee deactivated after responding cannot be approved", async () => {
    await db.query("update public.employees set employment_status = 'terminated' where id = $1", [
      EMPLOYEES.aSelf,
    ]);
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "employee_inactive"
    );
  });

  it("an employee already on this shift is not assigned twice", async () => {
    await db.query(
      `insert into public.shift_assignments (company_id, shift_id, employee_id, status)
       values ($1, $2, $3, 'assigned')`,
      [COMPANY_A, A_SHIFT, EMPLOYEES.aSelf]
    );
    // required_count is 1, so this also proves the vacancy check never fires first
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "already_assigned"
    );
  });

  it("an overlapping assignment created after responding blocks approval", async () => {
    const { rows } = await db.query(
      `insert into public.shifts (company_id, job_id, date, start_time, end_time, required_count)
       select company_id, job_id, date, start_time + interval '1 hour', end_time, 1
       from public.shifts where id = $1 returning id`,
      [A_SHIFT]
    );
    await db.query(
      `insert into public.shift_assignments (company_id, shift_id, employee_id, status)
       values ($1, $2, $3, 'accepted')`,
      [COMPANY_A, rows[0].id, EMPLOYEES.aSelf]
    );
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "overlapping_assignment"
    );
    await db.query("delete from public.shifts where id = $1", [rows[0].id]);
  });

  it("the seat check refuses once the shift is full by another route", async () => {
    await db.query(
      `insert into public.shift_assignments (company_id, shift_id, employee_id, status)
       values ($1, $2, $3, 'assigned')`,
      [COMPANY_A, A_SHIFT, EMPLOYEES.aColleague]
    );
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe("no_vacancy");
  });
});

describe("authorization", () => {
  it("an employee calling the function directly is refused", async () => {
    const result = await approveAs(USERS.aWorker, OFFER_RESPONSES.aSelf);
    expect(result.status).toBe("forbidden");

    const { rows } = await db.query(
      "select count(*)::int as c from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("a manager from another tenant cannot even see the response", async () => {
    expect((await approveAs(USERS.bAdmin, OFFER_RESPONSES.aSelf)).status).toBe("not_found");
  });

  it("an employee from another tenant is refused", async () => {
    expect((await approveAs(USERS.bWorker, OFFER_RESPONSES.aSelf)).status).toBe("not_found");
  });

  it("a company admin may approve", async () => {
    expect((await approveAs(USERS.aAdmin, OFFER_RESPONSES.aSelf)).status).toBe("approved");
  });
});

describe("rejection", () => {
  it("stores decision metadata without an assignment", async () => {
    await runAs(
      USERS.aDispatcher,
      (q) =>
        q(
          `update shift_offer_responses set decided_by = $2, decided_at = now()
           where id = $1 and decided_at is null`,
          [OFFER_RESPONSES.aSelf, USERS.aDispatcher]
        ),
      { commit: true }
    );

    const { rows } = await db.query(
      "select decided_by, decided_at, resulting_assignment_id, response from public.shift_offer_responses where id = $1",
      [OFFER_RESPONSES.aSelf]
    );
    // Not selected == decided with no assignment. The response column still
    // records what the employee said, not what the company decided.
    expect(rows[0].decided_by).toBe(USERS.aDispatcher);
    expect(rows[0].decided_at).not.toBeNull();
    expect(rows[0].resulting_assignment_id).toBeNull();
    expect(rows[0].response).toBe("interested");
  });

  it("a rejected response can no longer be approved", async () => {
    await db.query(
      "update public.shift_offer_responses set decided_by = $2, decided_at = now() where id = $1",
      [OFFER_RESPONSES.aSelf, USERS.aDispatcher]
    );
    expect((await approveAs(USERS.aDispatcher, OFFER_RESPONSES.aSelf)).status).toBe(
      "already_decided"
    );
  });

  it("a second rejection updates nothing, so no second notification follows", async () => {
    const first = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (await q(
          `update shift_offer_responses set decided_by = $2, decided_at = now()
           where id = $1 and decided_at is null returning id`,
          [OFFER_RESPONSES.aSelf, USERS.aDispatcher]
        )).rowCount,
      { commit: true }
    );
    const second = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (await q(
          `update shift_offer_responses set decided_by = $2, decided_at = now()
           where id = $1 and decided_at is null returning id`,
          [OFFER_RESPONSES.aSelf, USERS.aDispatcher]
        )).rowCount,
      { commit: true }
    );
    expect(first).toBe(1);
    expect(second).toBe(0);
  });
});

/**
 * Genuine concurrency: two separate connections, both inside open
 * transactions, racing for one seat. The second blocks on the shift row lock
 * until the first commits, then finds no vacancy.
 */
describe("last-seat concurrency", () => {
  /** Runs the approval and remembers which client it belonged to. */
  function tagged(
    client: Client,
    responseId: string,
    label: string
  ): Promise<{ client: Client; label: string; result: ApprovalResult }> {
    return client
      .query("select public.approve_shift_offer($1) as result", [responseId])
      .then((r) => ({ client, label, result: r.rows[0].result as ApprovalResult }));
  }

  it("two managers approving different candidates produce exactly one assignment", async () => {
    const clientA = new Client({ connectionString: DB_URL });
    const clientB = new Client({ connectionString: DB_URL });
    await clientA.connect();
    await clientB.connect();

    try {
      for (const [client, user] of [
        [clientA, USERS.aDispatcher],
        [clientB, USERS.aAdmin],
      ] as const) {
        await client.query("begin");
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: user, role: "authenticated" }),
        ]);
      }

      // Both statements are in flight before either transaction commits.
      // Which one reaches the row lock first is genuinely non-deterministic —
      // it shifts with query planning — so the test must not assume an order.
      // Awaiting a fixed one first would deadlock whenever the other won.
      const inFlight = [
        { client: clientA, promise: tagged(clientA, OFFER_RESPONSES.aSelf, "A") },
        { client: clientB, promise: tagged(clientB, OFFER_RESPONSES.aColleague, "B") },
      ];

      // The winner holds the lock; commit it, which releases the loser.
      const first = await Promise.race(inFlight.map((entry) => entry.promise));
      const winnerEntry = inFlight.find((entry) => entry.client === first.client)!;
      const loserEntry = inFlight.find((entry) => entry.client !== first.client)!;
      await winnerEntry.client.query("commit");

      const second = await loserEntry.promise;
      await loserEntry.client.query("commit");

      const statuses = [first.result.status, second.result.status].sort();
      expect(statuses).toEqual(["approved", "no_vacancy"]);
      expect(first.result.status).toBe("approved");
      expect(first.result.assignment_id).toBeTruthy();
      expect(second.result.status).toBe("no_vacancy");
      expect(second.result.assignment_id).toBeUndefined();
    } finally {
      await clientA.end();
      await clientB.end();
    }

    const { rows: assignments } = await db.query(
      "select id, employee_id from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    expect(assignments).toHaveLength(1);

    const { rows: shift } = await db.query("select status from public.shifts where id = $1", [
      A_SHIFT,
    ]);
    expect(shift[0].status).toBe("staffed");

    const { rows: offer } = await db.query(
      "select status from public.shift_offers where id = $1",
      [OFFERS.a]
    );
    expect(offer[0].status).toBe("filled");

    // The losing response carries no assignment and stays undecided, so a
    // manager can still reject it explicitly.
    const { rows: responses } = await db.query(
      "select id, decided_at, resulting_assignment_id from public.shift_offer_responses where offer_id = $1",
      [OFFERS.a]
    );
    const decided = responses.filter((r) => r.decided_at !== null);
    expect(decided).toHaveLength(1);
    expect(decided[0].resulting_assignment_id).toBe(assignments[0].id);
    const undecided = responses.filter((r) => r.decided_at === null);
    expect(undecided).toHaveLength(1);
    expect(undecided[0].resulting_assignment_id).toBeNull();
  }, 30_000);
});

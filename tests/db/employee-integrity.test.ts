/**
 * Phase D.2 — employee mutation integrity.
 *
 * Everything here is a DIRECT database call as an authenticated employee, not
 * a Server Action. The question is not "does the UI stop this" — it is "does
 * the database stop this when someone talks to Supabase with their own token".
 *
 * Two invariants:
 *
 *   1. The only change an employee may make to a time entry is clocking out.
 *      Not "everything except five fields" — time_entries has 21 columns, and
 *      the clock-in geofence evidence is among the ones a blocklist would have
 *      left writable.
 *
 *   2. shift_assignments.status = 'cancellation_requested' can never exist
 *      without a pending cancellation_requests row behind it.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
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

const DB_NAME = "clockwise_employee_integrity_test";

const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";
const A_ASSIGNMENT_2 = "aaaa4444-0000-0000-0000-000000000009";

const W = USERS.aWorker;

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

/** Did the statement actually change anything? Refusals and 0-row RLS filters both count as "no". */
async function attempt(
  userId: string,
  sql: string,
  params: unknown[] = []
): Promise<{ refused: boolean; rows: number }> {
  return runAs(
    userId,
    async (q) => {
      try {
        const r = await q(sql, params);
        return { refused: false, rows: r.rowCount ?? 0 };
      } catch {
        return { refused: true, rows: 0 };
      }
    },
    { commit: false }
  );
}

/** Neither raised-and-refused nor silently-filtered counts as success. */
function blocked(r: { refused: boolean; rows: number }): boolean {
  return r.refused || r.rows === 0;
}

const rpc = (userId: string, sql: string, params: unknown[]) =>
  runAs(userId, async (q) => (await q(sql, params)).rows[0].r as Record<string, unknown>, {
    commit: true,
  });

/** A running entry owned by worker A. */
async function runningEntry(): Promise<string> {
  await db.query("delete from public.time_entries");
  const { rows } = await db.query(
    `insert into public.time_entries
       (company_id, employee_id, shift_assignment_id, clock_in, status, source,
        clock_in_lat, clock_in_lng, clock_in_distance_m, clock_in_location_status)
     values ($1,$2,$3, now() - interval '2 hours', 'running', 'app',
             54.3233, 10.1394, 820, 'outside_geofence')
     returning id`,
    [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT]
  );
  return rows[0].id as string;
}

/** A completed entry owned by worker A. */
async function completedEntry(): Promise<string> {
  const id = await runningEntry();
  await db.query(
    "update public.time_entries set clock_out = now() - interval '1 hour', status = 'completed' where id = $1",
    [id]
  );
  return id;
}

async function reset() {
  await db.query("delete from public.time_entries");
  await db.query("delete from public.cancellation_requests");
  await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
  await db.query(
    `update public.shifts
     set required_count = 2, status = 'open',
         start_time = now() - interval '1 hour',
         end_time = now() + interval '7 hours'
     where id = $1`,
    [A_SHIFT]
  );
  await db.query(
    `insert into public.shift_assignments (id, company_id, shift_id, employee_id, status)
     values ($1,$2,$3,$4,'assigned')`,
    [A_ASSIGNMENT, COMPANY_A, A_SHIFT, EMPLOYEES.aSelf]
  );
  await db.query(
    `insert into public.shift_assignments (id, company_id, shift_id, employee_id, status)
     values ($1,$2,$3,$4,'assigned')`,
    [A_ASSIGNMENT_2, COMPANY_A, A_SHIFT, EMPLOYEES.aColleague]
  );
  await db.query("update public.shift_offers set status='open', closed_at=null where id=$1", [
    OFFERS.a,
  ]);
  await db.query(
    `update public.shift_offer_responses
     set response='interested', responded_at=now(), decided_by=null, decided_at=null,
         resulting_assignment_id=null
     where offer_id = $1`,
    [OFFERS.a]
  );
  await db.query("update public.employees set employment_status='active' where company_id=$1", [
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
  await reset();
});

/* ===================================================================== */
describe("time entries — what an employee may do", () => {
  it("can clock in", async () => {
    await db.query("delete from public.time_entries");
    const id = await runAs(
      W,
      async (q) =>
        (
          await q(
            `insert into public.time_entries (company_id, employee_id, shift_assignment_id, clock_in, status)
             values ($1,$2,$3, now(), 'running') returning id`,
            [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT]
          )
        ).rows[0].id as string,
      { commit: true }
    );
    expect(id).toBeTruthy();
  });

  it("can clock out — exactly the columns the application writes", async () => {
    const id = await runningEntry();
    const r = await runAs(
      W,
      async (q) =>
        (
          await q(
            `update public.time_entries
             set clock_out = now(), status = 'completed',
                 clock_out_lat = 54.3, clock_out_lng = 10.1,
                 clock_out_accuracy_m = 12, clock_out_distance_m = 40,
                 clock_out_location_status = 'verified'
             where id = $1`,
            [id]
          )
        ).rowCount,
      { commit: true }
    );
    expect(r).toBe(1);

    const { rows } = await db.query("select status, clock_out from public.time_entries where id=$1", [
      id,
    ]);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].clock_out).not.toBeNull();
  });

  it("can read their own entries and not a colleague's", async () => {
    await completedEntry();
    await db.query(
      `insert into public.time_entries (company_id, employee_id, clock_in, status)
       values ($1,$2, now(), 'running')`,
      [COMPANY_A, EMPLOYEES.aColleague]
    );

    const visible = await runAs(
      W,
      async (q) =>
        Number((await q("select count(*)::int c from public.time_entries")).rows[0].c),
      { commit: false }
    );
    expect(visible).toBe(1);
  });
});

/* ===================================================================== */
describe("time entries — a RUNNING entry is not a loophole", () => {
  /**
   * The whole point of D.2: the row policy permits touching a live entry, so
   * every one of these has to be stopped by the transition trigger instead.
   */
  const forbidden: Array<[string, string]> = [
    ["rewrite clock_in", "clock_in = clock_in - interval '4 hours'"],
    ["change shift_assignment_id", "shift_assignment_id = null"],
    ["change source to manual", "source = 'manual'"],
    ["change company_id", `company_id = '22222222-0000-0000-0000-000000000000'`],
    ["forge the clock-in verification", "clock_in_location_status = 'verified'"],
    ["move the clock-in coordinates", "clock_in_lat = 0, clock_in_lng = 0"],
    ["erase the clock-in distance", "clock_in_distance_m = 0"],
    ["change the location note", "location_note = 'war doch da'"],
    ["back-date created_at", "created_at = now() - interval '10 days'"],
  ];

  for (const [label, setClause] of forbidden) {
    it(`cannot ${label}, even while clocking out`, async () => {
      const id = await runningEntry();
      // Bundled with a legitimate clock-out, which is the realistic attack:
      // the transition is valid, the smuggled column change is not.
      const r = await attempt(
        W,
        `update public.time_entries
         set clock_out = now(), status = 'completed', ${setClause}
         where id = $1`,
        [id]
      );
      expect(blocked(r)).toBe(true);

      const { rows } = await db.query("select status from public.time_entries where id=$1", [id]);
      expect(rows[0].status).toBe("running");
    });
  }

  it("cannot change employee_id — ownership is the one thing RLS already caught", async () => {
    const id = await runningEntry();
    const r = await attempt(
      W,
      "update public.time_entries set employee_id = $2 where id = $1",
      [id, EMPLOYEES.aColleague]
    );
    expect(blocked(r)).toBe(true);
  });

  it("cannot make a partial update that is not a clock-out at all", async () => {
    const id = await runningEntry();
    expect(blocked(await attempt(W, "update public.time_entries set status='completed' where id=$1", [id])))
      .toBe(true); // no clock_out
    expect(
      blocked(await attempt(W, "update public.time_entries set clock_out=now() where id=$1", [id]))
    ).toBe(true); // status left running
    expect(
      blocked(
        await attempt(W, "update public.time_entries set status='approved', clock_out=now() where id=$1", [
          id,
        ])
      )
    ).toBe(true); // not the clock-out transition
  });
});

/* ===================================================================== */
describe("time entries — history is closed", () => {
  it("cannot rewrite the clock_out of a completed entry", async () => {
    const id = await completedEntry();
    expect(
      blocked(
        await attempt(
          W,
          "update public.time_entries set clock_out = clock_out + interval '3 hours' where id=$1",
          [id]
        )
      )
    ).toBe(true);
  });

  it("cannot flip a completed entry back to running", async () => {
    const id = await completedEntry();
    expect(
      blocked(
        await attempt(
          W,
          "update public.time_entries set status='running', clock_out=null where id=$1",
          [id]
        )
      )
    ).toBe(true);
  });

  it("cannot touch a completed entry at all", async () => {
    const id = await completedEntry();
    expect(
      blocked(await attempt(W, "update public.time_entries set location_note='x' where id=$1", [id]))
    ).toBe(true);
  });

  it("cannot delete a time entry, running or completed", async () => {
    const running = await runningEntry();
    expect(blocked(await attempt(W, "delete from public.time_entries where id=$1", [running]))).toBe(
      true
    );

    const done = await completedEntry();
    expect(blocked(await attempt(W, "delete from public.time_entries where id=$1", [done]))).toBe(
      true
    );

    const { rows } = await db.query("select count(*)::int c from public.time_entries");
    expect(Number(rows[0].c)).toBe(1);
  });

  it("cannot touch a colleague's or another tenant's entry", async () => {
    const { rows } = await db.query(
      `insert into public.time_entries (company_id, employee_id, clock_in, status)
       values ($1,$2, now(), 'running') returning id`,
      [COMPANY_A, EMPLOYEES.aColleague]
    );
    const colleague = rows[0].id as string;

    expect(
      blocked(
        await attempt(W, "update public.time_entries set clock_out=now(), status='completed' where id=$1", [
          colleague,
        ])
      )
    ).toBe(true);
    expect(blocked(await attempt(W, "delete from public.time_entries where id=$1", [colleague]))).toBe(
      true
    );

    expect(
      blocked(
        await attempt(USERS.bWorker, "update public.time_entries set clock_in=now() where id=$1", [
          colleague,
        ])
      )
    ).toBe(true);
  });
});

/* ===================================================================== */
describe("time entries — manager workflows unchanged", () => {
  it("a manager can still create a manual entry and correct one", async () => {
    const id = await completedEntry();

    const corrected = await attempt(
      USERS.aDispatcher,
      "update public.time_entries set clock_in = clock_in - interval '15 minutes' where id=$1",
      [id]
    );
    expect(corrected.rows).toBe(1);

    const inserted = await attempt(
      USERS.aDispatcher,
      `insert into public.time_entries (company_id, employee_id, shift_assignment_id, clock_in, source, status)
       values ($1,$2,$3, now(), 'manual', 'running')`,
      [COMPANY_A, EMPLOYEES.aColleague, A_ASSIGNMENT_2]
    );
    expect(inserted.rows).toBe(1);
  });
});

/* ===================================================================== */
describe("assignments — parking requires a request", () => {
  it("an employee cannot park their own assignment directly", async () => {
    for (const from of ["assigned", "accepted"]) {
      await db.query("update public.shift_assignments set status=$2 where id=$1", [
        A_ASSIGNMENT,
        from,
      ]);
      const r = await attempt(
        W,
        "update public.shift_assignments set status='cancellation_requested' where id=$1",
        [A_ASSIGNMENT]
      );
      expect(blocked(r), `${from} → cancellation_requested must be refused`).toBe(true);

      const { rows } = await db.query("select status from public.shift_assignments where id=$1", [
        A_ASSIGNMENT,
      ]);
      expect(rows[0].status).toBe(from);
    }
  });

  it("a manager cannot park someone either — the invariant is universal", async () => {
    const r = await attempt(
      USERS.aDispatcher,
      "update public.shift_assignments set status='cancellation_requested' where id=$1",
      [A_ASSIGNMENT]
    );
    expect(blocked(r)).toBe(true);
  });

  it("the RPC still works and produces exactly one pending request", async () => {
    const result = await rpc(W, "select public.request_shift_cancellation($1,$2) as r", [
      A_ASSIGNMENT,
      "Arzttermin am Morgen",
    ]);
    expect(result.status).toBe("requested");

    const { rows: reqs } = await db.query(
      "select count(*)::int c from public.cancellation_requests where shift_assignment_id=$1 and status='pending'",
      [A_ASSIGNMENT]
    );
    expect(Number(reqs[0].c)).toBe(1);

    const { rows: asg } = await db.query(
      "select status from public.shift_assignments where id=$1",
      [A_ASSIGNMENT]
    );
    expect(asg[0].status).toBe("cancellation_requested");
  });

  it("no parked assignment can exist without its request", async () => {
    await rpc(W, "select public.request_shift_cancellation($1,$2) as r", [
      A_ASSIGNMENT,
      "Arzttermin",
    ]);
    const { rows } = await db.query(
      `select count(*)::int c
       from public.shift_assignments sa
       where sa.status = 'cancellation_requested'
         and not exists (
           select 1 from public.cancellation_requests cr
           where cr.shift_assignment_id = sa.id and cr.status = 'pending')`
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("an employee cannot alter a colleague's assignment", async () => {
    const r = await attempt(W, "update public.shift_assignments set status='accepted' where id=$1", [
      A_ASSIGNMENT_2,
    ]);
    expect(blocked(r)).toBe(true);
  });

  it("cancelled and completed assignments stay closed to the employee", async () => {
    for (const status of ["cancelled", "completed"]) {
      await db.query("update public.shift_assignments set status=$2 where id=$1", [
        A_ASSIGNMENT,
        status,
      ]);
      expect(
        blocked(
          await attempt(W, "update public.shift_assignments set status='accepted' where id=$1", [
            A_ASSIGNMENT,
          ])
        )
      ).toBe(true);
    }
  });

  it("accepting an assignment still works", async () => {
    const r = await attempt(W, "update public.shift_assignments set status='accepted' where id=$1", [
      A_ASSIGNMENT,
    ]);
    expect(r.rows).toBe(1);
  });
});

/* ===================================================================== */
describe("manager flows over the new invariant", () => {
  async function park(): Promise<string> {
    await rpc(W, "select public.request_shift_cancellation($1,$2) as r", [
      A_ASSIGNMENT,
      "Kind krank",
    ]);
    const { rows } = await db.query(
      "select id from public.cancellation_requests where shift_assignment_id=$1",
      [A_ASSIGNMENT]
    );
    return rows[0].id as string;
  }

  it("approval still frees the seat", async () => {
    const req = await park();
    const r = await rpc(USERS.aDispatcher, "select public.decide_cancellation_request($1,true) as r", [
      req,
    ]);
    expect(r.status).toBe("approved");
    const { rows } = await db.query("select status from public.shift_assignments where id=$1", [
      A_ASSIGNMENT,
    ]);
    expect(rows[0].status).toBe("cancelled");
  });

  it("rejection still restores the assignment", async () => {
    const req = await park();
    const r = await rpc(
      USERS.aDispatcher,
      "select public.decide_cancellation_request($1,false) as r",
      [req]
    );
    expect(r.status).toBe("rejected");
    const { rows } = await db.query("select status from public.shift_assignments where id=$1", [
      A_ASSIGNMENT,
    ]);
    expect(rows[0].status).toBe("assigned");
  });

  it("removal still settles a parked assignment", async () => {
    await park();
    const r = await rpc(USERS.aDispatcher, "select public.remove_shift_assignment($1,$2) as r", [
      A_ASSIGNMENT,
      "Kundenwunsch",
    ]);
    expect(r.status).toBe("removed");
    expect(r.resolved_request).toBe(true);
  });

  it("shift cancellation still settles everything", async () => {
    await park();
    await db.query("delete from public.time_entries");
    const r = await rpc(USERS.aDispatcher, "select public.cancel_shift($1,$2) as r", [
      A_SHIFT,
      "Auftrag storniert",
    ]);
    expect(r.status).toBe("cancelled");
    expect(Number(r.requests_settled)).toBe(1);
  });

  it("offer approval and capacity still behave", async () => {
    await db.query("delete from public.shift_assignments where shift_id=$1", [A_SHIFT]);
    await db.query("update public.shifts set required_count=1 where id=$1", [A_SHIFT]);
    await db.query(
      "update public.shifts set start_time = now() + interval '2 days', end_time = now() + interval '2 days 8 hours' where id=$1",
      [A_SHIFT]
    );

    const approved = await rpc(USERS.aDispatcher, "select public.approve_shift_offer($1) as r", [
      OFFER_RESPONSES.aSelf,
    ]);
    expect(approved.status).toBe("approved");

    const { rows } = await db.query("select status from public.shifts where id=$1", [A_SHIFT]);
    expect(rows[0].status).toBe("staffed");
  });
});

/**
 * Phase D.1 — the scheduling authorization boundary, and the immutability of
 * staffing history.
 *
 * Two claims are proved here, both positively and negatively:
 *
 *   1. Staffing history cannot be physically deleted by anyone — authenticated
 *      roles, service_role, or the table owner — without a deliberate session
 *      flag. Cancellation and removal change status; nothing erases rows.
 *
 *   2. An HR manager can read the schedule and cannot change it, while every
 *      dispatcher workflow and every employee self-service workflow keeps
 *      working exactly as before.
 *
 * The negative tests matter more than the positive ones, so each is written to
 * fail loudly if the protection is widened again — see the tamper list in the
 * phase report.
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

const DB_NAME = "clockwise_authorization_test";
const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);

const A_JOB = "aaaa2222-0000-0000-0000-000000000001";
const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";

/** aAdmin is re-roled to HR_MANAGER for this suite: HR is the subject here. */
const HR = USERS.aAdmin;

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

/** Attempt a statement; report whether it was permitted AND affected a row. */
async function attempt(
  userId: string,
  sql: string,
  params: unknown[] = []
): Promise<{ allowed: boolean; rows: number }> {
  return runAs(
    userId,
    async (q) => {
      try {
        const r = await q(sql, params);
        return { allowed: true, rows: r.rowCount ?? 0 };
      } catch {
        return { allowed: false, rows: 0 };
      }
    },
    { commit: false }
  );
}

const rpc = (userId: string, sql: string, params: unknown[]) =>
  runAs(
    userId,
    async (q) => (await q(sql, params)).rows[0].r as { status: string },
    { commit: true }
  );

async function counts(): Promise<Record<string, number>> {
  const tables = [
    "jobs",
    "shifts",
    "shift_assignments",
    "shift_offers",
    "shift_offer_responses",
    "cancellation_requests",
    "attendance_alerts",
    "time_entries",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = Number((await db.query(`select count(*)::int c from public.${t}`)).rows[0].c);
  }
  return out;
}

async function reset() {
  await db.query("delete from public.attendance_alerts");
  await db.query("delete from public.time_entries");
  await db.query("delete from public.cancellation_requests");
  await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
  await db.query(
    `update public.shifts
     set required_count = 2, status = 'open',
         start_time = now() + interval '3 days',
         end_time = now() + interval '3 days 8 hours'
     where id = $1`,
    [A_SHIFT]
  );
  await db.query(
    `insert into public.shift_assignments (id, company_id, shift_id, employee_id, status)
     values ($1,$2,$3,$4,'assigned')`,
    [A_ASSIGNMENT, COMPANY_A, A_SHIFT, EMPLOYEES.aSelf]
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
  // One of each so the HR readability check is meaningful rather than vacuous.
  await db.query(
    `insert into public.cancellation_requests (company_id, shift_assignment_id, reason)
     values ($1,$2,'Bestandsprobe')`,
    [COMPANY_A, A_ASSIGNMENT]
  );
}

beforeAll(async () => {
  db = await createTestDatabase(DB_NAME);
  await db.query("update public.company_memberships set role='HR_MANAGER' where profile_id=$1", [
    HR,
  ]);
}, 60_000);

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await reset();
});

/* ===================================================================== */
describe("history cannot be deleted", () => {
  const targets: Array<[string, string, unknown[]]> = [
    ["jobs", "delete from public.jobs where id = $1", [A_JOB]],
    ["shifts", "delete from public.shifts where id = $1", [A_SHIFT]],
    [
      "shift_assignments",
      "delete from public.shift_assignments where id = $1",
      [A_ASSIGNMENT],
    ],
  ];

  /** The row is still there afterwards — the only invariant that matters. */
  async function stillExists(table: string, id: unknown): Promise<boolean> {
    const { rows } = await db.query(
      `select count(*)::int c from public.${table} where id = $1`,
      [id]
    );
    return Number(rows[0].c) === 1;
  }

  for (const [table, sql, params] of targets) {
    // For an authenticated caller the DELETE is stopped by RLS before the
    // trigger is reached: no policy grants DELETE any more, so the statement
    // matches no rows and returns quietly. Nothing is removed either way, and
    // the row-survives assertion is what proves it.
    it(`an HR manager cannot delete ${table}`, async () => {
      expect((await attempt(HR, sql, params)).rows).toBe(0);
      expect(await stillExists(table, params[0])).toBe(true);
    });

    it(`a dispatcher cannot delete ${table}`, async () => {
      expect((await attempt(USERS.aDispatcher, sql, params)).rows).toBe(0);
      expect(await stillExists(table, params[0])).toBe(true);
    });

    it(`an employee cannot delete ${table}`, async () => {
      expect((await attempt(USERS.aWorker, sql, params)).rows).toBe(0);
      expect(await stillExists(table, params[0])).toBe(true);
    });

    it(`the table owner cannot delete ${table} without the flag`, async () => {
      // The owner bypasses RLS entirely; only the trigger stops it. This is
      // the case a DELETE policy would have missed.
      const own = new Client({ connectionString: DB_URL });
      await own.connect();
      try {
        await expect(own.query(sql, params)).rejects.toThrow(/not permitted/);
      } finally {
        await own.end();
      }
    });

    it(`service_role cannot delete ${table} without the flag`, async () => {
      // service_role is BYPASSRLS, which is exactly why this is a trigger and
      // not a policy: the application uses a service-role client for
      // notification fan-out and the attendance runner.
      const svc = new Client({ connectionString: DB_URL });
      await svc.connect();
      try {
        await svc.query("set local role service_role");
        await expect(svc.query(sql, params)).rejects.toThrow(/not permitted/);
      } finally {
        await svc.end();
      }
    });
  }

  /**
   * Each guard has to earn its place. With an assignment present, deleting a
   * job or a shift cascades into shift_assignments and is stopped by THAT
   * trigger — so these cases use empty rows, where only the guard on the table
   * itself can refuse.
   */
  it("an empty shift is still undeletable — the shift guard, on its own", async () => {
    const { rows } = await db.query(
      `insert into public.shifts (company_id, job_id, date, start_time, end_time, required_count)
       values ($1,$2,current_date, now() + interval '9 days', now() + interval '9 days 8 hours', 1)
       returning id`,
      [COMPANY_A, A_JOB]
    );
    const empty = rows[0].id as string;

    const own = new Client({ connectionString: DB_URL });
    await own.connect();
    try {
      await expect(
        own.query("delete from public.shifts where id = $1", [empty])
      ).rejects.toThrow(/not permitted/);
    } finally {
      await own.end();
    }
    expect(await stillExists("shifts", empty)).toBe(true);
  });

  it("an empty job is still undeletable — the job guard, on its own", async () => {
    const { rows } = await db.query(
      `insert into public.jobs (company_id, client_name) values ($1,'Leerer Kunde') returning id`,
      [COMPANY_A]
    );
    const empty = rows[0].id as string;

    const own = new Client({ connectionString: DB_URL });
    await own.connect();
    try {
      await expect(own.query("delete from public.jobs where id = $1", [empty])).rejects.toThrow(
        /not permitted/
      );
    } finally {
      await own.end();
    }
    expect(await stillExists("jobs", empty)).toBe(true);
  });

  it("a refused delete leaves every dependent row untouched", async () => {
    await db.query(
      `insert into public.attendance_alerts (company_id, employee_id, shift_assignment_id, type, minutes_delta, scheduled_start, scheduled_end)
       select $1,$2,$3,'no_show',5,start_time,end_time from public.shifts where id=$4`,
      [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT, A_SHIFT]
    );
    const before = await counts();
    for (const [, sql, params] of targets) {
      await attempt(USERS.aDispatcher, sql, params);
    }
    expect(await counts()).toEqual(before);
  });

  it("worked time can never be orphaned by a delete", async () => {
    await db.query(
      `insert into public.time_entries (company_id, employee_id, shift_assignment_id, clock_in, status)
       values ($1,$2,$3, now(), 'running')`,
      [COMPANY_A, EMPLOYEES.aSelf, A_ASSIGNMENT]
    );

    for (const [, sql, params] of targets) {
      await attempt(USERS.aDispatcher, sql, params);
    }

    const { rows } = await db.query(
      "select count(*)::int c from public.time_entries where shift_assignment_id is null"
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("the maintenance flag is the only way through, and is per-session", async () => {
    const maint = new Client({ connectionString: DB_URL });
    await maint.connect();
    try {
      await maint.query("begin");
      await maint.query("set local app.allow_history_delete = 'on'");
      const r = await maint.query("delete from public.shift_assignments where id = $1", [
        A_ASSIGNMENT,
      ]);
      expect(r.rowCount).toBe(1);
      await maint.query("rollback");

      // Without the flag the same connection is protected again.
      await expect(
        maint.query("delete from public.shift_assignments where id = $1", [A_ASSIGNMENT])
      ).rejects.toThrow(/not permitted/);
    } finally {
      await maint.end();
    }
  });

  it("cancelling still works — history is transitioned, not erased", async () => {
    const before = await counts();
    const result = await rpc(USERS.aDispatcher, "select public.cancel_shift($1,$2) as r", [
      A_SHIFT,
      "Kunde hat abgesagt",
    ]);
    expect(result.status).toBe("cancelled");

    const after = await counts();
    expect(after.shifts).toBe(before.shifts);
    expect(after.shift_assignments).toBe(before.shift_assignments);
    expect(after.shift_offer_responses).toBe(before.shift_offer_responses);
  });
});

/* ===================================================================== */
describe("HR_MANAGER — reads the schedule, cannot change it", () => {
  it("can still read everything the manager surfaces need", async () => {
    for (const table of [
      "shifts",
      "shift_assignments",
      "shift_offers",
      "shift_offer_responses",
      "cancellation_requests",
      "employees",
      "jobs",
      "locations",
    ]) {
      const n = await runAs(
        HR,
        async (q) =>
          Number((await q(`select count(*)::int c from public.${table}`)).rows[0].c),
        { commit: false }
      );
      expect(n, `${table} must stay readable for HR`).toBeGreaterThan(0);
    }
  });

  it("cannot insert, update or delete a shift", async () => {
    expect(
      (
        await attempt(
          HR,
          `insert into public.shifts (company_id, job_id, date, start_time, end_time, required_count)
           values ($1,$2,current_date,now()+interval '5 days',now()+interval '5 days 8 hours',1)`,
          [COMPANY_A, A_JOB]
        )
      ).rows
    ).toBe(0);

    expect(
      (await attempt(HR, "update public.shifts set required_count = 99 where id = $1", [A_SHIFT]))
        .rows
    ).toBe(0);

    expect((await attempt(HR, "delete from public.shifts where id = $1", [A_SHIFT])).rows).toBe(0);
  });

  it("cannot insert, update or delete an assignment", async () => {
    expect(
      (
        await attempt(
          HR,
          `insert into public.shift_assignments (company_id, shift_id, employee_id, status)
           values ($1,$2,$3,'assigned')`,
          [COMPANY_A, A_SHIFT, EMPLOYEES.aColleague]
        )
      ).rows
    ).toBe(0);

    expect(
      (
        await attempt(HR, "update public.shift_assignments set status='cancelled' where id = $1", [
          A_ASSIGNMENT,
        ])
      ).rows
    ).toBe(0);

    expect(
      (await attempt(HR, "delete from public.shift_assignments where id = $1", [A_ASSIGNMENT])).rows
    ).toBe(0);
  });

  it("cannot approve an offer, even by calling the function directly", async () => {
    await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
    const result = await rpc(HR, "select public.approve_shift_offer($1) as r", [
      OFFER_RESPONSES.aSelf,
    ]);
    expect(result.status).toBe("forbidden");

    const { rows } = await db.query(
      "select count(*)::int c from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("cannot decide a cancellation request", async () => {
    // The request already exists from reset(); 0013 requires it to exist
    // BEFORE the assignment can be parked.
    const { rows } = await db.query(
      "select id from public.cancellation_requests where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    await db.query("update public.shift_assignments set status='cancellation_requested' where id=$1", [
      A_ASSIGNMENT,
    ]);

    const result = await rpc(HR, "select public.decide_cancellation_request($1,true) as r", [
      rows[0].id,
    ]);
    expect(result.status).toBe("forbidden");

    const check = await db.query(
      "select status from public.cancellation_requests where id = $1",
      [rows[0].id]
    );
    expect(check.rows[0].status).toBe("pending");
  });

  it("cannot remove an assignment", async () => {
    const result = await rpc(HR, "select public.remove_shift_assignment($1,$2) as r", [
      A_ASSIGNMENT,
      "HR versucht es",
    ]);
    expect(result.status).toBe("forbidden");

    const { rows } = await db.query("select status from public.shift_assignments where id = $1", [
      A_ASSIGNMENT,
    ]);
    expect(rows[0].status).toBe("assigned");
  });

  it("cannot create, edit or cancel a shift through the Phase D functions", async () => {
    const create = await rpc(
      HR,
      `select public.create_shift($1, now() + interval '5 days', now() + interval '5 days 8 hours', 1, null, null, null, null) as r`,
      [A_JOB]
    );
    expect(create.status).toBe("forbidden");

    // update_shift and cancel_shift lock the shift row first, and the UPDATE
    // policy no longer admits HR — so they are stopped one layer earlier.
    const update = await rpc(HR, "select public.update_shift($1,$2::jsonb,true) as r", [
      A_SHIFT,
      JSON.stringify({ instructions: "HR war hier" }),
    ]);
    expect(["forbidden", "not_found"]).toContain(update.status);

    const cancel = await rpc(HR, "select public.cancel_shift($1,$2) as r", [A_SHIFT, "HR sagt ab"]);
    expect(["forbidden", "not_found"]).toContain(cancel.status);

    const { rows } = await db.query("select status, instructions from public.shifts where id=$1", [
      A_SHIFT,
    ]);
    expect(rows[0].status).not.toBe("cancelled");
    expect(rows[0].instructions).not.toBe("HR war hier");
  });

  it("keeps the writes that genuinely belong to HR", async () => {
    // employees.manage and documents.manage are HR permissions; nothing here
    // narrowed them.
    expect(
      (
        await attempt(HR, "update public.employees set position = 'Teamleitung' where id = $1", [
          EMPLOYEES.aSelf,
        ])
      ).rows
    ).toBe(1);

    expect(
      (
        await attempt(
          HR,
          `insert into public.employee_qualifications (company_id, employee_id, name)
           values ($1,$2,'Erste Hilfe')`,
          [COMPANY_A, EMPLOYEES.aSelf]
        )
      ).rows
    ).toBe(1);
  });
});

/* ===================================================================== */
describe("DISPATCHER — every scheduling workflow still works", () => {
  const D = USERS.aDispatcher;

  it("creates, edits and cancels a shift", async () => {
    const created = await rpc(
      D,
      `select public.create_shift($1, now() + interval '6 days', now() + interval '6 days 8 hours', 2, null, null, 'Hinweis', null) as r`,
      [A_JOB]
    );
    expect(created.status).toBe("created");
    const newShift = (created as unknown as { shift_id: string }).shift_id;

    const updated = await rpc(D, "select public.update_shift($1,$2::jsonb,false) as r", [
      newShift,
      JSON.stringify({ required_count: 3 }),
    ]);
    expect(updated.status).toBe("updated");

    const cancelled = await rpc(D, "select public.cancel_shift($1,$2) as r", [
      newShift,
      "Nicht mehr benötigt",
    ]);
    expect(cancelled.status).toBe("cancelled");
  });

  it("sends an offer and approves it into an assignment", async () => {
    await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);

    // The offer insert is the dispatcher's own write, as in sendShiftOffer.
    const offer = await attempt(
      D,
      "update public.shift_offers set message = 'Bitte melden' where id = $1",
      [OFFERS.a]
    );
    expect(offer.rows).toBe(1);

    const approved = await rpc(D, "select public.approve_shift_offer($1) as r", [
      OFFER_RESPONSES.aSelf,
    ]);
    expect(approved.status).toBe("approved");

    const { rows } = await db.query(
      "select count(*)::int c from public.shift_assignments where shift_id = $1",
      [A_SHIFT]
    );
    expect(Number(rows[0].c)).toBe(1);
  });

  it("decides an employee cancellation request", async () => {
    await db.query("delete from public.cancellation_requests");
    const requested = await rpc(
      USERS.aWorker,
      "select public.request_shift_cancellation($1,$2) as r",
      [A_ASSIGNMENT, "Kind krank"]
    );
    expect(requested.status).toBe("requested");

    const { rows } = await db.query(
      "select id from public.cancellation_requests where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    const decided = await rpc(D, "select public.decide_cancellation_request($1,false) as r", [
      rows[0].id,
    ]);
    expect(decided.status).toBe("rejected");
  });

  it("removes an assignment", async () => {
    const removed = await rpc(D, "select public.remove_shift_assignment($1,$2) as r", [
      A_ASSIGNMENT,
      "Kundenwunsch",
    ]);
    expect(removed.status).toBe("removed");
  });

  it("decides a manual clock-in request", async () => {
    const { rows } = await db.query(
      `insert into public.manual_clockin_requests (company_id, shift_assignment_id, employee_id, reason)
       values ($1,$2,$3,'gps_inaccurate') returning id`,
      [COMPANY_A, A_ASSIGNMENT, EMPLOYEES.aSelf]
    );
    const updated = await attempt(
      D,
      "update public.manual_clockin_requests set status='approved' where id = $1",
      [rows[0].id]
    );
    expect(updated.rows).toBe(1);
  });

  it("still cannot delete history", async () => {
    expect(
      (await attempt(D, "delete from public.shift_assignments where id = $1", [A_ASSIGNMENT])).rows
    ).toBe(0);
    const { rows } = await db.query(
      "select count(*)::int c from public.shift_assignments where id = $1",
      [A_ASSIGNMENT]
    );
    expect(Number(rows[0].c)).toBe(1);
  });
});

/* ===================================================================== */
describe("EMPLOYEE — self-service intact, scheduling closed", () => {
  const W = USERS.aWorker;

  it("sees the shift they are assigned to and the one they were offered", async () => {
    const assigned = await runAs(
      W,
      async (q) =>
        Number(
          (await q("select count(*)::int c from public.shifts where id = $1", [A_SHIFT])).rows[0].c
        ),
      { commit: false }
    );
    expect(assigned).toBe(1);
  });

  it("responds to an offer", async () => {
    const updated = await attempt(
      W,
      "update public.shift_offer_responses set response='declined', responded_at=now() where id=$1",
      [OFFER_RESPONSES.aSelf]
    );
    expect(updated.rows).toBe(1);
  });

  it("requests a cancellation and clocks in and out", async () => {
    await db.query("delete from public.cancellation_requests");
    const requested = await rpc(W, "select public.request_shift_cancellation($1,$2) as r", [
      A_ASSIGNMENT,
      "Arzttermin",
    ]);
    expect(requested.status).toBe("requested");

    // Clock-in stays possible while a decision is pending: the seat is still
    // theirs, so they are still expected on site.
    await db.query(
      "update public.shifts set start_time = now() - interval '1 hour' where id = $1",
      [A_SHIFT]
    );
    const clockIn = await runAs(
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
    expect(clockIn).toBeTruthy();

    const clockOut = await attempt(
      W,
      "update public.time_entries set clock_out = now(), status='completed' where id = $1",
      [clockIn]
    );
    expect(clockOut.rows).toBe(1);
  });

  it("cannot write scheduling tables directly", async () => {
    for (const [sql, params] of [
      [
        `insert into public.shifts (company_id, job_id, date, start_time, end_time, required_count)
         values ($1,$2,current_date,now()+interval '5 days',now()+interval '5 days 8 hours',1)`,
        [COMPANY_A, A_JOB],
      ],
      ["update public.shifts set required_count = 9 where id = $1", [A_SHIFT]],
      [
        `insert into public.shift_assignments (company_id, shift_id, employee_id, status)
         values ($1,$2,$3,'assigned')`,
        [COMPANY_A, A_SHIFT, EMPLOYEES.aColleague],
      ],
    ] as Array<[string, unknown[]]>) {
      const r = await attempt(W, sql, params);
      expect(r.rows).toBe(0);
    }
  });

  it("cannot approve their own offer or remove themselves", async () => {
    expect(
      (await rpc(W, "select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aSelf])).status
    ).toBe("forbidden");
    expect(
      (
        await rpc(W, "select public.remove_shift_assignment($1,$2) as r", [
          A_ASSIGNMENT,
          "selbst",
        ])
      ).status
    ).toBe("forbidden");
  });
});

/* ===================================================================== */
describe("cross-tenant isolation is unchanged", () => {
  it("another company's manager sees and changes nothing", async () => {
    const seen = await runAs(
      USERS.bAdmin,
      async (q) =>
        Number(
          (await q("select count(*)::int c from public.shifts where id = $1", [A_SHIFT])).rows[0].c
        ),
      { commit: false }
    );
    expect(seen).toBe(0);

    expect(
      (
        await attempt(USERS.bAdmin, "update public.shifts set required_count=9 where id=$1", [
          A_SHIFT,
        ])
      ).rows
    ).toBe(0);

    expect(
      (await rpc(USERS.bAdmin, "select public.remove_shift_assignment($1,$2) as r", [
        A_ASSIGNMENT,
        "fremd",
      ])).status
    ).toBe("not_found");
  });
});

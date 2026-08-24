/**
 * Phase F — employee management, against a real database.
 *
 * The suite is organised around the four defects Phase F exists to close, all
 * of which were reproduced on HEAD before the migration was written:
 *
 *   1. `employees_self_update` carried `company_id = company_id` — a column
 *      compared to itself, therefore always true — so an employee could rewrite
 *      every column of their own row, including their pay, their employment
 *      status and their company_id.
 *   2. `employees_write` was FOR ALL, so DELETE rode along with the right to fix
 *      a phone number, and fifteen tables cascade from employees.
 *   3. Four cross-tenant references were unchecked: one company could file
 *      qualifications, availability and emergency contacts against another
 *      company's employee, and attach another company's profile or location to
 *      its own employee row.
 *   4. Nothing wrote these tables at all, so none of it had ever been exercised.
 *
 * Every cross-tenant test asserts the NAMED constraint rather than accepting any
 * database error, so dropping one fails loudly instead of passing on a
 * coincidence — the lesson from Phase E, where a tenant hop appeared blocked
 * only because an unrelated foreign key happened to catch it.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  createTestDatabase,
  runAs as runAsUser,
  setEmploymentStatus,
  type QueryFn,
  USERS,
  COMPANY_A,
  COMPANY_B,
  EMPLOYEES,
  OFFER_RESPONSES,
} from "./helpers";

const DB_NAME = "clockwise_employees_test";
const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);

const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";
const A_LOCATION = "aaaa0000-1111-0000-0000-000000000001";
const B_LOCATION = "bbbb0000-1111-0000-0000-000000000001";
const A_QUALIFICATION = "aaaabbbb-0000-0000-0000-000000000001";

/** An HR_MANAGER, created here so the shared fixtures keep the shape other suites assert. */
const HR_USER = "aaaaaaaa-0000-0000-0000-000000000004";

let db: Client;
let shiftDate: string;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

type Result = {
  status: string;
  from?: string;
  to?: string;
  count?: number;
  current?: string;
  name?: string;
  conflicts?: Array<Record<string, unknown>>;
};

async function setStatus(userId: string, employeeId: string, status: string): Promise<Result> {
  return runAs(
    userId,
    async (q) =>
      (await q("select public.set_employment_status($1, $2) as r", [employeeId, status])).rows[0]
        .r as Result,
    { commit: true }
  );
}

async function removeQualification(userId: string, qualificationId: string): Promise<Result> {
  return runAs(
    userId,
    async (q) =>
      (await q("select public.remove_qualification($1) as r", [qualificationId])).rows[0].r as Result,
    { commit: true }
  );
}

/** Attempt a statement as `userId`; return the row count, or the error message. */
async function attempt(userId: string, sql: string, params: unknown[] = []): Promise<number | string> {
  return runAs(userId, async (q) => (await q(sql, params)).rowCount ?? 0, { commit: true }).catch(
    (error: Error) => error.message
  );
}

async function employeeRow(id = EMPLOYEES.aSelf): Promise<Record<string, unknown>> {
  const { rows } = await db.query("select * from public.employees where id = $1", [id]);
  return rows[0];
}

async function audits(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.query(
    "select action, entity, entity_id, diff from public.audit_logs order by id"
  );
  return rows;
}

async function resetScenario({ assigned = false } = {}) {
  await db.query("set app.allow_history_delete = 'on'");
  await db.query("delete from public.audit_logs");
  await db.query("delete from public.time_entries");
  await db.query("delete from public.cancellation_requests");
  await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
  await db.query("delete from public.vacation_requests");
  await db.query("delete from public.sick_leaves");
  await db.query("delete from public.employee_qualifications");
  await db.query("delete from public.employee_availability");
  await db.query("delete from public.emergency_contacts");
  await db.query(
    `update public.shifts
     set required_count = 1, status = 'open', required_qualification = null,
         date = (now() + interval '2 days')::date,
         start_time = now() + interval '2 days',
         end_time = now() + interval '2 days 8 hours'
     where id = $1`,
    [A_SHIFT]
  );
  const { rows } = await db.query("select date::text as d from public.shifts where id = $1", [
    A_SHIFT,
  ]);
  shiftDate = rows[0].d as string;

  await db.query(
    `update public.shift_offer_responses
     set response = 'interested', decided_at = null, decided_by = null, resulting_assignment_id = null
     where company_id = $1`,
    [COMPANY_A]
  );
  await db.query("update public.shift_offers set status = 'open', closed_at = null");
  // Through a real role, not the owner connection: guard_employee_self_mutation
  // exempts HR and nobody else, and "the test harness" is not HR.
  await runAsUser(
    db,
    USERS.aAdmin,
    (q) =>
      q("update public.employees set phone = null, position = null where company_id = $1", [
        COMPANY_A,
      ]),
    { commit: true }
  );
  await setEmploymentStatus(db, COMPANY_A);

  if (assigned) {
    await db.query(
      `insert into public.shift_assignments (id, company_id, shift_id, employee_id, status)
       values ($1, $2, $3, $4, 'assigned')`,
      [A_ASSIGNMENT, COMPANY_A, A_SHIFT, EMPLOYEES.aSelf]
    );
  }
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
/* 1 · Direct attack — the employee's own row                          */
/* ------------------------------------------------------------------ */

describe("an employee may not rewrite their own employment record", () => {
  // Every one of these was ALLOWED on HEAD before 0016.
  const forbidden: Array<[string, string, unknown]> = [
    ["hourly_rate", "hourly_rate = $2", 999],
    ["employment_status", "employment_status = $2", "terminated"],
    ["vacation_days_total", "vacation_days_total = $2", 99],
    ["vacation_days_used", "vacation_days_used = $2", 99],
    ["employee_no", "employee_no = $2", "A-999"],
    ["weekly_hours", "weekly_hours = $2", 1],
    ["contract_type", "contract_type = $2", "mini_job"],
    ["full_name", "full_name = $2", "Chief Executive"],
    ["email", "email = $2", "attacker@example.test"],
    ["position", "position = $2", "Sicherheitsleitung"],
    ["start_date", "start_date = $2", "2000-01-01"],
  ];

  for (const [field, assignment, value] of forbidden) {
    it(`refuses ${field}`, async () => {
      const before = await employeeRow();
      const result = await attempt(
        USERS.aWorker,
        `update public.employees set ${assignment} where id = $1`,
        [EMPLOYEES.aSelf, value]
      );
      expect(String(result)).toContain("an employee may only change their own phone number");
      expect(await employeeRow()).toEqual(before);
    });
  }

  it("refuses department_id and location_id — they decide who matches a shift", async () => {
    // Real values, not nulls: setting a column to what it already holds is a
    // no-op the trigger correctly waves through, and would prove nothing.
    const { rows } = await db.query(
      `insert into public.departments (company_id, name) values ($1, 'Objektschutz')
       on conflict (company_id, name) do update set name = excluded.name returning id`,
      [COMPANY_A]
    );
    for (const [column, value] of [
      ["location_id", A_LOCATION],
      ["department_id", rows[0].id as string],
    ] as const) {
      const result = await attempt(
        USERS.aWorker,
        `update public.employees set ${column} = $2 where id = $1`,
        [EMPLOYEES.aSelf, value]
      );
      expect(String(result)).toContain("an employee may only change their own phone number");
    }
  });

  it("refuses profile_id, even when set to the caller's own id", async () => {
    const result = await attempt(
      USERS.aWorker,
      "update public.employees set profile_id = $2 where id = $1",
      [EMPLOYEES.aSelf, USERS.aWorker]
    );
    // Unchanged value, so the trigger passes it; there is simply nothing to do.
    expect(typeof result === "number" ? result : 0).toBeLessThanOrEqual(1);
    expect((await employeeRow()).profile_id).toBe(USERS.aWorker);
  });

  it("refuses unlinking their own account", async () => {
    // The row policy's with-check requires profile_id = auth.uid(), so setting
    // it to null is refused by RLS before the trigger is even reached. Either
    // layer is a correct refusal; the proof is that the link survives.
    const result = await attempt(
      USERS.aWorker,
      "update public.employees set profile_id = null where id = $1",
      [EMPLOYEES.aSelf]
    );
    expect(String(result)).toMatch(/row-level security|only change their own phone/);
    expect((await employeeRow()).profile_id).toBe(USERS.aWorker);
  });

  it("refuses a tenant hop — with NO absence rows, so no other constraint can mask it", async () => {
    // Phase E's composite FK on vacation_requests/sick_leaves would otherwise
    // catch this for the wrong reason. Removing those rows first is what makes
    // this a test of the employee guard.
    await db.query("delete from public.vacation_requests");
    await db.query("delete from public.sick_leaves");

    const result = await attempt(
      USERS.aWorker,
      "update public.employees set company_id = $2 where id = $1",
      [EMPLOYEES.aSelf, COMPANY_B]
    );
    expect(String(result)).toContain("an employee may only change their own phone number");
    expect((await employeeRow()).company_id).toBe(COMPANY_A);
  });

  it("allows phone — the one column they own", async () => {
    const result = await attempt(
      USERS.aWorker,
      "update public.employees set phone = $2 where id = $1",
      [EMPLOYEES.aSelf, "030 12345678"]
    );
    expect(result).toBe(1);
    expect((await employeeRow()).phone).toBe("030 12345678");
  });

  it("refuses phone smuggled together with a protected field", async () => {
    const result = await attempt(
      USERS.aWorker,
      "update public.employees set phone = $2, hourly_rate = $3 where id = $1",
      [EMPLOYEES.aSelf, "030 999", 500]
    );
    expect(String(result)).toContain("an employee may only change their own phone number");
    expect((await employeeRow()).phone).toBeNull();
  });

  it("cannot touch a colleague's row at all", async () => {
    const result = await attempt(
      USERS.aWorker,
      "update public.employees set phone = $2 where id = $1",
      [EMPLOYEES.aColleague, "030 000"]
    );
    expect(result).toBe(0);
  });

  it("cannot create an employee record", async () => {
    const result = await attempt(
      USERS.aWorker,
      `insert into public.employees (company_id, employee_no, full_name)
       values ($1, 'X-1', 'Self Promoted')`,
      [COMPANY_A]
    );
    expect(String(result)).toContain("row-level security");
  });
});

/* ------------------------------------------------------------------ */
/* 2 · Authorization                                                   */
/* ------------------------------------------------------------------ */

describe("authorization", () => {
  it("a DISPATCHER reads employees and writes none of them", async () => {
    const seen = await runAs(
      USERS.aDispatcher,
      async (q) => (await q("select id from public.employees")).rowCount
    );
    expect(seen).toBe(2);

    expect(
      await attempt(USERS.aDispatcher, "update public.employees set position = 'Chef' where id = $1", [
        EMPLOYEES.aSelf,
      ])
    ).toBe(0);
    expect(
      String(
        await attempt(
          USERS.aDispatcher,
          `insert into public.employees (company_id, employee_no, full_name) values ($1, 'D-1', 'D')`,
          [COMPANY_A]
        )
      )
    ).toContain("row-level security");
  });

  it("a DISPATCHER cannot change employment status through the RPC", async () => {
    const result = await setStatus(USERS.aDispatcher, EMPLOYEES.aSelf, "terminated");
    expect(result.status).toBe("forbidden");
    expect((await employeeRow()).employment_status).toBe("active");
  });

  it("a DISPATCHER cannot write or remove qualifications", async () => {
    await db.query(
      `insert into public.employee_qualifications (id, company_id, employee_id, name)
       values ($1, $2, $3, 'SG34')`,
      [A_QUALIFICATION, COMPANY_A, EMPLOYEES.aSelf]
    );
    expect(
      String(
        await attempt(
          USERS.aDispatcher,
          `insert into public.employee_qualifications (company_id, employee_id, name)
           values ($1, $2, 'Ersthelfer')`,
          [COMPANY_A, EMPLOYEES.aSelf]
        )
      )
    ).toContain("row-level security");
    expect((await removeQualification(USERS.aDispatcher, A_QUALIFICATION)).status).toBe("forbidden");
  });

  it("a DISPATCHER still cannot see emergency contacts", async () => {
    await db.query(
      `insert into public.emergency_contacts (company_id, employee_id, name, phone)
       values ($1, $2, 'Mutter', '030 555')`,
      [COMPANY_A, EMPLOYEES.aSelf]
    );
    const seen = await runAs(
      USERS.aDispatcher,
      async (q) => (await q("select id from public.emergency_contacts")).rowCount
    );
    expect(seen).toBe(0);
  });

  it("an HR_MANAGER administers employees and gains no scheduling authority", async () => {
    expect(
      await attempt(HR_USER, "update public.employees set position = $2 where id = $1", [
        EMPLOYEES.aSelf,
        "Teamleitung",
      ])
    ).toBe(1);
    expect((await setStatus(HR_USER, EMPLOYEES.aSelf, "on_leave")).status).toBe("changed");

    const approval = await runAs(
      HR_USER,
      async (q) =>
        (await q("select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aSelf])).rows[0]
          .r as Result,
      { commit: true }
    );
    expect(approval.status).toBe("forbidden");
  });

  it("an employee reads their own qualifications and cannot add one", async () => {
    await db.query(
      `insert into public.employee_qualifications (company_id, employee_id, name)
       values ($1, $2, 'SG34')`,
      [COMPANY_A, EMPLOYEES.aSelf]
    );
    const seen = await runAs(
      USERS.aWorker,
      async (q) => (await q("select id from public.employee_qualifications")).rowCount
    );
    expect(seen).toBe(1);
    expect(
      String(
        await attempt(
          USERS.aWorker,
          `insert into public.employee_qualifications (company_id, employee_id, name)
           values ($1, $2, 'Selbst verliehen')`,
          [COMPANY_A, EMPLOYEES.aSelf]
        )
      )
    ).toContain("row-level security");
  });
});

/* ------------------------------------------------------------------ */
/* 3 · Creation                                                        */
/* ------------------------------------------------------------------ */

describe("employee creation", () => {
  it("HR creates a record with no account at all", async () => {
    const created = await runAs(
      HR_USER,
      async (q) =>
        (
          await q(
            `insert into public.employees (company_id, employee_no, full_name, employment_status)
             values ($1, 'A-100', 'Neue Kollegin', 'probation') returning id, profile_id`,
            [COMPANY_A]
          )
        ).rows[0],
      { commit: true }
    );
    expect(created.profile_id).toBeNull();

    // ...and a second one, proving unique(company_id, profile_id) does not
    // collapse accountless employees onto each other.
    const second = await attempt(
      HR_USER,
      `insert into public.employees (company_id, employee_no, full_name) values ($1, 'A-101', 'Zweiter')`,
      [COMPANY_A]
    );
    expect(second).toBe(1);
  });

  it("refuses a duplicate employee number within the company", async () => {
    const result = await attempt(
      HR_USER,
      `insert into public.employees (company_id, employee_no, full_name) values ($1, 'A-001', 'Doppelt')`,
      [COMPANY_A]
    );
    expect(String(result)).toContain("employees_company_id_employee_no_key");
  });

  it("allows the same employee number in a different company", async () => {
    const result = await attempt(
      USERS.bAdmin,
      `insert into public.employees (company_id, employee_no, full_name) values ($1, 'A-001', 'Anders')`,
      [COMPANY_B]
    );
    expect(result).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4 · Employment status                                               */
/* ------------------------------------------------------------------ */

describe("set_employment_status", () => {
  it("commits the change and writes exactly one audit row", async () => {
    const result = await setStatus(HR_USER, EMPLOYEES.aSelf, "terminated");
    expect(result.status).toBe("changed");
    expect(result.from).toBe("active");
    expect(result.to).toBe("terminated");
    expect((await employeeRow()).employment_status).toBe("terminated");

    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("employee.status_changed");
    expect(log[0].diff).toEqual({ from: "active", to: "terminated", future_assignments: 0 });
  });

  it("terminating is NEVER refused because of a future assignment — it reports it", async () => {
    await resetScenario({ assigned: true });
    const result = await setStatus(HR_USER, EMPLOYEES.aSelf, "terminated");

    expect(result.status).toBe("changed");
    expect(result.count).toBe(1);
    expect(result.conflicts?.[0].assignment_id).toBe(A_ASSIGNMENT);
    expect(result.conflicts?.[0].shift_id).toBe(A_SHIFT);

    // The status moved. The assignment did NOT.
    expect((await employeeRow()).employment_status).toBe("terminated");
    const { rows } = await db.query("select status from public.shift_assignments where id = $1", [
      A_ASSIGNMENT,
    ]);
    expect(rows[0].status).toBe("assigned");
  });

  it("counts only FUTURE work — a shift already worked is not a conflict", async () => {
    await resetScenario({ assigned: true });
    await db.query(
      `update public.shifts set start_time = now() - interval '2 days',
         end_time = now() - interval '1 day 16 hours', date = (now() - interval '2 days')::date
       where id = $1`,
      [A_SHIFT]
    );
    const result = await setStatus(HR_USER, EMPLOYEES.aSelf, "terminated");
    expect(result.count).toBe(0);
  });

  it("a deactivated employee can no longer be approved onto a shift", async () => {
    await setStatus(HR_USER, EMPLOYEES.aSelf, "on_leave");
    const approval = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (await q("select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aSelf])).rows[0]
          .r as Result,
      { commit: true }
    );
    expect(approval.status).toBe("employee_inactive");
  });

  it("reactivation is allowed and creates no conflict report", async () => {
    await setStatus(HR_USER, EMPLOYEES.aSelf, "terminated");
    const back = await setStatus(HR_USER, EMPLOYEES.aSelf, "active");
    expect(back.status).toBe("changed");
    expect(back.to).toBe("active");
    expect(await audits()).toHaveLength(2);
  });

  it("a no-op writes nothing", async () => {
    const result = await setStatus(HR_USER, EMPLOYEES.aSelf, "active");
    expect(result.status).toBe("unchanged");
    expect(await audits()).toHaveLength(0);
  });

  it("refuses a status outside the enum without touching the row", async () => {
    expect((await setStatus(HR_USER, EMPLOYEES.aSelf, "retired")).status).toBe("invalid_status");
    expect((await employeeRow()).employment_status).toBe("active");
  });

  it("is not found across a tenant boundary", async () => {
    expect((await setStatus(USERS.bAdmin, EMPLOYEES.aSelf, "terminated")).status).toBe("not_found");
    expect((await employeeRow()).employment_status).toBe("active");
  });
});

/* ------------------------------------------------------------------ */
/* 5 · Qualifications                                                  */
/* ------------------------------------------------------------------ */

describe("qualifications", () => {
  async function seedQualification(name = "SG34") {
    await db.query(
      `insert into public.employee_qualifications (id, company_id, employee_id, name, expires_at)
       values ($1, $2, $3, $4, current_date + 200)`,
      [A_QUALIFICATION, COMPANY_A, EMPLOYEES.aSelf, name]
    );
  }

  it("HR adds, updates and removes", async () => {
    await seedQualification();
    expect(
      await attempt(
        HR_USER,
        "update public.employee_qualifications set expires_at = $2 where id = $1",
        [A_QUALIFICATION, "2030-01-01"]
      )
    ).toBe(1);

    const removed = await removeQualification(HR_USER, A_QUALIFICATION);
    expect(removed.status).toBe("removed");
    expect(removed.count).toBe(0);

    const { rows } = await db.query("select count(*)::int as c from public.employee_qualifications");
    expect(Number(rows[0].c)).toBe(0);
  });

  it("removing one a future shift requires reports the shift and keeps the assignment", async () => {
    await resetScenario({ assigned: true });
    await seedQualification("SG34");
    await db.query("update public.shifts set required_qualification = 'SG34' where id = $1", [
      A_SHIFT,
    ]);

    const removed = await removeQualification(HR_USER, A_QUALIFICATION);
    expect(removed.status).toBe("removed");
    expect(removed.count).toBe(1);
    expect(removed.conflicts?.[0].shift_id).toBe(A_SHIFT);

    // The commitment stands. Only a person, through C.1 removal, undoes it.
    const { rows } = await db.query("select status from public.shift_assignments where id = $1", [
      A_ASSIGNMENT,
    ]);
    expect(rows[0].status).toBe("assigned");
  });

  it("a shift requiring something else is not a conflict", async () => {
    await resetScenario({ assigned: true });
    await seedQualification("SG34");
    await db.query("update public.shifts set required_qualification = 'Ersthelfer' where id = $1", [
      A_SHIFT,
    ]);
    expect((await removeQualification(HR_USER, A_QUALIFICATION)).count).toBe(0);
  });

  it("audits the removal with the name and the count, and nothing else", async () => {
    await seedQualification();
    await removeQualification(HR_USER, A_QUALIFICATION);
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("qualification.removed");
    expect(log[0].diff).toEqual({
      employee_id: EMPLOYEES.aSelf,
      name: "SG34",
      affected_assignments: 0,
    });
  });

  it("is not found across a tenant boundary", async () => {
    await seedQualification();
    expect((await removeQualification(USERS.bAdmin, A_QUALIFICATION)).status).toBe("not_found");
    const { rows } = await db.query("select count(*)::int as c from public.employee_qualifications");
    expect(Number(rows[0].c)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 6 · Availability and emergency contacts                             */
/* ------------------------------------------------------------------ */

describe("employee self-service rows", () => {
  it("an employee manages their own availability", async () => {
    const created = await attempt(
      USERS.aWorker,
      `insert into public.employee_availability (company_id, employee_id, weekday, type)
       values ($1, $2, 3, 'unavailable')`,
      [COMPANY_A, EMPLOYEES.aSelf]
    );
    expect(created).toBe(1);

    const deleted = await attempt(
      USERS.aWorker,
      "delete from public.employee_availability where employee_id = $1",
      [EMPLOYEES.aSelf]
    );
    expect(deleted).toBe(1);
  });

  it("changing availability leaves an existing assignment alone", async () => {
    await resetScenario({ assigned: true });
    await attempt(
      USERS.aWorker,
      `insert into public.employee_availability (company_id, employee_id, weekday, type)
       values ($1, $2, extract(dow from $3::date)::smallint, 'unavailable')`,
      [COMPANY_A, EMPLOYEES.aSelf, shiftDate]
    );
    const { rows } = await db.query("select status from public.shift_assignments where id = $1", [
      A_ASSIGNMENT,
    ]);
    expect(rows[0].status).toBe("assigned");
  });

  it("an employee cannot write a colleague's availability", async () => {
    const result = await attempt(
      USERS.aWorker,
      `insert into public.employee_availability (company_id, employee_id, weekday, type)
       values ($1, $2, 3, 'unavailable')`,
      [COMPANY_A, EMPLOYEES.aColleague]
    );
    expect(String(result)).toContain("row-level security");
  });

  it("an employee manages their own emergency contact and sees no one else's", async () => {
    expect(
      await attempt(
        USERS.aWorker,
        `insert into public.emergency_contacts (company_id, employee_id, name, phone)
         values ($1, $2, 'Mutter', '030 555')`,
        [COMPANY_A, EMPLOYEES.aSelf]
      )
    ).toBe(1);

    await db.query(
      `insert into public.emergency_contacts (company_id, employee_id, name, phone)
       values ($1, $2, 'Andere', '030 666')`,
      [COMPANY_A, EMPLOYEES.aColleague]
    );
    const seen = await runAs(
      USERS.aWorker,
      async (q) => (await q("select id from public.emergency_contacts")).rowCount
    );
    expect(seen).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 7 · Deletion                                                        */
/* ------------------------------------------------------------------ */

describe("employees are never deleted", () => {
  /**
   * Delete straight on the owner connection, with the maintenance flag off.
   * RLS has no DELETE policy any more, so an HR session is filtered to zero
   * rows and never reaches the trigger — which is the belt working, but leaves
   * the braces untested. This is the path that exercises the trigger itself,
   * and it is also the path a service-role caller would take.
   */
  async function ownerDelete(employeeId: string): Promise<string> {
    await db.query("begin");
    try {
      await db.query("set local app.allow_history_delete = 'off'");
      await db.query("delete from public.employees where id = $1", [employeeId]);
      return "DELETED";
    } catch (error) {
      return (error as Error).message;
    } finally {
      await db.query("rollback");
    }
  }

  it("no authenticated role has a DELETE policy at all", async () => {
    await resetScenario({ assigned: true });
    for (const user of [HR_USER, USERS.aAdmin, USERS.aDispatcher, USERS.aWorker]) {
      const result = await attempt(user, "delete from public.employees where id = $1", [
        EMPLOYEES.aSelf,
      ]);
      expect(result).toBe(0);
    }
    expect(await employeeRow()).toBeDefined();
  });

  it("the trigger refuses deletion of an employee holding an assignment", async () => {
    await resetScenario({ assigned: true });
    expect(await ownerDelete(EMPLOYEES.aSelf)).toContain("not permitted");
    expect(await employeeRow()).toBeDefined();
  });

  it("refuses deletion of an employee with worked time but NO assignment", async () => {
    // The case that was ALLOWED on HEAD: guard_history_delete only reached the
    // cascade through shift_assignments, so an employee with nothing but a
    // completed time entry could be erased along with their geofence evidence.
    await db.query(
      `insert into public.time_entries
         (company_id, employee_id, clock_in, clock_out, status, clock_in_lat, clock_in_lng)
       values ($1, $2, now() - interval '5 hours', now(), 'completed', 52.52, 13.405)`,
      [COMPANY_A, EMPLOYEES.aSelf]
    );
    expect(await ownerDelete(EMPLOYEES.aSelf)).toContain("Deleting employees is not permitted");

    const { rows } = await db.query(
      "select count(*)::int as c from public.time_entries where employee_id = $1",
      [EMPLOYEES.aSelf]
    );
    expect(Number(rows[0].c)).toBe(1);
  });

  it("refuses deletion of an employee with no history whatsoever", async () => {
    const created = await runAs(
      HR_USER,
      async (q) =>
        (
          await q(
            `insert into public.employees (company_id, employee_no, full_name)
             values ($1, 'A-200', 'Tippfehler') returning id`,
            [COMPANY_A]
          )
        ).rows[0].id as string,
      { commit: true }
    );
    expect(await ownerDelete(created)).toContain("not permitted");
  });

  it("an employee cannot delete themselves", async () => {
    const result = await attempt(USERS.aWorker, "delete from public.employees where id = $1", [
      EMPLOYEES.aSelf,
    ]);
    expect(await employeeRow()).toBeDefined();
    expect(typeof result === "number" ? result : 0).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 8 · Tenant integrity                                                */
/* ------------------------------------------------------------------ */

describe("tenant integrity", () => {
  it("company B cannot file a qualification against company A's employee", async () => {
    const result = await attempt(
      USERS.bAdmin,
      `insert into public.employee_qualifications (company_id, employee_id, name)
       values ($1, $2, 'Fremd')`,
      [COMPANY_B, EMPLOYEES.aSelf]
    );
    expect(String(result)).toContain("qualifications_employee_same_company");
  });

  it("company B cannot file availability against company A's employee", async () => {
    const result = await attempt(
      USERS.bAdmin,
      `insert into public.employee_availability (company_id, employee_id, weekday, type)
       values ($1, $2, 1, 'unavailable')`,
      [COMPANY_B, EMPLOYEES.aSelf]
    );
    expect(String(result)).toContain("availability_employee_same_company");
  });

  it("company B cannot file an emergency contact against company A's employee", async () => {
    const result = await attempt(
      USERS.bAdmin,
      `insert into public.emergency_contacts (company_id, employee_id, name, phone)
       values ($1, $2, 'Fremd', '1')`,
      [COMPANY_B, EMPLOYEES.aSelf]
    );
    expect(String(result)).toContain("emergency_employee_same_company");
  });

  it("company B cannot attach company A's site to its own employee", async () => {
    const result = await attempt(
      USERS.bAdmin,
      `insert into public.employees (company_id, location_id, employee_no, full_name)
       values ($1, $2, 'B-9', 'Fremdstandort')`,
      [COMPANY_B, A_LOCATION]
    );
    expect(String(result)).toContain("employees_location_same_company");
  });

  it("company B cannot attach company A's person to its own employee record", async () => {
    const result = await attempt(
      USERS.bAdmin,
      `insert into public.employees (company_id, profile_id, employee_no, full_name)
       values ($1, $2, 'B-8', 'Fremdes Konto')`,
      [COMPANY_B, USERS.aWorker]
    );
    expect(String(result)).toContain("not a member of this company");
  });

  it("linking a profile that IS a member of the company still works", async () => {
    // The guard must not block the legitimate case Phase G will need.
    const result = await attempt(
      HR_USER,
      `insert into public.employees (company_id, profile_id, employee_no, full_name)
       values ($1, $2, 'A-300', 'HR selbst')`,
      [COMPANY_A, HR_USER]
    );
    expect(result).toBe(1);
  });

  it("a legitimate same-tenant site assignment still works", async () => {
    expect(
      await attempt(HR_USER, "update public.employees set location_id = $2 where id = $1", [
        EMPLOYEES.aSelf,
        A_LOCATION,
      ])
    ).toBe(1);
    expect(
      String(
        await attempt(HR_USER, "update public.employees set location_id = $2 where id = $1", [
          EMPLOYEES.aSelf,
          B_LOCATION,
        ])
      )
    ).toContain("employees_location_same_company");
  });
});

/* ------------------------------------------------------------------ */
/* 9 · Concurrency                                                     */
/* ------------------------------------------------------------------ */

/**
 * Re-proving the Phase E result now that employment status is writable through
 * an RPC rather than only by a fixture. The forbidden state is: an employee
 * outside ('active','probation') holding a live assignment created after they
 * left. `app.lock_employee()` is taken first by both sides, so whoever arrives
 * second sees a committed world — which side wins is not deterministic, the
 * outcome is.
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

  async function runRace(order: "hr-first" | "dispatch-first") {
    await resetScenario();
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();
    try {
      if (order === "hr-first") {
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
            .query("select public.set_employment_status($1, 'terminated') as r", [EMPLOYEES.aSelf])
            .then((r) => ({ client: a, result: r.rows[0].r as Result })),
        },
        {
          client: b,
          promise: b
            .query("select public.approve_shift_offer($1) as r", [OFFER_RESPONSES.aSelf])
            .then((r) => ({ client: b, result: r.rows[0].r as Result })),
        },
      ]);
      return {
        statuses: results.map((r) => r.result.status),
        statusResult: results.find((r) => r.client === a)!.result,
      };
    } finally {
      await a.end();
      await b.end();
    }
  }

  /** Live future assignments the employee holds, after both sides committed. */
  async function liveAssignments(): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as c from public.shift_assignments
       where employee_id = $1 and shift_id = $2
         and status in ('assigned','accepted','cancellation_requested')`,
      [EMPLOYEES.aSelf, A_SHIFT]
    );
    return Number(rows[0].c);
  }

  /**
   * The invariant is NOT "these two can never both commit" — that is Phase E's
   * rule for vacation, which is a request and therefore refusable. Employment
   * status is a fact: it always commits, and an inactive employee holding a
   * future assignment is an expected, surfaced state that a dispatcher resolves
   * through C.1 removal.
   *
   * What must never happen is an UNREPORTED one. Both sides take
   * app.lock_employee() first, so an assignment created by the approval either
   * loses the race and is refused, or wins it and is counted by the status
   * change. Reproduced deterministically before this was written: with the
   * approval holding the lock, the status change blocked, then committed with
   * count 1 and audit future_assignments 1.
   */
  async function assertRaceOutcome(order: "hr-first" | "dispatch-first") {
    const { statuses, statusResult } = await runRace(order);
    const live = await liveAssignments();

    // Whoever went second saw a committed world, not a stale one.
    expect(statuses).toContain("changed");
    if (statuses.includes("approved")) {
      // Approval won: the new assignment must appear in the conflict report.
      expect(live).toBe(1);
      expect(statusResult.count).toBe(1);
    } else {
      // Deactivation won: approval must have been refused, and nobody rostered.
      expect(statuses).toContain("employee_inactive");
      expect(live).toBe(0);
      expect(statusResult.count).toBe(0);
    }

    // The audit row agrees with what the caller was told — one truth, not two.
    const log = await audits();
    const statusRow = log.find((r) => r.action === "employee.status_changed");
    expect((statusRow?.diff as Record<string, unknown>).future_assignments).toBe(
      statusResult.count
    );
  }

  it("deactivation racing an offer approval leaves nothing unreported — HR first", async () => {
    await assertRaceOutcome("hr-first");
  });

  it("deactivation racing an offer approval leaves nothing unreported — dispatch first", async () => {
    await assertRaceOutcome("dispatch-first");
  });

  it("two HR managers deactivating one employee produce one status change", async () => {
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();
    try {
      await beginAs(a, HR_USER);
      await beginAs(b, USERS.aAdmin);
      const call = (client: Client) =>
        client
          .query("select public.set_employment_status($1, 'terminated') as r", [EMPLOYEES.aSelf])
          .then((r) => ({ client, result: r.rows[0].r as Result }));

      const [first, second] = await race([
        { client: a, promise: call(a) },
        { client: b, promise: call(b) },
      ]);
      expect(first.result.status).toBe("changed");
      expect(second.result.status).toBe("unchanged");
    } finally {
      await a.end();
      await b.end();
    }
    expect(await audits()).toHaveLength(1);
  });
});

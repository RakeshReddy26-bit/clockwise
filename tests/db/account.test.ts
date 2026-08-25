/**
 * Phase G — account invitation and access lifecycle, against a real database.
 *
 * WHAT THIS SUITE CANNOT DO, stated up front: the scratch harness's auth.users
 * is a four-column shim with only auth.uid(). Supabase Auth is not present, so
 * inviteUserByEmail, the invitation email, verifyOtp and password setup are NOT
 * exercised here and are not claimed as proven. Every test below starts from
 * "an auth user and profile already exist", which is exactly the state the
 * Server Action hands to invite_employee(). The Auth leg is a manual staging
 * check, listed in the report.
 *
 * The two defects Phase G closes were both reproduced on HEAD before it was
 * written:
 *
 *   1. A suspended membership blocked almost nothing. 40 of 96 policies are
 *      self-scoped; 29 resolve through app.current_employee_id(), which never
 *      asked whether the membership was still active. A suspended employee
 *      could still CLOCK IN.
 *   2. HR could point any employment record at any colleague's account, and
 *      relink an already-linked one — the account-takeover surface.
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
} from "./helpers";

const DB_NAME = "clockwise_account_test";
const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";
const DB_URL = ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`);

const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const HR_USER = "aaaaaaaa-0000-0000-0000-000000000004";
/** A freshly "invited" identity: an auth user + profile with nothing attached. */
const NEW_USER = "aaaaaaaa-0000-0000-0000-000000000005";
const OTHER_USER = "aaaaaaaa-0000-0000-0000-000000000006";

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

type Result = { status: string; profile_id?: string; access?: string; current?: string };

const call = (userId: string, sql: string, params: unknown[] = []): Promise<Result> =>
  runAs(userId, async (q) => (await q(sql, params)).rows[0].r as Result, { commit: true });

const invite = (userId: string, employeeId: string, profileId: string | null) =>
  call(userId, "select public.invite_employee($1, $2) as r", [employeeId, profileId]);

const setAccess = (userId: string, employeeId: string, suspend: boolean) =>
  call(userId, "select public.set_membership_access($1, $2) as r", [employeeId, suspend]);

const activate = (userId: string) =>
  call(userId, "select public.activate_my_membership() as r");

const setStatus = (userId: string, employeeId: string, status: string) =>
  call(userId, "select public.set_employment_status($1, $2) as r", [employeeId, status]);

async function attempt(userId: string, sql: string, params: unknown[] = []) {
  return runAs(userId, async (q) => (await q(sql, params)).rowCount ?? 0, { commit: true }).catch(
    (error: Error) => error.message
  );
}

async function membershipStatus(profileId: string, companyId = COMPANY_A) {
  const { rows } = await db.query(
    "select status from public.company_memberships where profile_id = $1 and company_id = $2",
    [profileId, companyId]
  );
  return rows[0]?.status as string | undefined;
}

async function profileLink(employeeId: string = EMPLOYEES.aColleague) {
  const { rows } = await db.query("select profile_id from public.employees where id = $1", [
    employeeId,
  ]);
  return rows[0]?.profile_id as string | null;
}

async function audits() {
  const { rows } = await db.query("select action, diff from public.audit_logs order by id");
  return rows;
}

async function resetScenario() {
  await db.query("set app.allow_history_delete = 'on'");
  await db.query("delete from public.audit_logs");
  await db.query("delete from public.time_entries");
  await db.query("delete from public.vacation_requests");
  await db.query("delete from public.sick_leaves");
  await db.query("delete from public.employee_availability");
  await db.query("delete from public.shift_assignments where shift_id = $1", [A_SHIFT]);
  await db.query(
    `update public.shifts set status='open', date=(now()+interval '2 days')::date,
       start_time=now()+interval '2 days', end_time=now()+interval '2 days 8 hours'
     where id = $1`,
    [A_SHIFT]
  );
  // The colleague is the unlinked employee every invitation test starts from.
  // Unlinking is forbidden for EVERY caller by guard_employee_profile_immutable
  // — that is the point of it — so fixture teardown disables the trigger
  // explicitly on the owner connection rather than finding a way around it.
  // Both guards fire here: field ownership (the owner connection is not HR) and
  // immutability (nobody may unlink). Disabling them by name on the owner
  // connection is the honest way to reset, and it keeps the guards maximal.
  for (const trigger of [
    "guard_employee_field_ownership",
    "guard_employee_profile_immutable",
  ]) {
    await db.query(`alter table public.employees disable trigger ${trigger}`);
  }
  await db.query("update public.employees set profile_id = null where id = $1", [
    EMPLOYEES.aColleague,
  ]);
  for (const trigger of [
    "guard_employee_field_ownership",
    "guard_employee_profile_immutable",
  ]) {
    await db.query(`alter table public.employees enable trigger ${trigger}`);
  }
  await db.query("delete from public.company_memberships where profile_id in ($1, $2)", [
    NEW_USER,
    OTHER_USER,
  ]);
  await db.query(
    "update public.company_memberships set status='active' where profile_id = $1 and company_id = $2",
    [USERS.aWorker, COMPANY_A]
  );
  await setEmploymentStatus(db, COMPANY_A);
}

beforeAll(async () => {
  db = await createTestDatabase(DB_NAME);
  await db.query("insert into auth.users (id, email) values ($1, 'hr@a.test')", [HR_USER]);
  await db.query(
    `insert into public.company_memberships (profile_id, company_id, role, status)
     values ($1, $2, 'HR_MANAGER', 'active')`,
    [HR_USER, COMPANY_A]
  );
  // Stand-ins for identities inviteUserByEmail would have created.
  await db.query("insert into auth.users (id, email) values ($1, 'neu@a.test'), ($2, 'zwei@a.test')", [
    NEW_USER,
    OTHER_USER,
  ]);
}, 60_000);

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await resetScenario();
});

/* ------------------------------------------------------------------ */
/* 1 · Suspension actually suspends                                    */
/* ------------------------------------------------------------------ */

describe("a suspended membership reaches no data", () => {
  async function suspendWorker() {
    await db.query(
      "update public.company_memberships set status='suspended' where profile_id=$1 and company_id=$2",
      [USERS.aWorker, COMPANY_A]
    );
  }

  it("resolves no employee id at all", async () => {
    await suspendWorker();
    const resolved = await runAs(
      USERS.aWorker,
      async (q) =>
        (await q("select app.current_employee_id($1) as id", [COMPANY_A])).rows[0].id as
          | string
          | null
    );
    expect(resolved).toBeNull();
  });

  // Every one of these returned rows on HEAD before 0017.
  const selects: Array<[string, string]> = [
    ["own time entries", "select id from public.time_entries"],
    ["own vacation requests", "select id from public.vacation_requests"],
    ["own sick leaves", "select id from public.sick_leaves"],
    ["own availability", "select id from public.employee_availability"],
    ["own assignments", "select id from public.shift_assignments"],
    ["own emergency contacts", "select id from public.emergency_contacts"],
    ["shifts", "select id from public.shifts"],
  ];

  for (const [label, sql] of selects) {
    it(`reads no ${label}`, async () => {
      await db.query(
        `insert into public.employee_availability (company_id, employee_id, weekday, type)
         values ($1, $2, 1, 'unavailable')`,
        [COMPANY_A, EMPLOYEES.aSelf]
      );
      await db.query(
        `insert into public.shift_assignments (company_id, shift_id, employee_id, status)
         values ($1, $2, $3, 'assigned')`,
        [COMPANY_A, A_SHIFT, EMPLOYEES.aSelf]
      );
      await suspendWorker();
      const rows = await runAs(USERS.aWorker, async (q) => (await q(sql)).rowCount);
      expect(rows).toBe(0);
    });
  }

  it("cannot clock in — the one that mattered most", async () => {
    await db.query(
      `insert into public.shift_assignments (company_id, shift_id, employee_id, status)
       values ($1, $2, $3, 'assigned')`,
      [COMPANY_A, A_SHIFT, EMPLOYEES.aSelf]
    );
    await suspendWorker();
    const result = await attempt(
      USERS.aWorker,
      `insert into public.time_entries (company_id, employee_id, clock_in, status)
       values ($1, $2, now(), 'running')`,
      [COMPANY_A, EMPLOYEES.aSelf]
    );
    expect(String(result)).toContain("row-level security");
  });

  it("cannot file an absence or availability", async () => {
    await suspendWorker();
    for (const sql of [
      `insert into public.vacation_requests (company_id, employee_id, start_date, end_date, days_count)
       values ($1, $2, current_date + 30, current_date + 31, 2)`,
      `insert into public.sick_leaves (company_id, employee_id, start_date, status)
       values ($1, $2, current_date, 'reported')`,
      `insert into public.employee_availability (company_id, employee_id, weekday, type)
       values ($1, $2, 1, 'unavailable')`,
    ]) {
      const result = await attempt(USERS.aWorker, sql, [COMPANY_A, EMPLOYEES.aSelf]);
      expect(String(result)).toContain("row-level security");
    }
  });

  it("still sees their own name and notifications — suspension is not erasure", async () => {
    await suspendWorker();
    const seen = await runAs(USERS.aWorker, async (q) => ({
      profile: (await q("select id from public.profiles where id = $1", [USERS.aWorker])).rowCount,
      employee: (
        await q("select id from public.employees where profile_id = $1", [USERS.aWorker])
      ).rowCount,
    }));
    expect(seen).toEqual({ profile: 1, employee: 1 });
  });

  it("an active membership is unaffected", async () => {
    const resolved = await runAs(
      USERS.aWorker,
      async (q) =>
        (await q("select app.current_employee_id($1) as id", [COMPANY_A])).rows[0].id as string
    );
    expect(resolved).toBe(EMPLOYEES.aSelf);
  });
});

/* ------------------------------------------------------------------ */
/* 2 · profile_id is write-once                                        */
/* ------------------------------------------------------------------ */

describe("an account is never moved between employment records", () => {
  const RELINK = "profile_id is set by the invitation flow and never changed";

  it("HR cannot link a colleague's profile by hand", async () => {
    const result = await attempt(
      HR_USER,
      "update public.employees set profile_id = $2 where id = $1",
      [EMPLOYEES.aColleague, USERS.aDispatcher]
    );
    expect(String(result)).toContain(RELINK);
    expect(await profileLink()).toBeNull();
  });

  it("HR cannot relink an already-linked employee", async () => {
    const result = await attempt(
      HR_USER,
      "update public.employees set profile_id = $2 where id = $1",
      [EMPLOYEES.aSelf, USERS.aDispatcher]
    );
    expect(String(result)).toContain(RELINK);
    expect(await profileLink(EMPLOYEES.aSelf)).toBe(USERS.aWorker);
  });

  it("even a COMPANY_ADMIN cannot unlink", async () => {
    const result = await attempt(
      USERS.aAdmin,
      "update public.employees set profile_id = null where id = $1",
      [EMPLOYEES.aSelf]
    );
    expect(String(result)).toContain(RELINK);
    expect(await profileLink(EMPLOYEES.aSelf)).toBe(USERS.aWorker);
  });

  it("the employee cannot link themselves anywhere", async () => {
    const result = await attempt(
      USERS.aWorker,
      "update public.employees set profile_id = $2 where id = $1",
      [EMPLOYEES.aColleague, USERS.aWorker]
    );
    expect(await profileLink()).toBeNull();
    expect(typeof result === "number" ? result : 0).toBe(0);
  });

  it("only invite_employee() may write it", async () => {
    expect((await invite(HR_USER, EMPLOYEES.aColleague, NEW_USER)).status).toBe("invited");
    expect(await profileLink()).toBe(NEW_USER);
  });
});

/* ------------------------------------------------------------------ */
/* 3 · Invitation                                                      */
/* ------------------------------------------------------------------ */

describe("invite_employee", () => {
  it("creates an invited membership with the EMPLOYEE role and links the record", async () => {
    const result = await invite(HR_USER, EMPLOYEES.aColleague, NEW_USER);
    expect(result.status).toBe("invited");
    expect(await membershipStatus(NEW_USER)).toBe("invited");

    const { rows } = await db.query(
      "select role from public.company_memberships where profile_id = $1",
      [NEW_USER]
    );
    expect(rows[0].role).toBe("EMPLOYEE");

    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("employee.invited");
    expect(log[0].diff).toEqual({ profile_id: NEW_USER, had_existing_account: false });
    // No address, no token, no link — audit_logs is read by every admin.
    expect(JSON.stringify(log[0].diff)).not.toContain("@");
  });

  it("an invited membership does not let anyone in yet", async () => {
    await invite(HR_USER, EMPLOYEES.aColleague, NEW_USER);
    const resolved = await runAs(
      NEW_USER,
      async (q) =>
        (await q("select app.current_employee_id($1) as id", [COMPANY_A])).rows[0].id as
          | string
          | null
    );
    expect(resolved).toBeNull();
  });

  it("a second invite refuses instead of minting a second membership", async () => {
    await invite(HR_USER, EMPLOYEES.aColleague, NEW_USER);
    expect((await invite(HR_USER, EMPLOYEES.aColleague, OTHER_USER)).status).toBe("already_linked");
    expect(await profileLink()).toBe(NEW_USER);
    expect(await membershipStatus(OTHER_USER)).toBeUndefined();
  });

  it("refuses an identity already used by someone else in the company", async () => {
    expect((await invite(HR_USER, EMPLOYEES.aColleague, USERS.aWorker)).status).toBe(
      "profile_in_use"
    );
    expect(await profileLink()).toBeNull();
  });

  it("refuses a profile that does not exist", async () => {
    expect(
      (await invite(HR_USER, EMPLOYEES.aColleague, "00000000-0000-0000-0000-000000000000")).status
    ).toBe("profile_missing");
  });

  it("a DISPATCHER and an EMPLOYEE cannot invite", async () => {
    for (const user of [USERS.aDispatcher, USERS.aWorker]) {
      expect((await invite(user, EMPLOYEES.aColleague, NEW_USER)).status).toBe("forbidden");
    }
    expect(await profileLink()).toBeNull();
  });

  it("another tenant gets not_found, not forbidden — existence is not confirmed", async () => {
    expect((await invite(USERS.bAdmin, EMPLOYEES.aColleague, NEW_USER)).status).toBe("not_found");
    expect(await profileLink()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 4 · Acceptance                                                      */
/* ------------------------------------------------------------------ */

describe("activate_my_membership", () => {
  beforeEach(async () => {
    await invite(HR_USER, EMPLOYEES.aColleague, NEW_USER);
    await db.query("delete from public.audit_logs");
  });

  it("activates the invitee's own membership", async () => {
    expect((await activate(NEW_USER)).status).toBe("activated");
    expect(await membershipStatus(NEW_USER)).toBe("active");

    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("employee.account_linked");
  });

  it("is idempotent — refreshing the welcome page changes nothing", async () => {
    await activate(NEW_USER);
    expect((await activate(NEW_USER)).status).toBe("nothing_to_activate");
    expect(await membershipStatus(NEW_USER)).toBe("active");

    const { rows } = await db.query(
      "select count(*)::int as c from public.company_memberships where profile_id = $1",
      [NEW_USER]
    );
    expect(Number(rows[0].c)).toBe(1);
    expect(await audits()).toHaveLength(1);
  });

  it("cannot activate somebody else's invitation", async () => {
    expect((await activate(OTHER_USER)).status).toBe("nothing_to_activate");
    expect(await membershipStatus(NEW_USER)).toBe("invited");
  });

  it("cannot reopen a suspended membership — a replay is not a way back in", async () => {
    await activate(NEW_USER);
    await setAccess(USERS.aAdmin, EMPLOYEES.aColleague, true);
    expect(await membershipStatus(NEW_USER)).toBe("suspended");

    expect((await activate(NEW_USER)).status).toBe("nothing_to_activate");
    expect(await membershipStatus(NEW_USER)).toBe("suspended");
  });

  it("someone terminated between invite and acceptance cannot let themselves in", async () => {
    // The gap this test found: termination originally suspended only 'active'
    // memberships, so a stale invitation still activated cleanly.
    const result = await setStatus(HR_USER, EMPLOYEES.aColleague, "terminated");
    expect(result.access).toBe("suspended");
    expect(await membershipStatus(NEW_USER)).toBe("suspended");

    expect((await activate(NEW_USER)).status).toBe("nothing_to_activate");
    expect(await membershipStatus(NEW_USER)).toBe("suspended");
  });
});

/* ------------------------------------------------------------------ */
/* 5 · Access administration                                           */
/* ------------------------------------------------------------------ */

describe("set_membership_access", () => {
  it("a COMPANY_ADMIN suspends and reactivates", async () => {
    expect((await setAccess(USERS.aAdmin, EMPLOYEES.aSelf, true)).status).toBe("suspended");
    expect(await membershipStatus(USERS.aWorker)).toBe("suspended");
    expect((await setAccess(USERS.aAdmin, EMPLOYEES.aSelf, false)).status).toBe("reactivated");
    expect(await membershipStatus(USERS.aWorker)).toBe("active");
    expect(await audits()).toHaveLength(2);
  });

  it("HR cannot — taking access away is a security act, not an HR one", async () => {
    expect((await setAccess(HR_USER, EMPLOYEES.aSelf, true)).status).toBe("forbidden");
    expect(await membershipStatus(USERS.aWorker)).toBe("active");
  });

  it("a DISPATCHER and an EMPLOYEE cannot", async () => {
    for (const user of [USERS.aDispatcher, USERS.aWorker]) {
      expect((await setAccess(user, EMPLOYEES.aSelf, true)).status).toBe("forbidden");
    }
    expect(await membershipStatus(USERS.aWorker)).toBe("active");
  });

  it("will not activate an invitation nobody accepted", async () => {
    await invite(HR_USER, EMPLOYEES.aColleague, NEW_USER);
    expect((await setAccess(USERS.aAdmin, EMPLOYEES.aColleague, false)).status).toBe(
      "still_invited"
    );
    expect(await membershipStatus(NEW_USER)).toBe("invited");
  });

  it("refuses an employee with no account, and a no-op", async () => {
    expect((await setAccess(USERS.aAdmin, EMPLOYEES.aColleague, true)).status).toBe("no_account");
    await setAccess(USERS.aAdmin, EMPLOYEES.aSelf, true);
    expect((await setAccess(USERS.aAdmin, EMPLOYEES.aSelf, true)).status).toBe("unchanged");
  });

  it("is not found across a tenant boundary", async () => {
    expect((await setAccess(USERS.bAdmin, EMPLOYEES.aSelf, true)).status).toBe("not_found");
    expect(await membershipStatus(USERS.aWorker)).toBe("active");
  });
});

/* ------------------------------------------------------------------ */
/* 6 · Access follows employment                                       */
/* ------------------------------------------------------------------ */

describe("termination and access, in one transaction", () => {
  it("terminating suspends the linked membership and says so", async () => {
    const result = await setStatus(HR_USER, EMPLOYEES.aSelf, "terminated");
    expect(result.status).toBe("changed");
    expect(result.access).toBe("suspended");
    expect(await membershipStatus(USERS.aWorker)).toBe("suspended");

    const log = await audits();
    expect(log).toHaveLength(1);
    expect((log[0].diff as Record<string, unknown>).access).toBe("suspended");
  });

  it("on leave and probation keep access", async () => {
    for (const status of ["on_leave", "probation"]) {
      await setEmploymentStatus(db, COMPANY_A);
      const result = await setStatus(HR_USER, EMPLOYEES.aSelf, status);
      expect(result.access).toBe("unchanged");
      expect(await membershipStatus(USERS.aWorker)).toBe("active");
    }
  });

  it("reactivation reopens access", async () => {
    await setStatus(HR_USER, EMPLOYEES.aSelf, "terminated");
    const back = await setStatus(HR_USER, EMPLOYEES.aSelf, "active");
    expect(back.access).toBe("reactivated");
    expect(await membershipStatus(USERS.aWorker)).toBe("active");
  });

  it("does NOT reopen a membership an admin suspended deliberately", async () => {
    await setAccess(USERS.aAdmin, EMPLOYEES.aSelf, true);
    // Employment never left 'active', so this is a plain status move.
    const result = await setStatus(HR_USER, EMPLOYEES.aSelf, "on_leave");
    expect(result.access).toBe("unchanged");
    expect(await membershipStatus(USERS.aWorker)).toBe("suspended");
  });

  it("an employee with no account reports no access change", async () => {
    const result = await setStatus(HR_USER, EMPLOYEES.aColleague, "terminated");
    expect(result.status).toBe("changed");
    expect(result.access).toBe("unchanged");
  });

  it("terminated means the data is gone too, not just the route", async () => {
    await setStatus(HR_USER, EMPLOYEES.aSelf, "terminated");
    const resolved = await runAs(
      USERS.aWorker,
      async (q) =>
        (await q("select app.current_employee_id($1) as id", [COMPANY_A])).rows[0].id as
          | string
          | null
    );
    expect(resolved).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 7 · Escalation and tenants                                          */
/* ------------------------------------------------------------------ */

describe("no path to privilege", () => {
  it("an employee cannot touch any membership", async () => {
    for (const sql of [
      "update public.company_memberships set role='COMPANY_ADMIN' where profile_id=$1",
      "update public.company_memberships set status='active' where profile_id=$1",
    ]) {
      expect(await attempt(USERS.aWorker, sql, [USERS.aWorker])).toBe(0);
    }
    const insert = await attempt(
      USERS.aWorker,
      `insert into public.company_memberships (profile_id, company_id, role, status)
       values ($1, $2, 'COMPANY_ADMIN', 'active')`,
      [USERS.aWorker, COMPANY_B]
    );
    expect(String(insert)).toContain("row-level security");
  });

  it("HR still cannot write memberships directly — only through the RPCs", async () => {
    const insert = await attempt(
      HR_USER,
      `insert into public.company_memberships (profile_id, company_id, role, status)
       values ($1, $2, 'COMPANY_ADMIN', 'active')`,
      [NEW_USER, COMPANY_A]
    );
    expect(String(insert)).toContain("row-level security");
    expect(
      await attempt(
        HR_USER,
        "update public.company_memberships set role='COMPANY_ADMIN' where profile_id=$1",
        [USERS.aWorker]
      )
    ).toBe(0);
  });

  it("the invite path always writes EMPLOYEE, whoever calls it", async () => {
    await invite(HR_USER, EMPLOYEES.aColleague, NEW_USER);
    const { rows } = await db.query(
      "select role, status from public.company_memberships where profile_id = $1",
      [NEW_USER]
    );
    expect(rows[0]).toEqual({ role: "EMPLOYEE", status: "invited" });
  });

  it("company B cannot invite or link company A's employee", async () => {
    expect((await invite(USERS.bAdmin, EMPLOYEES.aColleague, NEW_USER)).status).toBe("not_found");
    const direct = await attempt(
      USERS.bAdmin,
      "update public.employees set profile_id = $2 where id = $1",
      [EMPLOYEES.aColleague, NEW_USER]
    );
    expect(typeof direct === "number" ? direct : 0).toBe(0);
    expect(await profileLink()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 8 · Concurrency                                                     */
/* ------------------------------------------------------------------ */

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
  ) {
    const first = await Promise.race(entries.map((e) => e.promise));
    const winner = entries.find((e) => e.client === first.client)!;
    const loser = entries.find((e) => e.client !== first.client)!;
    await winner.client.query("commit");
    const second = await loser.promise;
    await loser.client.query("commit");
    return [first, second];
  }

  it("two managers inviting the same person produce one membership", async () => {
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();
    try {
      await beginAs(a, HR_USER);
      await beginAs(b, USERS.aAdmin);
      const [first, second] = await race([
        {
          client: a,
          promise: a
            .query("select public.invite_employee($1, $2) as r", [EMPLOYEES.aColleague, NEW_USER])
            .then((r) => ({ client: a, result: r.rows[0].r as Result })),
        },
        {
          client: b,
          promise: b
            .query("select public.invite_employee($1, $2) as r", [EMPLOYEES.aColleague, OTHER_USER])
            .then((r) => ({ client: b, result: r.rows[0].r as Result })),
        },
      ]);
      expect(first.result.status).toBe("invited");
      expect(second.result.status).toBe("already_linked");
    } finally {
      await a.end();
      await b.end();
    }

    const { rows } = await db.query(
      "select count(*)::int as c from public.company_memberships where profile_id in ($1,$2)",
      [NEW_USER, OTHER_USER]
    );
    expect(Number(rows[0].c)).toBe(1);
    expect(await audits()).toHaveLength(1);
  });

  it("invitation racing termination leaves one consistent outcome", async () => {
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();
    try {
      await beginAs(a, HR_USER);
      await beginAs(b, USERS.aAdmin);
      await race([
        {
          client: a,
          promise: a
            .query("select public.invite_employee($1, $2) as r", [EMPLOYEES.aColleague, NEW_USER])
            .then((r) => ({ client: a, result: r.rows[0].r as Result })),
        },
        {
          client: b,
          promise: b
            .query("select public.set_employment_status($1, 'terminated') as r", [
              EMPLOYEES.aColleague,
            ])
            .then((r) => ({ client: b, result: r.rows[0].r as Result })),
        },
      ]);
    } finally {
      await a.end();
      await b.end();
    }

    // Both serialise on the employee lock. Whatever the order, a terminated
    // employee never ends up with an ACTIVE membership.
    const { rows } = await db.query("select employment_status from public.employees where id = $1", [
      EMPLOYEES.aColleague,
    ]);
    if (rows[0].employment_status === "terminated") {
      expect(["invited", "suspended", undefined]).toContain(await membershipStatus(NEW_USER));
    }
  });

  it("two admins suspending the same account produce one change", async () => {
    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();
    try {
      await beginAs(a, USERS.aAdmin);
      await beginAs(b, USERS.aAdmin);
      const call2 = (client: Client) =>
        client
          .query("select public.set_membership_access($1, true) as r", [EMPLOYEES.aSelf])
          .then((r) => ({ client, result: r.rows[0].r as Result }));
      const [first, second] = await race([
        { client: a, promise: call2(a) },
        { client: b, promise: call2(b) },
      ]);
      expect(first.result.status).toBe("suspended");
      expect(second.result.status).toBe("unchanged");
    } finally {
      await a.end();
      await b.end();
    }
    expect(await audits()).toHaveLength(1);
  });
});

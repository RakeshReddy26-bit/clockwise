/**
 * Tenant-isolation tests.
 * Runs migrations + fixtures against a local Postgres with a Supabase shim
 * (roles anon/authenticated/service_role, auth.users, auth.uid()) and then
 * executes queries as specific users via `set local role` + JWT claims —
 * exactly how PostgREST/Supabase executes them.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";
const DB_NAME = "clockwise_isolation_test";

const USERS = {
  aAdmin: "aaaaaaaa-0000-0000-0000-000000000001",
  aDispatcher: "aaaaaaaa-0000-0000-0000-000000000002",
  aWorker: "aaaaaaaa-0000-0000-0000-000000000003",
  bAdmin: "bbbbbbbb-0000-0000-0000-000000000001",
  bWorker: "bbbbbbbb-0000-0000-0000-000000000003",
} as const;

const COMPANY_A = "11111111-0000-0000-0000-000000000000";

let db: Client;

function sqlFile(...rel: string[]) {
  return readFileSync(join(__dirname, ...rel), "utf8");
}

/** Run fn inside a transaction executing as `userId` under RLS. */
async function runAs<T>(
  userId: string,
  fn: (q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>) => Promise<T>,
  { commit = false }: { commit?: boolean } = {}
): Promise<T> {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const result = await fn((text, params) => db.query(text, params as never));
    await db.query(commit ? "commit" : "rollback");
    return result;
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}

beforeAll(async () => {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, `/${DB_NAME}`) });
  await db.connect();
  await db.query(sqlFile("00-supabase-shim.sql"));
  await db.query(sqlFile("..", "..", "supabase", "migrations", "0001_schema.sql"));
  await db.query(sqlFile("..", "..", "supabase", "migrations", "0002_rls.sql"));
  await db.query(sqlFile("..", "..", "supabase", "migrations", "0003_auth_profile_trigger.sql"));
  await db.query(sqlFile("..", "..", "supabase", "migrations", "0004_geofencing.sql"));
  await db.query(sqlFile("01-test-fixtures.sql"));
}, 60_000);

afterAll(async () => {
  await db?.end();
});

describe("tenant isolation — reads", () => {
  it("admin A sees only company A employees", async () => {
    const rows = await runAs(USERS.aAdmin, async (q) => (await q("select company_id from employees")).rows);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.company_id === COMPANY_A)).toBe(true);
  });

  it("admin A cannot read a company B employee even by id", async () => {
    const rows = await runAs(USERS.aAdmin, async (q) =>
      (await q("select id from employees where id = $1", ["bbbb1111-0000-0000-0000-000000000001"])).rows
    );
    expect(rows.length).toBe(0);
  });

  it("employee A sees only their own employee row", async () => {
    const rows = await runAs(USERS.aWorker, async (q) => (await q("select employee_no from employees")).rows);
    expect(rows.map((r) => r.employee_no)).toEqual(["A-001"]);
  });

  it("employee A sees only shifts they are assigned to; B's shifts are invisible", async () => {
    const rows = await runAs(USERS.aWorker, async (q) => (await q("select company_id from shifts")).rows);
    expect(rows.length).toBe(1);
    expect(rows[0].company_id).toBe(COMPANY_A);
  });

  it("worker B sees zero company A data across tables", async () => {
    const counts = await runAs(USERS.bWorker, async (q) => ({
      employees: (await q("select count(*)::int as c from employees where company_id = $1", [COMPANY_A])).rows[0].c,
      shifts: (await q("select count(*)::int as c from shifts where company_id = $1", [COMPANY_A])).rows[0].c,
      companies: (await q("select count(*)::int as c from companies where id = $1", [COMPANY_A])).rows[0].c,
      conversations: (await q("select count(*)::int as c from conversations")).rows[0].c,
      notifications: (await q("select count(*)::int as c from notifications where company_id = $1", [COMPANY_A])).rows[0].c,
    }));
    expect(counts).toEqual({ employees: 0, shifts: 0, companies: 0, conversations: 0, notifications: 0 });
  });

  it("notifications are visible only to their recipient", async () => {
    const rows = await runAs(USERS.aWorker, async (q) => (await q("select profile_id from notifications")).rows);
    expect(rows.length).toBe(1);
    expect(rows[0].profile_id).toBe(USERS.aWorker);
  });

  it("messages are visible only to conversation participants", async () => {
    const asParticipant = await runAs(USERS.aWorker, async (q) => (await q("select body from messages")).rows);
    expect(asParticipant.length).toBe(1);
    // Admin A is NOT a participant of the fixture conversation
    const asNonParticipant = await runAs(USERS.aAdmin, async (q) => (await q("select body from messages")).rows);
    expect(asNonParticipant.length).toBe(0);
  });
});

describe("tenant isolation — writes", () => {
  it("admin A cannot update a company B employee (0 rows affected)", async () => {
    const count = await runAs(USERS.aAdmin, async (q) =>
      (await q("update employees set position = 'x' where id = $1", ["bbbb1111-0000-0000-0000-000000000001"])).rowCount
    );
    expect(count).toBe(0);
  });

  it("employee A cannot insert a vacation request for a colleague", async () => {
    await expect(
      runAs(USERS.aWorker, (q) =>
        q(
          `insert into vacation_requests (company_id, employee_id, start_date, end_date, days_count)
           values ($1, $2, '2026-10-01', '2026-10-03', 3)`,
          [COMPANY_A, "aaaa1111-0000-0000-0000-000000000002"]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("employee A can insert a vacation request for themselves", async () => {
    const count = await runAs(USERS.aWorker, async (q) =>
      (await q(
        `insert into vacation_requests (company_id, employee_id, start_date, end_date, days_count)
         values ($1, $2, '2026-10-01', '2026-10-03', 3)`,
        [COMPANY_A, "aaaa1111-0000-0000-0000-000000000001"]
      )).rowCount
    );
    expect(count).toBe(1);
  });

  it("employee B cannot insert data into company A even with known ids", async () => {
    await expect(
      runAs(USERS.bWorker, (q) =>
        q(
          `insert into cancellation_requests (company_id, shift_assignment_id, reason)
           values ($1, $2, 'x')`,
          [COMPANY_A, "aaaa4444-0000-0000-0000-000000000001"]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("employee A can accept their assignment, but not mark it completed", async () => {
    const accepted = await runAs(USERS.aWorker, async (q) =>
      (await q("update shift_assignments set status = 'accepted' where id = $1", [
        "aaaa4444-0000-0000-0000-000000000001",
      ])).rowCount
    );
    expect(accepted).toBe(1);

    await expect(
      runAs(USERS.aWorker, (q) =>
        q("update shift_assignments set status = 'completed' where id = $1", [
          "aaaa4444-0000-0000-0000-000000000001",
        ])
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("employee A cannot publish news or create locations", async () => {
    await expect(
      runAs(USERS.aWorker, (q) =>
        q("insert into news_posts (company_id, title, body, published_at) values ($1,'t','b',now())", [COMPANY_A])
      )
    ).rejects.toThrow(/row-level security/);
    await expect(
      runAs(USERS.aWorker, (q) =>
        q("insert into locations (company_id, name) values ($1,'x')", [COMPANY_A])
      )
    ).rejects.toThrow(/row-level security/);
  });
});

describe("staffing recalculation", () => {
  it("assignment lifecycle drives shift status open ↔ staffed", async () => {
    // required_count = 2, one active assignment → open
    const before = await runAs(USERS.aDispatcher, async (q) =>
      (await q("select status from shifts where id = $1", ["aaaa3333-0000-0000-0000-000000000001"])).rows[0].status
    );
    expect(before).toBe("open");

    // dispatcher assigns the second employee → staffed; cancel → open again
    await runAs(
      USERS.aDispatcher,
      async (q) => {
        await q(
          `insert into shift_assignments (company_id, shift_id, employee_id, status)
           values ($1, $2, $3, 'assigned')`,
          [COMPANY_A, "aaaa3333-0000-0000-0000-000000000001", "aaaa1111-0000-0000-0000-000000000002"]
        );
        const staffed = (await q("select status from shifts where id = $1", ["aaaa3333-0000-0000-0000-000000000001"]))
          .rows[0].status;
        expect(staffed).toBe("staffed");

        await q("update shift_assignments set status = 'cancelled' where employee_id = $1", [
          "aaaa1111-0000-0000-0000-000000000002",
        ]);
        const reopened = (await q("select status from shifts where id = $1", ["aaaa3333-0000-0000-0000-000000000001"]))
          .rows[0].status;
        expect(reopened).toBe("open");
      }
    );
  });
});

describe("service role", () => {
  it("bypasses RLS (needed for provisioning and seed tooling)", async () => {
    await db.query("begin");
    await db.query("set local role service_role");
    const { rows } = await db.query("select count(*)::int as c from employees");
    await db.query("rollback");
    expect(rows[0].c).toBe(3);
  });
});

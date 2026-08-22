/**
 * Attendance-alert persistence: idempotency (the unique key that makes the
 * cron-safe runner safe) and tenant isolation at the RLS layer.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { createTestDatabase, runAs as runAsUser, type QueryFn } from "./helpers";

const DB_NAME = "clockwise_attendance_test";

const A_ADMIN = "aaaaaaaa-0000-0000-0000-000000000001";
const A_DISPATCHER = "aaaaaaaa-0000-0000-0000-000000000002";
const A_WORKER = "aaaaaaaa-0000-0000-0000-000000000003";
const B_ADMIN = "bbbbbbbb-0000-0000-0000-000000000001";
const COMPANY_A = "11111111-0000-0000-0000-000000000000";
const A_EMP_SELF = "aaaa1111-0000-0000-0000-000000000001";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

/** Simulates the runner's upsert: insert-if-absent on (assignment, type). */
async function upsertAlert(type: string, minutes: number) {
  const { rows } = await db.query(
    `insert into public.attendance_alerts
       (company_id, employee_id, shift_assignment_id, type, minutes_delta)
     values ($1, $2, $3, $4, $5)
     on conflict (shift_assignment_id, type) do nothing
     returning id`,
    [COMPANY_A, A_EMP_SELF, A_ASSIGNMENT, type, minutes]
  );
  return rows.length; // 1 = created, 0 = already existed
}

beforeAll(async () => {
  db = await createTestDatabase(DB_NAME);
}, 60_000);

afterAll(async () => {
  await db?.end();
});

describe("alert idempotency (cron-safe)", () => {
  it("repeated evaluation runs never duplicate an alert", async () => {
    expect(await upsertAlert("late_clock_in", 12)).toBe(1); // first run creates
    expect(await upsertAlert("late_clock_in", 30)).toBe(0); // later runs no-op
    expect(await upsertAlert("late_clock_in", 90)).toBe(0);

    const { rows } = await db.query(
      "select count(*)::int as c, min(minutes_delta) as m from public.attendance_alerts where shift_assignment_id = $1 and type = 'late_clock_in'",
      [A_ASSIGNMENT]
    );
    expect(rows[0].c).toBe(1);
    // the original measurement is preserved — history is not rewritten
    expect(rows[0].m).toBe(12);
  });

  it("escalation adds a distinct no-show row alongside the late row", async () => {
    expect(await upsertAlert("no_show", 47)).toBe(1);
    expect(await upsertAlert("no_show", 60)).toBe(0);
    const { rows } = await db.query(
      "select type from public.attendance_alerts where shift_assignment_id = $1 order by type",
      [A_ASSIGNMENT]
    );
    expect(rows.map((r) => r.type)).toEqual(["late_clock_in", "no_show"]);
  });

  it("different alert types coexist for the same assignment", async () => {
    expect(await upsertAlert("early_clock_out", 75)).toBe(1);
    const { rows } = await db.query(
      "select count(*)::int as c from public.attendance_alerts where shift_assignment_id = $1",
      [A_ASSIGNMENT]
    );
    expect(rows[0].c).toBe(3);
  });
});

describe("tenant isolation for attendance alerts", () => {
  it("staff of company A read their own alerts", async () => {
    const rows = await runAs(A_DISPATCHER, async (q) =>
      (await q("select id, company_id from attendance_alerts")).rows
    );
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.company_id === COMPANY_A)).toBe(true);
  });

  it("company B admin sees none of company A's alerts", async () => {
    const rows = await runAs(B_ADMIN, async (q) => (await q("select id from attendance_alerts")).rows);
    expect(rows.length).toBe(0);
  });

  it("employees never read attendance alerts — not even their own", async () => {
    const rows = await runAs(A_WORKER, async (q) => (await q("select id from attendance_alerts")).rows);
    expect(rows.length).toBe(0);
  });

  it("employees cannot fabricate an alert", async () => {
    await expect(
      runAs(A_WORKER, (q) =>
        q(
          `insert into attendance_alerts (company_id, employee_id, shift_assignment_id, type)
           values ($1, $2, $3, 'no_show')`,
          [COMPANY_A, A_EMP_SELF, A_ASSIGNMENT]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("alerts are written by the evaluation runner (service role), not by users", async () => {
    await expect(
      runAs(A_ADMIN, (q) =>
        q(
          `insert into attendance_alerts (company_id, employee_id, shift_assignment_id, type)
           values ($1, $2, $3, 'late_clock_in')`,
          [COMPANY_A, A_EMP_SELF, A_ASSIGNMENT]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("cross-tenant acknowledgement is impossible", async () => {
    const count = await runAs(B_ADMIN, async (q) =>
      (await q("update attendance_alerts set status = 'acknowledged' where company_id = $1", [COMPANY_A]))
        .rowCount
    );
    expect(count).toBe(0);
  });

  it("staff can acknowledge alerts inside their tenant", async () => {
    const count = await runAs(A_DISPATCHER, async (q) =>
      (await q(
        "update attendance_alerts set status = 'acknowledged', acknowledged_by = $1, acknowledged_at = now() where company_id = $2",
        [A_DISPATCHER, COMPANY_A]
      )).rowCount
    );
    expect(count).toBe(3);
  });
});

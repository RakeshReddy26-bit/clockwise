/**
 * Geofence RLS tests: spoofing, cross-tenant access, manual override
 * authorization, and clock-out guarantees — at the database layer.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { createTestDatabase, runAs as runAsUser, type QueryFn } from "./helpers";

const DB_NAME = "clockwise_geofence_test";

const A_WORKER = "aaaaaaaa-0000-0000-0000-000000000003";
const A_DISPATCHER = "aaaaaaaa-0000-0000-0000-000000000002";
const B_WORKER = "bbbbbbbb-0000-0000-0000-000000000003";
const COMPANY_A = "11111111-0000-0000-0000-000000000000";
const COMPANY_B = "22222222-0000-0000-0000-000000000000";
const A_EMP_SELF = "aaaa1111-0000-0000-0000-000000000001";
const A_EMP_OTHER = "aaaa1111-0000-0000-0000-000000000002";
const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";

let db: Client;

async function runAs<T>(
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  return runAsUser(db, userId, fn, options);
}

beforeAll(async () => {
  db = await createTestDatabase(DB_NAME);
}, 60_000);

afterAll(async () => {
  await db?.end();
});

describe("4. assignment spoofing", () => {
  it("employee cannot create a time entry for another employee", async () => {
    await expect(
      runAs(A_WORKER, (q) =>
        q(
          `insert into time_entries (company_id, employee_id, shift_assignment_id, clock_in, clock_in_location_status)
           values ($1, $2, $3, now(), 'verified')`,
          [COMPANY_A, A_EMP_OTHER, A_ASSIGNMENT]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("employee cannot log a location event for another employee", async () => {
    await expect(
      runAs(A_WORKER, (q) =>
        q(
          `insert into location_events (company_id, employee_id, event_type)
           values ($1, $2, 'clock_in_verified')`,
          [COMPANY_A, A_EMP_OTHER]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("employee cannot file a manual request for another employee's assignment", async () => {
    await expect(
      runAs(B_WORKER, (q) =>
        q(
          `insert into manual_clockin_requests (company_id, shift_assignment_id, employee_id, reason)
           values ($1, $2, $3, 'gps_inaccurate')`,
          [COMPANY_A, A_ASSIGNMENT, A_EMP_SELF]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });
});

describe("5. cross-tenant isolation for geofence data", () => {
  it("company A worker cannot read company B locations (geofence config)", async () => {
    const rows = await runAs(A_WORKER, async (q) =>
      (await q("select id from locations where company_id = $1", [COMPANY_B])).rows
    );
    expect(rows.length).toBe(0);
  });

  it("company B worker sees no company A location events", async () => {
    // seed one event as A worker
    await runAs(
      A_WORKER,
      (q) =>
        q(
          `insert into location_events (company_id, employee_id, shift_assignment_id, event_type, distance_m, allowed_radius_m)
           values ($1, $2, $3, 'clock_in_outside_geofence', 420, 100)`,
          [COMPANY_A, A_EMP_SELF, A_ASSIGNMENT]
        ),
      { commit: true }
    );
    const rows = await runAs(B_WORKER, async (q) => (await q("select id from location_events")).rows);
    expect(rows.length).toBe(0);
  });

  it("location events are append-only even for staff (no update policy)", async () => {
    const count = await runAs(A_DISPATCHER, async (q) =>
      (await q("update location_events set distance_m = 1 where company_id = $1", [COMPANY_A])).rowCount
    );
    expect(count).toBe(0);
  });
});

describe("8 + 9. manual override flow", () => {
  it("employee files a manual request for their own assignment", async () => {
    const count = await runAs(
      A_WORKER,
      async (q) =>
        (await q(
          `insert into manual_clockin_requests (company_id, shift_assignment_id, employee_id, reason, distance_m)
           values ($1, $2, $3, 'gps_inaccurate', 128)`,
          [COMPANY_A, A_ASSIGNMENT, A_EMP_SELF]
        )).rowCount,
      { commit: true }
    );
    expect(count).toBe(1);
  });

  it("employee cannot approve their own request", async () => {
    const count = await runAs(A_WORKER, async (q) =>
      (await q(
        "update manual_clockin_requests set status = 'approved' where employee_id = $1",
        [A_EMP_SELF]
      )).rowCount
    );
    expect(count).toBe(0);
  });

  it("employee from another tenant cannot even see the request", async () => {
    const rows = await runAs(B_WORKER, async (q) =>
      (await q("select id from manual_clockin_requests")).rows
    );
    expect(rows.length).toBe(0);
  });

  it("dispatcher (time.manage role) approves and creates a manager_override entry", async () => {
    await runAs(
      A_DISPATCHER,
      async (q) => {
        const approved = (await q(
          `update manual_clockin_requests set status = 'approved', decided_by = $1, decided_at = now()
           where shift_assignment_id = $2 and status = 'pending'`,
          [A_DISPATCHER, A_ASSIGNMENT]
        )).rowCount;
        expect(approved).toBe(1);

        const entry = (await q(
          `insert into time_entries (company_id, employee_id, shift_assignment_id, clock_in, source, clock_in_location_status, clock_in_distance_m)
           values ($1, $2, $3, now(), 'manual', 'manager_override', 128) returning clock_in_location_status`,
          [COMPANY_A, A_EMP_SELF, A_ASSIGNMENT]
        )).rows[0];
        // The override is never hidden
        expect(entry.clock_in_location_status).toBe("manager_override");
      },
      { commit: true }
    );
  });
});

describe("10. clock-out is never blocked", () => {
  it("employee can close their running entry regardless of location", async () => {
    const count = await runAs(A_WORKER, async (q) =>
      (await q(
        `update time_entries
         set clock_out = clock_in + interval '1 hour', status = 'completed',
             clock_out_location_status = 'outside_geofence', clock_out_distance_m = 950
         where employee_id = $1 and clock_out is null`,
        [A_EMP_SELF]
      )).rowCount
    );
    expect(count).toBeGreaterThan(0);
  });

  it("employee cannot close someone else's entry", async () => {
    // dispatcher opens an entry for the colleague
    await runAs(
      A_DISPATCHER,
      (q) =>
        q(
          `insert into time_entries (company_id, employee_id, clock_in, clock_in_location_status)
           values ($1, $2, now(), 'not_required')`,
          [COMPANY_A, A_EMP_OTHER]
        ),
      { commit: true }
    );
    const count = await runAs(A_WORKER, async (q) =>
      (await q(
        "update time_entries set clock_out = now(), status = 'completed' where employee_id = $1",
        [A_EMP_OTHER]
      )).rowCount
    );
    expect(count).toBe(0);
  });
});

describe("geofence config", () => {
  it("radius is per-location and constrained to a sane range", async () => {
    await expect(
      runAs(A_DISPATCHER, (q) =>
        q("update locations set geofence_radius_m = 999999 where company_id = $1", [COMPANY_A])
      )
    ).rejects.toThrow(/check constraint/);
    const count = await runAs(A_DISPATCHER, async (q) =>
      (await q("update locations set geofence_radius_m = 250 where company_id = $1", [COMPANY_A])).rowCount
    );
    expect(count).toBe(1);
  });
});

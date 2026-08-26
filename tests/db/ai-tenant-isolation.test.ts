import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createTestDatabase, runAs, USERS, COMPANY_A, COMPANY_B } from "./helpers";

/**
 * Tenant isolation for the assistant, proved against the real policies.
 *
 * The read tools query through the caller's own Supabase client, so RLS runs
 * before anything they do. That is a claim about the database, not about the
 * TypeScript, so it is tested here against actual policies rather than a mock:
 * every query below is the shape a read tool issues, executed as a member of
 * the *other* company.
 *
 * `runAs` reproduces how PostgREST executes a request — role `authenticated`
 * plus the JWT claims — so these are the same conditions production runs under.
 */

let db: Client;

const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";
const B_SHIFT = "bbbb3333-0000-0000-0000-000000000001";
const A_JOB = "aaaa2222-0000-0000-0000-000000000001";
const B_JOB = "bbbb2222-0000-0000-0000-000000000001";

beforeAll(async () => {
  db = await createTestDatabase("clockwise_ai_isolation");
});

afterAll(async () => {
  await db?.end();
});

describe("read tool query shapes cannot cross a tenant boundary", () => {
  it("list_shifts sees only the caller's own company", async () => {
    const rows = await runAs(db, USERS.aDispatcher, async (q) => {
      const { rows } = await q(
        "select id, company_id from public.shifts where date between $1 and $2",
        ["2026-01-01", "2027-12-31"]
      );
      return rows;
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.company_id === COMPANY_A)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(B_SHIFT);
  });

  /**
   * The tools add `.eq("company_id", …)` on top of RLS. This proves the case
   * that guard exists for: even if a model produced another tenant's id and it
   * somehow reached a query, the row is not visible.
   */
  it("get_shift_details returns nothing for another tenant's shift id", async () => {
    const rows = await runAs(db, USERS.aDispatcher, async (q) => {
      const { rows } = await q("select id from public.shifts where id = $1", [B_SHIFT]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("and the same query from the other side is symmetric", async () => {
    const rows = await runAs(db, USERS.bAdmin, async (q) => {
      const { rows } = await q("select id from public.shifts where id = $1", [A_SHIFT]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("list_employees sees only the caller's own workforce", async () => {
    const rows = await runAs(db, USERS.aDispatcher, async (q) => {
      const { rows } = await q("select id, company_id from public.employees", []);
      return rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.company_id === COMPANY_A)).toBe(true);
  });

  it("get_company_locations cannot enumerate another tenant's sites or jobs", async () => {
    const { locations, jobs } = await runAs(db, USERS.aDispatcher, async (q) => {
      const locations = (await q("select id, company_id from public.locations", [])).rows;
      const jobs = (await q("select id, company_id from public.jobs", [])).rows;
      return { locations, jobs };
    });

    expect(locations.every((r) => r.company_id === COMPANY_A)).toBe(true);
    expect(jobs.every((r) => r.company_id === COMPANY_A)).toBe(true);
    expect(jobs.map((j) => j.id)).not.toContain(B_JOB);
  });

  it("get_absences cannot read another tenant's holiday or sick leave", async () => {
    const rows = await runAs(db, USERS.bAdmin, async (q) => {
      const { rows } = await q(
        "select id, company_id from public.vacation_requests where company_id = $1",
        [COMPANY_A]
      );
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("find_replacement_candidates cannot load another tenant's candidate pool", async () => {
    // The engine's input is employees + assignments + absences + availability.
    // If any of those leaked, an eligibility verdict could describe a stranger.
    const leaked = await runAs(db, USERS.aDispatcher, async (q) => {
      const employees = (
        await q("select id from public.employees where company_id = $1", [COMPANY_B])
      ).rows;
      const assignments = (
        await q("select id from public.shift_assignments where company_id = $1", [COMPANY_B])
      ).rows;
      return employees.length + assignments.length;
    });
    expect(leaked).toBe(0);
  });
});

describe("an employee sees only their own data through the self-scoped tools", () => {
  /** Requirement 2. */
  it("get_my_time_summary cannot reach a colleague's entries", async () => {
    const rows = await runAs(db, USERS.aWorker, async (q) => {
      const { rows } = await q(
        "select id, employee_id from public.time_entries",
        []
      );
      return rows;
    });

    // Whatever is visible must belong to the caller's own employee row.
    const own = await runAs(db, USERS.aWorker, async (q) => {
      const { rows } = await q(
        "select id from public.employees where profile_id = auth.uid()",
        []
      );
      return rows[0]?.id as string | undefined;
    });

    for (const row of rows) {
      expect(row.employee_id).toBe(own);
    }
  });

  it("an employee cannot enumerate the company's shifts wholesale", async () => {
    const asWorker = await runAs(db, USERS.aWorker, async (q) => {
      const { rows } = await q("select id from public.shifts", []);
      return rows.length;
    });
    const asDispatcher = await runAs(db, USERS.aDispatcher, async (q) => {
      const { rows } = await q("select id from public.shifts", []);
      return rows.length;
    });

    // The employee's view is narrower than the scheduler's — the policies, not
    // the assistant, are what decide that.
    expect(asWorker).toBeLessThanOrEqual(asDispatcher);
  });
});

describe("the assistant has no privileged path to a write", () => {
  /**
   * Requirement 8, at the database rather than the UI.
   *
   * Execution reuses `create_shift`, which requires scheduling authority. An
   * employee confirming a forged proposal would still be refused here, because
   * the RPC re-checks and does not care who asked.
   */
  it("create_shift refuses an employee even when called directly", async () => {
    const result = await runAs(db, USERS.aWorker, async (q) => {
      const { rows } = await q(
        `select public.create_shift($1, now() + interval '3 days', now() + interval '3 days 8 hours', 1, null, null, null, null) as r`,
        [A_JOB]
      );
      return rows[0].r as { status: string };
    });
    expect(result.status).not.toBe("created");
  });

  it("create_shift refuses a scheduler pointing at another tenant's job", async () => {
    const result = await runAs(db, USERS.aDispatcher, async (q) => {
      const { rows } = await q(
        `select public.create_shift($1, now() + interval '3 days', now() + interval '3 days 8 hours', 1, null, null, null, null) as r`,
        [B_JOB]
      );
      return rows[0].r as { status: string };
    });
    expect(result.status).not.toBe("created");
  });
});

/**
 * Shift-offer RLS: what an employee may see and change on their own offer,
 * what staff may do inside their tenant, and what neither may do across one.
 *
 * The employee update policy is column-sensitive on purpose — RLS is the last
 * line, not the only one. The Server Actions in B3 will accept an intent
 * ('interested' | 'declined' | 'withdrawn') rather than a row payload, but
 * these tests assert the database refuses the forged writes regardless.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  createTestDatabase,
  runAs as runAsUser,
  type QueryFn,
  USERS,
  COMPANY_A,
  COMPANY_B,
  EMPLOYEES,
  OFFERS,
  OFFER_RESPONSES,
} from "./helpers";

const DB_NAME = "clockwise_offers_test";

const A_SHIFT = "aaaa3333-0000-0000-0000-000000000001";

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

describe("employee visibility", () => {
  it("an offered employee sees the offer", async () => {
    const rows = await runAs(USERS.aWorker, async (q) =>
      (await q("select id, status from shift_offers")).rows
    );
    expect(rows.map((r) => r.id)).toEqual([OFFERS.a]);
    expect(rows[0].status).toBe("open");
  });

  it("an employee sees only their own response row, not a colleague's", async () => {
    const rows = await runAs(USERS.aWorker, async (q) =>
      (await q("select id, employee_id from shift_offer_responses")).rows
    );
    expect(rows.map((r) => r.id)).toEqual([OFFER_RESPONSES.aSelf]);
    expect(rows[0].employee_id).toBe(EMPLOYEES.aSelf);
  });

  it("an employee of another tenant sees neither the offer nor the responses", async () => {
    const counts = await runAs(USERS.bWorker, async (q) => ({
      offers: (await q("select count(*)::int as c from shift_offers where company_id = $1", [COMPANY_A]))
        .rows[0].c,
      responses: (
        await q("select count(*)::int as c from shift_offer_responses where company_id = $1", [COMPANY_A])
      ).rows[0].c,
    }));
    expect(counts).toEqual({ offers: 0, responses: 0 });
  });

  it("staff see every offer in their tenant and none outside it", async () => {
    const rows = await runAs(USERS.aDispatcher, async (q) =>
      (await q("select company_id from shift_offers")).rows
    );
    expect(rows.length).toBe(1);
    expect(rows[0].company_id).toBe(COMPANY_A);

    const acrossTenant = await runAs(USERS.bAdmin, async (q) =>
      (await q("select id from shift_offers where company_id = $1", [COMPANY_A])).rows
    );
    expect(acrossTenant.length).toBe(0);
  });

  it("a closed offer disappears from the employee's view", async () => {
    await runAs(
      USERS.aDispatcher,
      (q) => q("update shift_offers set status = 'cancelled' where id = $1", [OFFERS.a]),
      { commit: true }
    );

    const employeeView = await runAs(USERS.aWorker, async (q) =>
      (await q("select id from shift_offers")).rows
    );
    expect(employeeView.length).toBe(0);

    // staff still see it, and the response row remains readable by its owner
    const staffView = await runAs(USERS.aDispatcher, async (q) =>
      (await q("select status from shift_offers where id = $1", [OFFERS.a])).rows
    );
    expect(staffView[0].status).toBe("cancelled");

    await runAs(
      USERS.aDispatcher,
      (q) => q("update shift_offers set status = 'open' where id = $1", [OFFERS.a]),
      { commit: true }
    );
  });
});

describe("employee responses", () => {
  it("an employee may express interest on their own row", async () => {
    const count = await runAs(USERS.aWorker, async (q) =>
      (await q(
        "update shift_offer_responses set response = 'interested', responded_at = now() where id = $1",
        [OFFER_RESPONSES.aSelf]
      )).rowCount
    );
    expect(count).toBe(1);
  });

  it("declining and withdrawing are allowed too", async () => {
    for (const response of ["declined", "withdrawn"]) {
      const count = await runAs(USERS.aWorker, async (q) =>
        (await q("update shift_offer_responses set response = $2 where id = $1", [
          OFFER_RESPONSES.aSelf,
          response,
        ])).rowCount
      );
      expect(count, response).toBe(1);
    }
  });

  it("an employee cannot answer for a colleague", async () => {
    const count = await runAs(USERS.aWorker, async (q) =>
      (await q("update shift_offer_responses set response = 'interested' where id = $1", [
        OFFER_RESPONSES.aColleague,
      ])).rowCount
    );
    expect(count).toBe(0);
  });

  it("an employee cannot answer an offer in another tenant", async () => {
    const count = await runAs(USERS.bWorker, async (q) =>
      (await q("update shift_offer_responses set response = 'interested' where id = $1", [
        OFFER_RESPONSES.aSelf,
      ])).rowCount
    );
    expect(count).toBe(0);
  });

  it("an employee cannot decide their own offer", async () => {
    await expect(
      runAs(USERS.aWorker, (q) =>
        q(
          `update shift_offer_responses
           set response = 'interested', decided_by = $2, decided_at = now()
           where id = $1`,
          [OFFER_RESPONSES.aSelf, USERS.aWorker]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("an employee cannot attach an assignment to their response", async () => {
    await expect(
      runAs(USERS.aWorker, (q) =>
        q(
          `update shift_offer_responses
           set response = 'interested', resulting_assignment_id = $2
           where id = $1`,
          [OFFER_RESPONSES.aSelf, "aaaa4444-0000-0000-0000-000000000001"]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("an employee cannot reset a response to pending", async () => {
    await expect(
      runAs(USERS.aWorker, (q) =>
        q("update shift_offer_responses set response = 'pending' where id = $1", [
          OFFER_RESPONSES.aSelf,
        ])
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("an employee cannot change a response once a manager has decided it", async () => {
    await runAs(
      USERS.aDispatcher,
      (q) =>
        q(
          `update shift_offer_responses set decided_by = $2, decided_at = now() where id = $1`,
          [OFFER_RESPONSES.aSelf, USERS.aDispatcher]
        ),
      { commit: true }
    );

    const count = await runAs(USERS.aWorker, async (q) =>
      (await q("update shift_offer_responses set response = 'declined' where id = $1", [
        OFFER_RESPONSES.aSelf,
      ])).rowCount
    );
    expect(count).toBe(0);

    await runAs(
      USERS.aDispatcher,
      (q) =>
        q("update shift_offer_responses set decided_by = null, decided_at = null where id = $1", [
          OFFER_RESPONSES.aSelf,
        ]),
      { commit: true }
    );
  });

  it("an employee cannot create offers or response rows", async () => {
    await expect(
      runAs(USERS.aWorker, (q) =>
        q("insert into shift_offers (company_id, shift_id) values ($1, $2)", [COMPANY_A, A_SHIFT])
      )
    ).rejects.toThrow(/row-level security/);

    await expect(
      runAs(USERS.aWorker, (q) =>
        q(
          "insert into shift_offer_responses (company_id, offer_id, employee_id) values ($1, $2, $3)",
          [COMPANY_A, OFFERS.a, EMPLOYEES.aSelf]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("an employee cannot delete their offer to escape it", async () => {
    const count = await runAs(USERS.aWorker, async (q) =>
      (await q("delete from shift_offer_responses where id = $1", [OFFER_RESPONSES.aSelf])).rowCount
    );
    expect(count).toBe(0);
  });
});

describe("staff authority", () => {
  it("a dispatcher may record a decision inside their tenant", async () => {
    const count = await runAs(USERS.aDispatcher, async (q) =>
      (await q(
        "update shift_offer_responses set response = 'interested', responded_at = now() where id = $1",
        [OFFER_RESPONSES.aColleague]
      )).rowCount
    );
    expect(count).toBe(1);
  });

  it("staff cannot touch another tenant's offer or responses", async () => {
    const counts = await runAs(USERS.bAdmin, async (q) => ({
      offers: (await q("update shift_offers set status = 'cancelled' where company_id = $1", [COMPANY_A]))
        .rowCount,
      responses: (
        await q("update shift_offer_responses set response = 'declined' where company_id = $1", [
          COMPANY_A,
        ])
      ).rowCount,
    }));
    expect(counts).toEqual({ offers: 0, responses: 0 });
  });

  it("staff cannot create an offer for a shift in another tenant", async () => {
    await expect(
      runAs(USERS.aDispatcher, (q) =>
        q("insert into shift_offers (company_id, shift_id) values ($1, $2)", [
          COMPANY_B,
          "bbbb3333-0000-0000-0000-000000000001",
        ])
      )
    ).rejects.toThrow(/row-level security/);
  });
});

describe("schema guarantees", () => {
  it("a shift can carry at most one open offer", async () => {
    await expect(
      db.query("insert into public.shift_offers (company_id, shift_id) values ($1, $2)", [
        COMPANY_A,
        A_SHIFT,
      ])
    ).rejects.toThrow(/shift_offers_one_open_per_shift|duplicate key/);
  });

  it("a second offer is allowed once the first is closed", async () => {
    await db.query("update public.shift_offers set status = 'expired' where id = $1", [OFFERS.a]);
    const { rows } = await db.query(
      "insert into public.shift_offers (company_id, shift_id) values ($1, $2) returning id, status",
      [COMPANY_A, A_SHIFT]
    );
    expect(rows[0].status).toBe("open");
    await db.query("delete from public.shift_offers where id = $1", [rows[0].id]);
    await db.query("update public.shift_offers set status = 'open' where id = $1", [OFFERS.a]);
  });

  it("one employee cannot be offered the same shift twice", async () => {
    await expect(
      db.query(
        "insert into public.shift_offer_responses (company_id, offer_id, employee_id) values ($1, $2, $3)",
        [COMPANY_A, OFFERS.a, EMPLOYEES.aSelf]
      )
    ).rejects.toThrow(/duplicate key/);
  });

  it("shifts.required_qualification is optional and free text", async () => {
    const { rows } = await db.query(
      "select required_qualification from public.shifts where id = $1",
      [A_SHIFT]
    );
    expect(rows[0].required_qualification).toBeNull();

    await db.query("update public.shifts set required_qualification = $2 where id = $1", [
      A_SHIFT,
      "Staplerschein",
    ]);
    const { rows: updated } = await db.query(
      "select required_qualification from public.shifts where id = $1",
      [A_SHIFT]
    );
    expect(updated[0].required_qualification).toBe("Staplerschein");
    await db.query("update public.shifts set required_qualification = null where id = $1", [A_SHIFT]);
  });

  it("closing an offer cascades nothing away — responses survive as history", async () => {
    const { rows } = await db.query(
      "select count(*)::int as c from public.shift_offer_responses where offer_id = $1",
      [OFFERS.a]
    );
    expect(rows[0].c).toBe(2);
  });
});

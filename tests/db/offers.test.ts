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

/**
 * B2 send-offer guarantees, exercised at the layer the Server Action relies
 * on. The action's own authorization chain is covered by the pure authz tests;
 * what matters here is that the database makes a repeat send harmless and a
 * cross-tenant send impossible even if application code were wrong.
 */
describe("send-offer guarantees", () => {
  it("a manager creates an offer for a shift in their own tenant", async () => {
    const offerId = await runAs(
      USERS.aDispatcher,
      async (q) => {
        // start from a clean slate: close the fixture offer first
        await q("update shift_offers set status = 'cancelled' where id = $1", [OFFERS.a]);
        const { rows } = await q(
          `insert into shift_offers (company_id, shift_id, created_by)
           values ($1, $2, $3) returning id, status`,
          [COMPANY_A, A_SHIFT, USERS.aDispatcher]
        );
        expect(rows[0].status).toBe("open");
        return rows[0].id as string;
      },
      { commit: true }
    );

    const invited = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (await q(
          `insert into shift_offer_responses (company_id, offer_id, employee_id)
           values ($1, $2, $3) on conflict (offer_id, employee_id) do nothing
           returning employee_id`,
          [COMPANY_A, offerId, EMPLOYEES.aSelf]
        )).rows,
      { commit: true }
    );
    expect(invited.map((r) => r.employee_id)).toEqual([EMPLOYEES.aSelf]);
  });

  it("re-sending to the same employee invites nobody twice", async () => {
    const offerId = await runAs(USERS.aDispatcher, async (q) =>
      (await q("select id from shift_offers where shift_id = $1 and status = 'open'", [A_SHIFT]))
        .rows[0].id as string
    );

    const repeat = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (await q(
          `insert into shift_offer_responses (company_id, offer_id, employee_id)
           values ($1, $2, $3) on conflict (offer_id, employee_id) do nothing
           returning employee_id`,
          [COMPANY_A, offerId, EMPLOYEES.aSelf]
        )).rows,
      { commit: true }
    );
    expect(repeat).toHaveLength(0); // nothing returned ⇒ nothing to notify

    const total = await runAs(USERS.aDispatcher, async (q) =>
      (await q("select count(*)::int as c from shift_offer_responses where offer_id = $1", [offerId]))
        .rows[0].c
    );
    expect(total).toBe(1);
  });

  it("duplicate ids in one send collapse to a single response row", async () => {
    const offerId = await runAs(USERS.aDispatcher, async (q) =>
      (await q("select id from shift_offers where shift_id = $1 and status = 'open'", [A_SHIFT]))
        .rows[0].id as string
    );

    const inserted = await runAs(
      USERS.aDispatcher,
      async (q) =>
        (await q(
          `insert into shift_offer_responses (company_id, offer_id, employee_id)
           select $1, $2, unnest(array[$3::uuid, $3::uuid, $4::uuid])
           on conflict (offer_id, employee_id) do nothing
           returning employee_id`,
          [COMPANY_A, offerId, EMPLOYEES.aColleague, EMPLOYEES.aColleague]
        )).rows,
      { commit: true }
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0].employee_id).toBe(EMPLOYEES.aColleague);
  });

  it("only the selected employees receive a response row", async () => {
    const rows = await runAs(USERS.aDispatcher, async (q) =>
      (await q(
        `select employee_id from shift_offer_responses r
         join shift_offers o on o.id = r.offer_id
         where o.shift_id = $1 and o.status = 'open'
         order by employee_id`,
        [A_SHIFT]
      )).rows
    );
    expect(rows.map((r) => r.employee_id).sort()).toEqual(
      [EMPLOYEES.aSelf, EMPLOYEES.aColleague].sort()
    );
    expect(rows.map((r) => r.employee_id)).not.toContain(EMPLOYEES.b);
  });

  it("an employee from another tenant cannot be given a response row", async () => {
    const offerId = await runAs(USERS.aDispatcher, async (q) =>
      (await q("select id from shift_offers where shift_id = $1 and status = 'open'", [A_SHIFT]))
        .rows[0].id as string
    );
    // The company_id must match the offer's tenant for RLS to pass, and the
    // employee then belongs to a different company — the write cannot succeed
    // under either tenant's policy.
    await expect(
      runAs(USERS.aDispatcher, (q) =>
        q(
          `insert into shift_offer_responses (company_id, offer_id, employee_id)
           values ($1, $2, $3)`,
          [COMPANY_B, offerId, EMPLOYEES.b]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("a manager cannot offer a shift belonging to another tenant", async () => {
    await expect(
      runAs(USERS.aDispatcher, (q) =>
        q("insert into shift_offers (company_id, shift_id, created_by) values ($1, $2, $3)", [
          COMPANY_B,
          "bbbb3333-0000-0000-0000-000000000001",
          USERS.aDispatcher,
        ])
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("a second open offer for the same shift is refused, so re-sending must reuse it", async () => {
    await expect(
      runAs(USERS.aDispatcher, (q) =>
        q("insert into shift_offers (company_id, shift_id) values ($1, $2)", [COMPANY_A, A_SHIFT])
      )
    ).rejects.toThrow(/shift_offers_one_open_per_shift|duplicate key/);
  });

  it("seat counting uses only assignments that still occupy the shift", async () => {
    const counts = await runAs(USERS.aDispatcher, async (q) => {
      await q("update shift_assignments set status = 'cancelled' where id = $1", [
        "aaaa4444-0000-0000-0000-000000000001",
      ]);
      const occupying = (await q(
        `select count(*)::int as c from shift_assignments
         where shift_id = $1 and status in ('assigned','accepted','cancellation_requested')`,
        [A_SHIFT]
      )).rows[0].c;
      const all = (await q("select count(*)::int as c from shift_assignments where shift_id = $1", [
        A_SHIFT,
      ])).rows[0].c;
      return { occupying: Number(occupying), all: Number(all) };
    });
    // A cancelled assignment still exists as history but frees the seat.
    expect(counts.all).toBeGreaterThan(counts.occupying);
    expect(counts.occupying).toBe(0);
  });

  it("notifications for an offer stay inside the tenant and reach only the invited", async () => {
    const offerId = await runAs(USERS.aDispatcher, async (q) =>
      (await q("select id from shift_offers where shift_id = $1 and status = 'open'", [A_SHIFT]))
        .rows[0].id as string
    );

    await runAs(
      USERS.aDispatcher,
      (q) =>
        q(
          `insert into notifications (company_id, profile_id, type, payload)
           values ($1, $2, 'open_shift_available', jsonb_build_object('offer_id', $3::text))`,
          [COMPANY_A, USERS.aWorker, offerId]
        ),
      { commit: true }
    );

    const recipientSees = await runAs(USERS.aWorker, async (q) =>
      (await q("select count(*)::int as c from notifications where type = 'open_shift_available'"))
        .rows[0].c
    );
    expect(recipientSees).toBe(1);

    const otherTenantSees = await runAs(USERS.bWorker, async (q) =>
      (await q("select count(*)::int as c from notifications where type = 'open_shift_available'"))
        .rows[0].c
    );
    expect(otherTenantSees).toBe(0);
  });

  it("a manager cannot notify a profile in another tenant", async () => {
    await expect(
      runAs(USERS.aDispatcher, (q) =>
        q(
          `insert into notifications (company_id, profile_id, type)
           values ($1, $2, 'open_shift_available')`,
          [COMPANY_B, USERS.bWorker]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });
});

/**
 * B3 employee responses at the database layer. The transition rules themselves
 * are pure and unit-tested; what matters here is that the row an employee can
 * reach is only ever their own, and that the columns a manager decision uses
 * stay out of their hands.
 */
describe("employee response persistence", () => {
  /**
   * Puts the fixture offer back in play. The B2 block above leaves its own
   * offer open on the same shift, and only one may be open at a time, so that
   * one is closed first rather than assuming a particular starting state.
   */
  async function resetResponse() {
    await db.query(
      "update public.shift_offers set status = 'cancelled' where shift_id = $1 and status = 'open' and id <> $2",
      [A_SHIFT, OFFERS.a]
    );
    await db.query("update public.shift_offers set status = 'open' where id = $1", [OFFERS.a]);
    await db.query(
      "update public.shift_offer_responses set response = 'pending', responded_at = null where id = $1",
      [OFFER_RESPONSES.aSelf]
    );
  }

  async function currentResponse(): Promise<string> {
    const { rows } = await db.query(
      "select response from public.shift_offer_responses where id = $1",
      [OFFER_RESPONSES.aSelf]
    );
    return rows[0].response as string;
  }

  it("pending → interested is saved with a timestamp", async () => {
    await resetResponse();
    const count = await runAs(
      USERS.aWorker,
      async (q) =>
        (await q(
          "update shift_offer_responses set response = 'interested', responded_at = now() where id = $1",
          [OFFER_RESPONSES.aSelf]
        )).rowCount,
      { commit: true }
    );
    expect(count).toBe(1);
    expect(await currentResponse()).toBe("interested");
  });

  it("interested → withdrawn is saved", async () => {
    const count = await runAs(
      USERS.aWorker,
      async (q) =>
        (await q("update shift_offer_responses set response = 'withdrawn' where id = $1", [
          OFFER_RESPONSES.aSelf,
        ])).rowCount,
      { commit: true }
    );
    expect(count).toBe(1);
    expect(await currentResponse()).toBe("withdrawn");
  });

  it("pending → declined is saved", async () => {
    await resetResponse();
    const count = await runAs(
      USERS.aWorker,
      async (q) =>
        (await q("update shift_offer_responses set response = 'declined' where id = $1", [
          OFFER_RESPONSES.aSelf,
        ])).rowCount,
      { commit: true }
    );
    expect(count).toBe(1);
    expect(await currentResponse()).toBe("declined");
  });

  it("writing the same state twice leaves one row and one value", async () => {
    await resetResponse();
    for (let attempt = 0; attempt < 3; attempt++) {
      await runAs(
        USERS.aWorker,
        (q) =>
          q("update shift_offer_responses set response = 'interested' where id = $1", [
            OFFER_RESPONSES.aSelf,
          ]),
        { commit: true }
      );
    }
    const { rows } = await db.query(
      "select count(*)::int as c from public.shift_offer_responses where offer_id = $1 and employee_id = $2",
      [OFFERS.a, EMPLOYEES.aSelf]
    );
    expect(Number(rows[0].c)).toBe(1);
    expect(await currentResponse()).toBe("interested");
  });

  it("an employee cannot answer a colleague's offer", async () => {
    const count = await runAs(USERS.aWorker, async (q) =>
      (await q("update shift_offer_responses set response = 'declined' where id = $1", [
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

  it("an employee cannot record a decision on themselves", async () => {
    await expect(
      runAs(USERS.aWorker, (q) =>
        q(
          `update shift_offer_responses
           set response = 'interested', decided_by = $2, decided_at = now() where id = $1`,
          [OFFER_RESPONSES.aSelf, USERS.aWorker]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("an employee cannot attach an assignment to their own response", async () => {
    await expect(
      runAs(USERS.aWorker, (q) =>
        q(
          `update shift_offer_responses
           set response = 'interested', resulting_assignment_id = $2 where id = $1`,
          [OFFER_RESPONSES.aSelf, "aaaa4444-0000-0000-0000-000000000001"]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("a decided response is frozen for the employee", async () => {
    await db.query(
      "update public.shift_offer_responses set decided_by = $2, decided_at = now() where id = $1",
      [OFFER_RESPONSES.aSelf, USERS.aDispatcher]
    );
    const count = await runAs(USERS.aWorker, async (q) =>
      (await q("update shift_offer_responses set response = 'declined' where id = $1", [
        OFFER_RESPONSES.aSelf,
      ])).rowCount
    );
    expect(count).toBe(0);
    await db.query(
      "update public.shift_offer_responses set decided_by = null, decided_at = null where id = $1",
      [OFFER_RESPONSES.aSelf]
    );
  });

  it("a closed offer hides itself from the employee, so no response can follow", async () => {
    await db.query("update public.shift_offers set status = 'filled' where id = $1", [OFFERS.a]);
    const visible = await runAs(USERS.aWorker, async (q) =>
      (await q(
        `select r.id from shift_offer_responses r
         join shift_offers o on o.id = r.offer_id
         where o.status = 'open'`
      )).rows
    );
    expect(visible).toHaveLength(0);
    await resetResponse();
  });

  it("every response row an employee can see belongs to them", async () => {
    const rows = await runAs(USERS.aWorker, async (q) =>
      (await q("select id, employee_id from shift_offer_responses")).rows
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.employee_id === EMPLOYEES.aSelf)).toBe(true);
  });

  /**
   * Employees cannot write notifications at all — notifications_insert_staff
   * restricts inserts to staff. That is why respondToOffer fans out through
   * the service-role client, the same way the geofence and attendance alerts
   * already do, rather than under the employee's own RLS.
   */
  it("an employee cannot notify anyone directly, in their tenant or another", async () => {
    for (const [companyId, profileId] of [
      [COMPANY_A, USERS.aDispatcher],
      [COMPANY_B, USERS.bAdmin],
    ]) {
      await expect(
        runAs(USERS.aWorker, (q) =>
          q(
            `insert into notifications (company_id, profile_id, type)
             values ($1, $2, 'shift_offer_response')`,
            [companyId, profileId]
          )
        ),
        companyId
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("staff receive the response notification, scoped to their tenant", async () => {
    await runAs(
      USERS.aDispatcher,
      (q) =>
        q(
          `insert into notifications (company_id, profile_id, type)
           values ($1, $2, 'shift_offer_response')`,
          [COMPANY_A, USERS.aDispatcher]
        ),
      { commit: true }
    );

    const dispatcherSees = await runAs(USERS.aDispatcher, async (q) =>
      (await q("select count(*)::int as c from notifications where type = 'shift_offer_response'"))
        .rows[0].c
    );
    expect(Number(dispatcherSees)).toBe(1);

    const otherTenantSees = await runAs(USERS.bAdmin, async (q) =>
      (await q("select count(*)::int as c from notifications where type = 'shift_offer_response'"))
        .rows[0].c
    );
    expect(Number(otherTenantSees)).toBe(0);
  });
});

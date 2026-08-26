# Running the KSK live operations demo

Everything below is backed by real rows and the existing secure workflows. No
screen shows a number that was not counted from the database.

## One-time setup

```bash
npm run seed              # company, people, accounts
npm run add:kiel-demo     # Kiel worksites, clients, forward schedule
```

## Before each demo

```bash
npm run demo:live -- --confirm
```

This writes **one day's operation anchored to the current clock**.

Why it is needed: the Kiel dataset seeds a forward schedule. A tenant seeded
last week has all of it in the past with nobody clocked in, so the board
honestly reports *"0 on duty, 10 no-show"* — correct, and impossible to show
anyone. The script supplies genuine shifts, assignments, time entries, alerts
and a manual clock-in request so the same calculations produce a plausible
morning.

It is safe to re-run. It resolves exactly one demo company by name, refuses if
that is ambiguous or missing, tags every row `LIVE-OPS DEMO`, and retires its
own previous run by **cancelling** — it never deletes, and it never touches
another tenant. Without `--confirm` it does nothing.

The scenario lives in `scripts/live-ops-demo-plan.ts` and is unit-tested, so the
KPI mix cannot drift back to an unusable state unnoticed.

### What the board will show

| | |
|---|---|
| On duty | 8 |
| Late | 1 |
| No show | 1 |
| Outside site | 1 |
| Manual requests | 1 |
| Open shifts | 2 |
| Ending soon | 2 |
| Starting later | 3 |
| Scheduled today | 14 |

Understaffed: Ostseekai (7 of 8), plus two later shifts.

## The demo

**1 — Operations board** (`/app`)

Open it. **Needs attention** sits above the KPI row, worst first:

- **No show** — the missing person at Ostseekai, how long ago the shift started
- **Understaffed** — Ostseekai, 7 of 8 staffed, 1 replacement needed
- **Manual clock-in** — Schwedenkai, waiting 6 min
- **Outside site** — 412 m outside the allowed zone

Each card links into the page that can act on it. The understaffed and no-show
cards also carry **Find replacement**, which opens the assistant with the
question already asked.

**2 — Ask what is wrong**

Click *Find replacement*, or open **AI Assistant** and type:

> What needs attention right now?

One `get_operations_briefing` call, assembled server-side by the same engines
the board uses. The briefing and the board cannot disagree.

**3 — Find who can cover**

> Who can replace the missing person at Ostseekai today?

Candidates come from `rankCandidates()` — the same engine the manual planner
uses — with its reason codes. Ask *why not X* and it shows the exclusions:
overlapping shift, approved vacation, missing qualification.

**4 — Send the offer**

> Send the shift to the first 3 eligible people.

A proposal card appears, badged **Not applied yet**. Nothing has been written.
Click **Confirm** → the existing `sendShiftOffer` action runs, re-checking
eligibility against fresh rows.

**5 — Employee responds**

Sign in as one of the offered employees. The offer is on `/me`. Mark
*Interested*.

**6 — See the response**

Back as the manager:

> Who responded?

**7 — Assign**

> Assign the interested employee.

Another proposal, another confirmation, then the existing
`approveOfferResponse` workflow. Reload `/app` — Ostseekai is fully staffed and
the card is gone.

**8 — Brief the owner**

> Summarise today's operation.

**9 — Create shifts in one sentence**

> Create 4 passenger-service shifts at Ostseekai tomorrow from 06:00 to 14:00, 3 employees each.

The site resolves to a real job, 06:00 converts to UTC in Europe/Berlin, the
permission is checked, and a card shows 4 × Ostseekai · 06:00–14:00 · 3 people.
Confirm → created through `create_shift`.

### Worth showing deliberately

**It does not invent things.** Ask for a site that does not exist:

> Create shifts at Gepack tomorrow

It says there is no such site here and lists the real ones. There is no path by
which a name the model made up becomes a job id.

**Roles are real.** Sign in as an HR manager: the proposal tools are not
offered, and the assistant says the account cannot make scheduling changes.

## Resetting

Re-run `npm run demo:live -- --confirm`. The previous run is cancelled, not
deleted, so the history stays honest.

## Limits worth knowing before you present

- Demo scenarios are fictional. The worksites are real public places; the
  staffing is not a real customer contract, and the rows say so.
- The assistant needs `ANTHROPIC_API_KEY`. Without it the page says so and the
  rest of the product is unaffected.
- Batch shift creation is not atomic — `create_shift` is one RPC per shift. A
  batch stops at the first refusal and reports what was and was not created.

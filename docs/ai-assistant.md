# Clockwise AI Operations Assistant

A natural-language layer over Clockwise. It answers questions from tenant data
and drafts scheduling work for a human to confirm.

The one sentence to remember:

> **Claude interprets language and explains results. Clockwise decides
> everything else.**

---

## Where the boundary is

```
manager types a sentence
        │
        ▼
askAssistant()  ── resolveAiContext()  ← identity from the SESSION, always
        │
        ▼
   run.ts loop ──► Anthropic Messages API
        │  ▲                │
        │  └── tool result ─┘
        ▼
   tool registry          closed set; no SQL, no table names, no tenant argument
        │
   ┌────┴────┐
   ▼         ▼
read tools   propose tools
   │             │
   │             ▼
   │        signed proposal ──► rendered as a card ──► manager clicks Confirm
   │                                                          │
   │                                                          ▼
   │                                            confirmProposal()
   │                                                          │
   │                                            executeConfirmedProposal()
   │                                              · requirePermission
   │                                              · verify signature + binding
   │                                              · existing Server Action
   ▼                                                          ▼
caller's Supabase client (RLS)                    createShift / sendShiftOffer /
                                                  approveOfferResponse /
                                                  updateShift  →  RPC  →  RLS
```

**Claude controls:** which tool to call, what to say, how to phrase a reason.

**Clockwise controls:** who you are, what you may see, who is eligible, whether
a write is allowed, and what actually happens.

---

## Authorization

Identity is never an input.

- `resolveAiContext()` calls `requireContext()` — the same chain every page and
  Server Action uses. Company, user and role come from the session.
- **No tool schema contains `company_id`, `user_id`, `profile_id`, `role` or
  `employee_id`.** There is nothing for a prompt injection to overwrite. Zod
  strips unknown keys, so injected ones never reach a handler.
- Every tool query runs through the caller's own Supabase client, so RLS applies
  before the code sees a row. `.eq("company_id", ctx.companyId)` on top makes
  the boundary visible and degrades a future policy mistake to "no rows".
- Tools declare a `permission`, checked against the real role. A role that lacks
  it is not even offered the tool, and dispatch refuses if the model names it.

| Role | Read company data | Draft scheduling work | Confirm a write |
|---|---|---|---|
| SUPER_ADMIN / COMPANY_ADMIN | yes | yes | yes |
| DISPATCHER | yes | yes | yes |
| HR_MANAGER | yes | no | no |
| EMPLOYEE | own data only | no | no |

`get_my_next_shift` and `get_my_time_summary` take no arguments — the employee
is resolved from the session, so they cannot report on anyone else.

---

## Tools

**Read** — `get_today_operations`, `list_shifts`, `list_understaffed_shifts`,
`get_shift_details`, `find_replacement_candidates`, `list_employees`,
`get_absences`, `get_company_locations`, `list_offer_responses`,
`get_my_next_shift`, `get_my_time_summary`.

**Propose** — `propose_create_shifts`, `propose_replacement_offer`,
`propose_assignment`, `propose_shift_update`. None of these write.

**Execute** — not tools. The model cannot reach them. Execution happens only
through `confirmProposal()`, from a human click.

### Eligibility

`find_replacement_candidates` calls `rankCandidates()` from
`src/lib/eligibility.ts` — the same engine the manual shift planner uses — and
returns its verdicts and reason codes verbatim. The model may phrase them. It
may not produce them, re-order them, or add criteria.

`propose_replacement_offer` re-runs the engine and silently drops anyone who is
no longer eligible, because the ids may be minutes old.

No performance, reliability or personality scoring exists anywhere in this
feature, and a test asserts that none appears.

---

## The confirmation flow

1. A propose tool resolves names to real ids, validates, and returns a
   **signed envelope** plus a readable summary. Nothing is written.
2. The UI renders the summary with **Confirm** and **Discard**, marked
   "Not applied yet".
3. Confirm sends the token back. `executeConfirmedProposal()`:
   - `requirePermission("scheduling.manage")` — from the session;
   - verifies the HMAC and that the envelope was issued **to this user, for this
     company, and has not expired** (30 minutes);
   - calls the existing Server Action, which re-authorizes, re-validates and
     re-runs eligibility against fresh rows, and whose RPC re-checks again under
     a row lock.

The signature is defence in depth. **Step 3's re-validation is the security
boundary** — a confirmed proposal is a request to run existing business logic,
never a licence to skip it. If the world changed in between, the underlying
action refuses exactly as it would for a manager clicking the button.

The signing key is derived from `SUPABASE_SERVICE_ROLE_KEY` with a
domain-separation label, so **no additional secret is required** and no table
was added.

### Batch creation is not atomic

`create_shift` is one RPC per shift and there is no multi-shift RPC to reuse.
Rather than invent a transaction boundary the tested code does not have, a batch
stops at the first refusal and reports exactly what was and was not created.
Shifts are additive and individually visible in the planner, so a partial batch
is inspectable rather than corrupting.

---

## Setup

```bash
ANTHROPIC_API_KEY=sk-ant-...        # required; never NEXT_PUBLIC_
ANTHROPIC_MODEL=claude-sonnet-4-5   # optional override
```

Without a key the page renders a "not configured" notice; nothing else changes.

There is **no SDK dependency**. The client is a thin `fetch` wrapper over one
documented endpoint — zero new packages, and an injectable `fetchImpl` that
makes every failure mode testable without a network.

---

## Cost control

- One classify/answer loop, capped at **6 turns**.
- **1,500** output tokens per call.
- Tool results capped at **12,000 characters**, and truncation is announced so
  the model says the list was cut rather than reporting a short count as fact.
- Every read tool is bounded — no unbounded `select`.
- The replayed transcript is capped at 40 messages and trimmed to the last 24.
- The system prompt is a stable prefix, so prompt caching can be added later
  without restructuring.

---

## Auditability

Reuses the existing `audit_logs` table via `writeAudit()` — **no migration**.

Recorded: `ai.<kind>.proposed`, `ai.<kind>.confirmed`, and the outcome
(`ai.<kind>.executed` / `.refused` / `.partial`), each with the actor, company,
timestamp and affected ids.

Not recorded: conversations, prompts, model reasoning, or secrets. Questions are
not audited — they change nothing, and logging what a manager asked about their
staff is surveillance with no purpose.

---

## Tests

| File | Covers |
|---|---|
| `tests/unit/ai-client.test.ts` | malformed response, 401/429/500, timeout, network failure, key in header not body, model default |
| `tests/unit/ai-tools.test.ts` | unknown tool, Zod rejection, **model-supplied identity ignored**, permission gating, no SQL surface, no identity argument in any schema |
| `tests/unit/ai-proposals.test.ts` | tamper, wrong user, **wrong tenant**, expiry, malformed, batch cap |
| `tests/unit/ai-run.test.ts` | tool loop, **follow-up context**, token never sent upstream, turn ceiling, truncation, key never in a client component |
| `tests/unit/ai-boundary.test.ts` | verify-before-write ordering, delegation to existing actions, single eligibility source, no scoring vocabulary, audit shape, bounded queries |
| `tests/unit/ai-dates.test.ts` | Europe/Berlin conversion incl. both DST transitions; timezone-independent |
| `tests/db/ai-tenant-isolation.test.ts` | **real RLS**: cross-tenant reads return nothing; employee sees only own data; `create_shift` refuses an employee and a foreign job |

---

## Extending it

Add a read tool: write the handler in `tools/read.ts` with `defineTool`, give it
a Zod schema and a permission, add it to `READ_TOOLS`. It is offered
automatically.

Add an action: add a payload variant in `proposals.ts`, a propose tool, and a
branch in `execute.ts` that calls an **existing** Server Action. If no such
action exists, build the ordinary feature first — the assistant is not the place
to introduce untested business logic.

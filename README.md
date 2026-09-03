# Clockwise

Workforce management for German staffing, security, cleaning and facility SMBs.
Shift planning, time tracking and team management for companies whose staff work
across many client sites.

**Live:** https://clockwise-production-f612.up.railway.app
German by default, English toggle.

`Next.js 15` · `TypeScript` · `Supabase (Postgres, Auth, Realtime, Storage)` · `Tailwind v4` · `Docker` · `Railway` · `Vitest`

---

## The hard problem: one database, many companies

Clockwise is multi-tenant. Every company's shifts, employees and time records
live in the same Postgres tables. A single missed `WHERE company_id = ...`
leaks one customer's staff roster to another. Getting that wrong once ends the
product.

So authorization is not one check — it is four layers, and the database has the
last word.

### Layer 1 — Session

The user is authenticated via Supabase Auth. JWT claims are treated as a
**convenience only**, never as authority: a claim tells the UI what to render,
it never decides what the server does.

### Layer 2 — Membership

Every sensitive Server Action re-reads the `company_memberships` table and
requires an **active** row linking this user to this company. A revoked
membership takes effect on the next request, not on the next token refresh.

### Layer 3 — Role and resource

The membership's role is checked against the required permission
(`src/lib/permissions.ts`), then the target resource is checked for tenant and
ownership match. A manager in company A cannot act on a shift in company B even
with a valid session and a valid role.

### Layer 4 — Row-Level Security

Postgres RLS policies (`supabase/migrations/0002_rls.sql`) are the final
boundary. If every layer above were bypassed by a bug, the database still
returns nothing. Application code is not trusted to be correct.

### And it is tested

Tenant isolation is not a claim in a README — it is a Vitest suite. Each run
**rebuilds a scratch Postgres database from the migrations** and then asserts
that a user in one tenant cannot read, update or delete another tenant's rows.
RLS policy changes cannot silently regress.

```bash
npm run typecheck
npm run test
```

---

## Secrets

- `SUPABASE_SERVICE_ROLE_KEY` is runtime-only and never carries a
  `NEXT_PUBLIC_` prefix.
- It is guarded by `server-only` in `src/lib/supabase/admin.ts`, so importing it
  from a client component is a **build error**, not a production incident.
- Only `.env.example` is committed, and it holds empty keys.

---

## Localisation

German is the default locale, English is a cookie-based toggle, via `next-intl`.
The target customers are German SMBs, so German is not an afterthought
translation layer — it is the base language of the product.

---

## Running it

```bash
npm install
cp .env.example .env.local     # fill in your Supabase values
npm run dev
```

**Supabase setup (once)** — create a project in the EU/Frankfurt region, then run
the migrations in order:

```
supabase/migrations/0001_schema.sql
supabase/migrations/0002_rls.sql
supabase/migrations/0003_auth_profile_trigger.sql
```

Seed demo data with `npm run seed` (needs `SUPABASE_SERVICE_ROLE_KEY`).

**Deployment** — Railway builds from the `Dockerfile` via `railway.json`.
Health check at `/api/health`. The two `NEXT_PUBLIC_` variables are also needed
as build args; Railway passes service variables into Docker builds
automatically.

---

## Layout

```
src/app/(auth)      login and registration
src/app/(portal)    employee-facing views
src/app/(manager)   manager-facing views
src/app/actions     Server Actions — every one re-validates authorization
src/app/api         health check and route handlers
src/lib/permissions role → permission mapping
src/lib/supabase    server, browser and admin (server-only) clients
src/messages        de / en translation catalogues
supabase/migrations schema, RLS policies, auth trigger
tests/db            tenant-isolation tests against a scratch Postgres
```

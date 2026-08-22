# Clockwise

A workforce operations platform for service companies that assign employees
to shifts and client sites — cleaning, facility management, logistics,
hospitality, event and temporary staffing, maintenance, retail and healthcare
support. Industry-neutral by design.

Next.js 15 full-stack · Supabase (Postgres, Auth, Realtime, Storage) ·
Railway hosting. Architecture Pack v2 is the implementation contract.

## Stack

- Next.js 15 (App Router, TypeScript, Turbopack), Tailwind CSS v4, shadcn-style UI components
- Supabase: sole database + auth + realtime + storage (EU region recommended)
- next-intl: German default, English toggle (cookie-based)
- Vitest: RBAC unit tests + RLS tenant-isolation tests against local Postgres

## Local development

```bash
npm install
cp .env.example .env.local     # fill in your Supabase values
npm run dev
```

## Supabase setup (once)

1. Create a project at supabase.com (region: EU / Frankfurt).
2. Run the migrations in order in the SQL editor (or via supabase CLI):
   - `supabase/migrations/0001_schema.sql`
   - `supabase/migrations/0002_rls.sql`
   - `supabase/migrations/0003_auth_profile_trigger.sql`
3. Seed demo data: `npm run seed` (needs `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`).

### Maintenance scripts

Targeted, idempotent, non-destructive — they never reseed or delete:

- `npm run backfill:coords` — set worksite coordinates and geofence radius on existing locations.
- `npm run rename:demo-company` — one-time rename of the demo company row (`companies.name` only).
- `npm run generalize:demo-data -- --dry` — preview the industry-neutral demo-data update.
- `npm run generalize:demo-data` — apply it (departments, positions, shift roles/instructions, job posting, news).
- `npm run add:gepack-demo` — add the GE-PACK Services client, worksite, job, shifts and assignments (insert-if-absent).

## Localization of database values

Static UI text comes from `src/messages/{de,en}.json`. System-controlled values
stored in the database are localized through stable keys in
`src/lib/taxonomy.ts`, kept in three separate namespaces so one kind of value
can never be resolved as another:

| Namespace | Covers | Component |
|---|---|---|
| `terms.*` | departments, shift roles, employee positions | `<Term>` / `localizedTerm()` |
| `sites.*` | the five known demo worksites only | `<SiteName>` / `localizedSite()` |
| `roles.*` | membership role enums | `<RoleLabel>` |

Anything outside these maps renders exactly as stored — company, client, site
and person names, addresses, instructions and free text are never translated,
and tenant-created locations keep their own wording. Database values and enums
are never rewritten; filters and business logic always use raw values or ids,
never translated labels.

## Tests

Isolation tests need a local Postgres with a `clockwise_owner` superuser
(password `clockwise`). They rebuild a scratch database on every run:

```bash
npm run typecheck
npm run test
```

## Deployment (Railway)

- Connect the GitHub repo; `railway.json` selects the Dockerfile build.
- Set variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  (also as build args — Railway passes service variables to Docker builds
  automatically) and `SUPABASE_SERVICE_ROLE_KEY` (runtime only, server-side).
- Healthcheck: `/api/health`.

Secrets live in environment variables only. The service-role key is never
exposed with a `NEXT_PUBLIC_` prefix and never reaches client code
(`server-only` guard in `src/lib/supabase/admin.ts`).

## Authorization model

JWT claims are convenience only. Sensitive Server Actions validate:
authenticated user → active `company_memberships` row → role/permission
(`src/lib/permissions.ts`) → resource tenant/ownership → RLS as the final
database isolation layer (`supabase/migrations/0002_rls.sql`).

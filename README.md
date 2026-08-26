# Clockwise

Clockwise is a workforce-operations platform for service companies that schedule employees across shifts and client sites.

It is designed for businesses such as facility services, cleaning, logistics, cruise and port services, hospitality, events, temporary staffing, maintenance, retail support and similar field-service operations.

> **Current status:** functional MVP / demo build. The core workforce workflows are implemented and tested. Some adjacent modules are intentionally still planned and are not production-complete yet.

## What works today

### Manager / dispatcher

- Operational dashboard with staffing and attendance signals
- Create, edit and cancel shifts
- Multi-seat staffing with required roles and qualifications
- Candidate eligibility and ranking
- Send shift offers to eligible employees
- Employee offer responses and manager approval
- Atomic assignment creation with vacancy protection
- Employee cancellation-request review: approve or reject
- Manager-initiated assignment removal with audit history
- Automatic vacancy reopening and replacement staffing
- Geofenced attendance visibility
- Manual clock-in request review when an employee cannot clock in normally
- Late / no-show / attendance alerting
- Vacation-request approval / rejection
- Sick-leave reporting, confirmation and closure
- Employee records, qualifications, availability and employment status
- Employee-account invitation, activation, suspension and reactivation

### Employee portal

- View assigned and upcoming shifts
- View and respond to shift offers
- Request cancellation of an assigned shift
- Clock in and clock out with location verification
- Request manual clock-in approval when needed
- View recorded working time
- Request vacation and report sick leave
- Maintain supported self-service profile information
- Manage availability and emergency-contact information
- Receive assignment / offer / account outcome information

### Platform

- Multi-tenant company isolation
- Role-based access control
- German-first UI with English toggle
- Responsive manager and employee shells
- Realtime refresh on operational surfaces where implemented
- Railway deployment with `/api/health` healthcheck

## Planned / not yet complete

The repository already contains placeholders or schema groundwork for several broader workforce modules, but they should **not** be presented as finished functionality yet:

- Calendar
- Documents / certificates / payroll documents
- Messaging
- Recruitment / applications
- News
- Jobs administration UI
- Settings UI
- Broader payroll / timesheet approval workflows

Clockwise currently focuses on the operational path from **shift planning → staffing → assignment → attendance → cancellation / absence → replacement**.

## Tech stack

- **Next.js 15** — App Router, TypeScript, Turbopack
- **React 19**
- **Tailwind CSS v4** with shadcn-style UI components
- **Supabase** — PostgreSQL, Auth, Realtime and Storage
- **next-intl** — German / English localization
- **Zod** — validation
- **Vitest + PostgreSQL integration tests**
- **Railway** — application hosting

## Architecture and authorization

Clockwise treats the database as the final authority for tenant isolation and sensitive state transitions.

Sensitive actions follow this chain:

```text
authenticated user
  → active company membership
  → application permission check
  → tenant / ownership validation
  → transactional RPC / Server Action
  → PostgreSQL RLS and database invariants
```

Important design rules:

- JWT claims are not treated as the authoritative role source.
- Active `company_memberships` rows drive access.
- RLS is the final tenant-isolation layer.
- Scheduling mutations use explicit permissions such as `scheduling.manage`.
- Critical assignment / offer / cancellation paths use row locks and transactional RPCs.
- A pending cancellation request still occupies the staffing seat until a manager approves it.
- Worked-time and operational-history deletion paths are guarded.
- Employee self-service mutations are restricted at both policy and trigger level.
- Suspended memberships no longer resolve an operational employee identity.
- The Supabase service-role key is server-only and never exposed with a `NEXT_PUBLIC_` prefix.

## Database migrations

The current schema is built through **17 ordered migrations**:

| Migration | Purpose |
|---|---|
| `0001_schema.sql` | Core multi-tenant workforce schema |
| `0002_rls.sql` | Initial RLS and authorization helpers |
| `0003_auth_profile_trigger.sql` | Auth user → profile creation |
| `0004_geofencing.sql` | Locations, geofenced attendance and manual clock-in groundwork |
| `0005_operations.sql` | Operations / attendance extensions |
| `0006_shift_offers.sql` | Shift-offer workflow |
| `0007_shift_offer_approval.sql` | Transactional offer approval |
| `0008_offer_shift_visibility.sql` | Employee visibility for offered shifts |
| `0009_cancellation_decision.sql` | Employee cancellation request + manager decision |
| `0010_manager_assignment_removal.sql` | Manager-initiated assignment removal |
| `0011_shift_lifecycle.sql` | Shift create / edit / cancel lifecycle |
| `0012_scheduling_authorization.sql` | Scheduling authorization hardening + history guards |
| `0013_employee_mutation_integrity.sql` | Employee time-entry / assignment mutation integrity |
| `0014_vacation_cancelled_status.sql` | Vacation withdrawal state |
| `0015_absence.sql` | Vacation and sick-leave workflows |
| `0016_employee_management.sql` | Employee management and tenant-integrity hardening |
| `0017_account_lifecycle.sql` | Invitation and access lifecycle |

For a **fresh database**, apply every migration in filename order from `0001` through `0017`.

> **Important:** do not blindly re-run migrations against an existing project. Some migrations create named policies or other objects that are intended to be applied once in sequence. Check the deployed database state before reapplying anything.

## Local development

```bash
git clone https://github.com/RakeshReddy26-bit/clockwise.git
cd clockwise
npm ci
cp .env.example .env.local
npm run dev
```

Required environment variables:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SITE_URL=
```

`NEXT_PUBLIC_SITE_URL` is required for the employee invitation flow in deployed environments.

## Supabase setup

1. Create a Supabase project in an EU region (Frankfurt is the intended deployment region).
2. Apply `supabase/migrations/0001_schema.sql` through `0017_account_lifecycle.sql` in order.
3. Add the required environment variables to `.env.local` and Railway.
4. Seed demo data when needed:

```bash
npm run seed
```

The seed requires `SUPABASE_SERVICE_ROLE_KEY` and should be used deliberately; do not treat it as a migration.

## Employee invitation setup

The invitation flow uses a server-side `/auth/confirm` route with Supabase `verifyOtp()` and a token hash.

For deployed invitations:

1. Set `NEXT_PUBLIC_SITE_URL` to the deployed application origin.
2. Allow the `/auth/confirm` redirect in Supabase Auth settings.
3. Configure the Supabase **Invite user** email template to send `{{ .TokenHash }}` to the application confirmation route rather than relying on a URL fragment that the server cannot read.

The route expects the equivalent of:

```text
/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/welcome
```

Use a production SMTP provider before treating invitation email delivery as production-ready.

## Demo / maintenance scripts

Targeted scripts currently available:

```bash
npm run backfill:coords
npm run rename:demo-company
npm run generalize:demo-data -- --dry
npm run generalize:demo-data
npm run add:gepack-demo
npm run add:kiel-demo
```

Purpose:

- `backfill:coords` — populate coordinates and geofence radii for existing worksites
- `rename:demo-company` — rename the demo company row
- `generalize:demo-data -- --dry` — preview demo-data generalization
- `generalize:demo-data` — apply demo-data generalization
- `add:gepack-demo` — add the GE-PACK demo client / site / shifts
- `add:kiel-demo` — add Kiel / Rendsburg-Eckernförde demo geography and shifts

These maintenance scripts are intended to be targeted and non-destructive; review the script before running it against real tenant data.

## Localization

Static UI copy lives in:

```text
src/messages/de.json
src/messages/en.json
```

System-controlled database values are localized through stable taxonomy keys in `src/lib/taxonomy.ts`.

| Namespace | Covers |
|---|---|
| `terms.*` | departments, shift roles, employee positions |
| `sites.*` | known demo worksites |
| `roles.*` | membership-role enums |

Tenant-created names, addresses, instructions and free text remain exactly as stored and are never rewritten by localization.

## Testing

Clockwise has **800+ automated unit and database-integration tests** covering authorization, tenant isolation, scheduling, offers, cancellation, removal, geofencing, attendance, absences, employees and account lifecycle.

Run:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

Database integration tests expect a local PostgreSQL instance with the test owner configured by `tests/db/helpers.ts`. The test harness rebuilds isolated scratch databases from the migration files.

## Deployment with Railway

1. Connect the GitHub repository to Railway.
2. Deploy the `main` branch.
3. Configure:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_SITE_URL
SUPABASE_SERVICE_ROLE_KEY
```

4. Keep `SUPABASE_SERVICE_ROLE_KEY` runtime-only and server-side.
5. Use `/api/health` as the Railway healthcheck.

## Project direction

Clockwise is currently a focused workforce-operations MVP rather than a full payroll / ERP replacement.

The strongest implemented workflow is:

```text
create shift
→ identify eligible employees
→ send offer
→ employee responds
→ manager approves
→ assignment created
→ employee clocks in / out
→ cancellation or absence handled
→ vacancy reopens
→ replacement employee staffed
```

That operational loop is the part of the product currently intended for real-world demos and pilot discussions.

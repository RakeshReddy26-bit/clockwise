-- Clockwise · Migration 0006 · Open shift offers (Phase B1)
--
-- Schema only: tables, indexes and RLS for the smart-replacement workflow.
-- Eligibility is computed in application code (src/lib/eligibility.ts) and
-- deliberately never stored — a stored verdict goes stale the moment an
-- assignment, absence or qualification changes.
--
-- B1 adds no writes of its own: offers are created in B2, answered in B3 and
-- approved in B4 through an atomic SECURITY INVOKER function.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.shift_offer_status as enum ('open','filled','cancelled','expired');

-- 'withdrawn' lets an employee take back an expression of interest before a
-- manager decides; it is not a rejection by the company.
create type public.offer_response as enum ('pending','interested','declined','withdrawn');

alter type public.notification_type add value if not exists 'open_shift_available';
alter type public.notification_type add value if not exists 'shift_offer_response';
alter type public.notification_type add value if not exists 'replacement_approved';
alter type public.notification_type add value if not exists 'replacement_declined';

-- ---------------------------------------------------------------------------
-- shifts.required_qualification
-- Nullable: existing shifts keep working unchanged. When set, it is matched
-- against employee_qualifications.name (raw canonical value, never a label).
-- ---------------------------------------------------------------------------
alter table public.shifts add column required_qualification text;

-- ---------------------------------------------------------------------------
-- shift_offers
-- A manager's invitation to fill a specific shift. `mode` is stored so the
-- first-accept variant can be added later without a migration; V1 only ever
-- writes 'manager_approval'.
-- ---------------------------------------------------------------------------
create table public.shift_offers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  mode text not null default 'manager_approval'
    check (mode in ('manager_approval','first_accept')),
  message text,
  expires_at timestamptz,
  status public.shift_offer_status not null default 'open',
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one live offer per shift, enforced by the database rather than by
-- application checks that can race.
create unique index shift_offers_one_open_per_shift
  on public.shift_offers (shift_id) where status = 'open';

create index on public.shift_offers (company_id, status, created_at desc);

create trigger set_updated_at before update on public.shift_offers
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- shift_offer_responses
-- One row per offered employee, created by the manager when the offer is sent.
-- Employees never insert; they only move their own row through the response
-- states. Decision columns are written by the approval flow (B4).
-- ---------------------------------------------------------------------------
create table public.shift_offer_responses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  offer_id uuid not null references public.shift_offers(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  response public.offer_response not null default 'pending',
  responded_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  resulting_assignment_id uuid references public.shift_assignments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (offer_id, employee_id)
);

create index on public.shift_offer_responses (company_id, response);
create index on public.shift_offer_responses (employee_id, created_at desc);

create trigger set_updated_at before update on public.shift_offer_responses
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Grants + RLS
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  public.shift_offers, public.shift_offer_responses
to authenticated, service_role;

alter table public.shift_offers enable row level security;
alter table public.shift_offer_responses enable row level security;

-- Staff manage offers inside their tenant.
create policy shift_offers_staff on public.shift_offers
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));

-- An employee sees an offer only while it is open and only if they were
-- actually offered it.
create policy shift_offers_offered_select on public.shift_offers
  for select to authenticated
  using (
    status = 'open'
    and exists (
      select 1 from public.shift_offer_responses r
      where r.offer_id = public.shift_offers.id
        and r.employee_id = app.current_employee_id(public.shift_offers.company_id)
    )
  );

-- Staff manage responses inside their tenant.
create policy shift_offer_responses_staff on public.shift_offer_responses
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));

create policy shift_offer_responses_self_select on public.shift_offer_responses
  for select to authenticated
  using (employee_id = app.current_employee_id(company_id));

-- Employees may only move their own row between response states, and only
-- while nothing has been decided. RLS is the last line here, not the only one:
-- the Server Action accepts an intent ('interested' | 'declined' |
-- 'withdrawn') and never a row payload, so identity, offer and decision
-- columns are resolved server-side and are not client-controlled.
create policy shift_offer_responses_self_respond on public.shift_offer_responses
  for update to authenticated
  using (
    employee_id = app.current_employee_id(company_id)
    and decided_at is null
    and response in ('pending','interested','declined','withdrawn')
  )
  with check (
    employee_id = app.current_employee_id(company_id)
    and response in ('interested','declined','withdrawn')
    and decided_by is null
    and decided_at is null
    and resulting_assignment_id is null
  );

-- ---------------------------------------------------------------------------
-- Realtime: the manager shift screen reacts to responses as they arrive.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.shift_offers';
    execute 'alter publication supabase_realtime add table public.shift_offer_responses';
  end if;
end $$;

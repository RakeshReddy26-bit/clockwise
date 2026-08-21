-- Clockwise · Migration 0004 · Geofenced clock-in & attendance verification
-- Adds per-location geofence config, verified coordinates on time entries,
-- a location event audit table, manual clock-in requests, and RLS.
-- Point-in-time capture at clock events only — no continuous tracking.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.location_verification_status as enum
  ('verified','outside_geofence','unavailable','manager_override','not_required');

create type public.location_event_type as enum
  ('clock_in_verified','clock_in_outside_geofence','clock_in_location_unavailable',
   'manual_clock_in_requested','manual_clock_in_approved','manual_clock_in_rejected',
   'geofence_exit_detected','clock_out_outside_geofence');

create type public.manual_clockin_reason as enum
  ('gps_inaccurate','entrance_moved','alternate_location','manager_instructed','other');

-- New notification types (added, not used, in this migration — safe in a txn)
alter type public.notification_type add value if not exists 'outside_geofence_attempt';
alter type public.notification_type add value if not exists 'manual_clockin_requested';
alter type public.notification_type add value if not exists 'manual_clockin_approved';
alter type public.notification_type add value if not exists 'manual_clockin_rejected';
alter type public.notification_type add value if not exists 'geofence_exit';

-- ---------------------------------------------------------------------------
-- locations · per-location geofence config (no global hard-coded radius)
-- ---------------------------------------------------------------------------
alter table public.locations
  add column geofence_radius_m integer not null default 100
    check (geofence_radius_m between 10 and 5000),
  add column geofence_enabled boolean not null default true;

-- ---------------------------------------------------------------------------
-- time_entries · verified clock-in/out location snapshot
-- ---------------------------------------------------------------------------
alter table public.time_entries
  add column clock_in_lat double precision,
  add column clock_in_lng double precision,
  add column clock_in_accuracy_m numeric(8,1),
  add column clock_in_distance_m numeric(10,1),
  add column clock_in_location_status public.location_verification_status
    not null default 'not_required',
  add column clock_out_lat double precision,
  add column clock_out_lng double precision,
  add column clock_out_accuracy_m numeric(8,1),
  add column clock_out_distance_m numeric(10,1),
  add column clock_out_location_status public.location_verification_status;

-- ---------------------------------------------------------------------------
-- location_events · append-only audit of location verification events
-- ---------------------------------------------------------------------------
create table public.location_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  shift_assignment_id uuid references public.shift_assignments(id) on delete set null,
  time_entry_id uuid references public.time_entries(id) on delete set null,
  event_type public.location_event_type not null,
  latitude double precision,
  longitude double precision,
  accuracy_m numeric(8,1),
  distance_m numeric(10,1),
  allowed_radius_m integer,
  created_at timestamptz not null default now()
);

create index on public.location_events (company_id, created_at desc);
create index on public.location_events (shift_assignment_id, event_type, created_at desc);
create index on public.location_events (employee_id, created_at desc);

-- ---------------------------------------------------------------------------
-- manual_clockin_requests · override flow (GPS problems are real)
-- ---------------------------------------------------------------------------
create table public.manual_clockin_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  shift_assignment_id uuid not null references public.shift_assignments(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  reason public.manual_clockin_reason not null,
  reason_note text,
  latitude double precision,
  longitude double precision,
  accuracy_m numeric(8,1),
  distance_m numeric(10,1),
  status public.cancellation_status not null default 'pending', -- pending/approved/rejected
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  time_entry_id uuid references public.time_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on public.manual_clockin_requests (company_id, status);
create index on public.manual_clockin_requests (shift_assignment_id, status);

create trigger set_updated_at before update on public.manual_clockin_requests
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Grants (mirror Supabase defaults) + RLS
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  public.location_events, public.manual_clockin_requests
to authenticated, service_role;

alter table public.location_events enable row level security;
alter table public.manual_clockin_requests enable row level security;

-- location_events: append-only. Staff read company events; employees read
-- their own. Insert: employee for themselves, staff for company. No update.
create policy location_events_select on public.location_events
  for select to authenticated
  using (app.is_staff(company_id) or employee_id = app.current_employee_id(company_id));
create policy location_events_insert_staff on public.location_events
  for insert to authenticated with check (app.is_staff(company_id));
create policy location_events_insert_self on public.location_events
  for insert to authenticated
  with check (employee_id = app.current_employee_id(company_id));

-- manual_clockin_requests: staff decide; employee files & reads own.
create policy manual_clockin_staff on public.manual_clockin_requests
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy manual_clockin_self_select on public.manual_clockin_requests
  for select to authenticated
  using (employee_id = app.current_employee_id(company_id));
create policy manual_clockin_self_insert on public.manual_clockin_requests
  for insert to authenticated
  with check (
    status = 'pending' and decided_by is null and time_entry_id is null
    and employee_id = app.current_employee_id(company_id)
    and exists (
      select 1 from public.shift_assignments sa
      where sa.id = shift_assignment_id
        and sa.company_id = public.manual_clockin_requests.company_id
        and sa.employee_id = public.manual_clockin_requests.employee_id
    )
  );

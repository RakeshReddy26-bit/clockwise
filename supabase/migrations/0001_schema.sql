-- Clockwise · Migration 0001 · Schema
-- Architecture Pack v2. All tenant tables carry company_id.
-- Enums first, then tables, then indexes and triggers.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.membership_role as enum
  ('SUPER_ADMIN','COMPANY_ADMIN','HR_MANAGER','DISPATCHER','EMPLOYEE','APPLICANT');
create type public.membership_status as enum ('active','invited','suspended');
create type public.employment_status as enum ('active','probation','on_leave','terminated');
create type public.contract_type as enum ('full_time','part_time','mini_job','temporary');
create type public.job_status as enum
  ('open','partially_staffed','fully_staffed','in_progress','completed');
create type public.shift_status as enum ('open','staffed','in_progress','completed','cancelled');
create type public.assignment_status as enum
  ('assigned','accepted','cancellation_requested','cancelled','completed');
create type public.cancellation_status as enum ('pending','approved','rejected');
create type public.time_entry_source as enum ('app','kiosk','manual');
create type public.time_entry_status as enum
  ('running','on_break','completed','missing_clockout','submitted','approved');
create type public.vacation_status as enum ('pending','approved','rejected');
create type public.sick_leave_status as enum ('reported','confirmed','closed');
create type public.calendar_event_type as enum ('company_event','training','safety_instruction');
create type public.application_stage as enum
  ('applied','reviewing','interview','accepted','rejected');
create type public.document_category as enum
  ('contract','payslip','payroll','reference','certificate','work_permit','training','sick_note','other');
create type public.conversation_topic as enum
  ('payroll','schedule','vacation','sick_leave','documents','tech_support','other','direct');
create type public.notification_type as enum
  ('shift_assigned','shift_changed','cancellation_requested','cancellation_approved',
   'cancellation_rejected','new_message','vacation_requested','vacation_approved',
   'vacation_rejected','document_available','payslip_available','announcement',
   'safety_required','sick_reported');
create type public.onboarding_item_type as enum
  ('personal_info','contract_received','contract_signed','bank_info',
   'emergency_contact','safety_instructions','documents_uploaded','policies_acknowledged');
create type public.availability_type as enum ('available','unavailable','preferred');
create type public.qualification_status as enum ('valid','expiring','expired');

-- ---------------------------------------------------------------------------
-- Core & people
-- ---------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text,
  contact_email text,
  contact_phone text,
  address text,
  settings jsonb not null default '{}'::jsonb, -- working-time rules, vacation defaults, branding
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  address text,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);

-- Identity only. No company data here.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  locale text not null default 'de',
  notification_prefs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Role and status live on the membership, not the profile.
create table public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  role public.membership_role not null,
  status public.membership_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, company_id)
);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  employee_no text not null,
  full_name text not null,
  photo_url text,
  email text,
  phone text,
  position text,
  department_id uuid references public.departments(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  employment_status public.employment_status not null default 'active',
  contract_type public.contract_type not null default 'full_time',
  start_date date,
  weekly_hours numeric(5,2),
  vacation_days_total numeric(5,1) not null default 0,
  vacation_days_used numeric(5,1) not null default 0,
  hourly_rate numeric(8,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, employee_no),
  unique (company_id, profile_id)
);

create table public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  name text not null,
  relationship text,
  phone text not null,
  phone_alt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Schema in Phase 1, UI later.
create table public.employee_availability (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  weekday smallint check (weekday between 0 and 6),
  valid_from date,
  valid_to date,
  start_time time,
  end_time time,
  type public.availability_type not null default 'available',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Schema in Phase 1, UI later.
create table public.employee_qualifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  name text not null,
  issued_at date,
  expires_at date,
  status public.qualification_status not null default 'valid',
  document_id uuid, -- fk added after documents table exists
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  diff jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Scheduling & time
-- ---------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_name text not null,
  location_id uuid references public.locations(id) on delete set null,
  description text,
  status public.job_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A shift is the work requirement, never a person.
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  date date not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  required_count integer not null default 1 check (required_count > 0),
  required_role text,
  instructions text,
  contact_person text,
  status public.shift_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);

-- One row per employee on a shift.
create table public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  status public.assignment_status not null default 'assigned',
  assigned_by uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shift_id, employee_id)
);

-- References the assignment, not the shift.
create table public.cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  shift_assignment_id uuid not null references public.shift_assignments(id) on delete cascade,
  reason text not null,
  status public.cancellation_status not null default 'pending',
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  shift_assignment_id uuid references public.shift_assignments(id) on delete set null,
  clock_in timestamptz not null,
  clock_out timestamptz,
  source public.time_entry_source not null default 'app',
  location_note text,
  status public.time_entry_status not null default 'running',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (clock_out is null or clock_out > clock_in)
);

create table public.time_breaks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  time_entry_id uuid not null references public.time_entries(id) on delete cascade,
  break_start timestamptz not null,
  break_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (break_end is null or break_end > break_start)
);

-- ---------------------------------------------------------------------------
-- Absence
-- ---------------------------------------------------------------------------
create table public.vacation_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  days_count numeric(5,1) not null,
  note text,
  status public.vacation_status not null default 'pending',
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table public.sick_leaves (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  start_date date not null,
  expected_end_date date,
  comment text,
  document_id uuid, -- fk added after documents table exists
  status public.sick_leave_status not null default 'reported',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  type public.calendar_event_type not null,
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location_id uuid references public.locations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- ---------------------------------------------------------------------------
-- Recruitment
-- ---------------------------------------------------------------------------
create table public.job_postings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null,
  description text,
  location_id uuid references public.locations(id) on delete set null,
  employment_type public.contract_type,
  published boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_posting_id uuid not null references public.job_postings(id) on delete cascade,
  applicant_profile_id uuid references public.profiles(id) on delete set null,
  applicant_name text not null,
  applicant_email text not null,
  applicant_phone text,
  cv_document_id uuid, -- fk added after documents table exists
  stage public.application_stage not null default 'applied',
  notes text,
  converted_employee_id uuid references public.employees(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Documents, comms, onboarding, safety
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade,
  category public.document_category not null,
  title text not null,
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employee_qualifications
  add constraint employee_qualifications_document_fk
  foreign key (document_id) references public.documents(id) on delete set null;
alter table public.sick_leaves
  add constraint sick_leaves_document_fk
  foreign key (document_id) references public.documents(id) on delete set null;
alter table public.applications
  add constraint applications_cv_document_fk
  foreign key (cv_document_id) references public.documents(id) on delete set null;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  topic public.conversation_topic not null default 'direct',
  subject text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversation_participants (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, profile_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  body text not null,
  attachment_document_id uuid references public.documents(id) on delete set null,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.news_posts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null,
  body text not null,
  category text,
  author_id uuid references public.profiles(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  type public.notification_type not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.onboarding_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  item public.onboarding_item_type not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, item)
);

create table public.safety_instructions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null,
  description text,
  document_id uuid references public.documents(id) on delete set null,
  required_for_department_id uuid references public.departments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.safety_completions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  instruction_id uuid not null references public.safety_instructions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (instruction_id, employee_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index on public.locations (company_id);
create index on public.departments (company_id);
create index on public.company_memberships (company_id);
create index on public.company_memberships (profile_id);
create index on public.employees (company_id);
create index on public.employees (company_id, department_id);
create index on public.emergency_contacts (employee_id);
create index on public.employee_availability (company_id, employee_id);
create index on public.employee_qualifications (company_id, employee_id);
create index on public.employee_qualifications (company_id, expires_at);
create index on public.audit_logs (company_id, created_at desc);
create index on public.jobs (company_id, status);
create index on public.shifts (company_id, date);
create index on public.shifts (job_id);
create index on public.shift_assignments (company_id, employee_id);
create index on public.shift_assignments (shift_id);
create index on public.cancellation_requests (company_id, status);
create index on public.time_entries (company_id, employee_id, clock_in desc);
create index on public.time_entries (company_id, status);
create index on public.time_breaks (time_entry_id);
create index on public.vacation_requests (company_id, status);
create index on public.sick_leaves (company_id, status);
create index on public.calendar_events (company_id, starts_at);
create index on public.job_postings (company_id, published);
create index on public.applications (company_id, stage);
create index on public.documents (company_id, employee_id);
create index on public.conversations (company_id);
create index on public.conversation_participants (profile_id);
create index on public.conversation_participants (conversation_id);
create index on public.messages (conversation_id, sent_at desc);
create index on public.news_posts (company_id, published_at desc);
create index on public.notifications (profile_id, created_at desc)
  where read_at is null;
create index on public.onboarding_items (company_id, employee_id);
create index on public.safety_completions (company_id, instruction_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'updated_at'
  loop
    execute format(
      'create trigger set_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Staffing recalculation
-- Shift: open ↔ staffed from active assignment count (in_progress/completed/
-- cancelled are set explicitly and never overwritten here).
-- Job: open / partially_staffed / fully_staffed from its shifts (same rule).
-- An approved cancellation cancels the assignment → these triggers reopen the
-- shift and surface the vacancy.
-- ---------------------------------------------------------------------------
-- security definer: fires correctly also when the row change comes from an
-- employee (who has no update rights on shifts/jobs themselves).
-- 'cancellation_requested' still occupies the seat — it frees only on approval.
create or replace function public.recalc_shift_staffing()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  sid uuid := coalesce(new.shift_id, old.shift_id);
  active_count integer;
  req integer;
  jid uuid;
  total_req integer;
  total_active integer;
begin
  select required_count, job_id into req, jid from public.shifts where id = sid;
  if not found then return null; end if;

  select count(*) into active_count
  from public.shift_assignments
  where shift_id = sid and status in ('assigned','accepted','cancellation_requested');

  update public.shifts
  set status = case when active_count >= required_count then 'staffed' else 'open' end::public.shift_status
  where id = sid and status in ('open','staffed');

  select coalesce(sum(s.required_count),0),
         coalesce(sum(least(a.cnt, s.required_count)),0)
    into total_req, total_active
  from public.shifts s
  left join lateral (
    select count(*) as cnt from public.shift_assignments sa
    where sa.shift_id = s.id and sa.status in ('assigned','accepted','cancellation_requested')
  ) a on true
  where s.job_id = jid and s.status not in ('cancelled');

  update public.jobs
  set status = case
      when total_req = 0 or total_active = 0 then 'open'
      when total_active >= total_req then 'fully_staffed'
      else 'partially_staffed'
    end::public.job_status
  where id = jid and status in ('open','partially_staffed','fully_staffed');

  return null;
end $$;

create trigger recalc_staffing_after_assignment
after insert or update of status or delete on public.shift_assignments
for each row execute function public.recalc_shift_staffing();

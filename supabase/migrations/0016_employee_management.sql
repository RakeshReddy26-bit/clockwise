-- Clockwise · Migration 0016 · Employee management (Phase F)
--
-- Additive only. 0001–0015 are untouched as files; this migration supersedes
-- two policies by name and adds three triggers, seven constraints and two RPCs.
--
-- The employee tables have carried complete RLS since 0002 and have never had a
-- line of application code behind them: the eligibility engine reads them
-- (candidates.ts:110-141) and nothing writes them. Phase F makes them writable,
-- which turns four dormant defects into live ones. All four were reproduced
-- against HEAD before any of this was written; the measurements are recorded at
-- each section.
--
-- ---------------------------------------------------------------------------
-- WHO OWNS AN EMPLOYEE FIELD
--
-- Three answers, and the code should make which one apply obvious:
--
--   HR (app.is_hr — COMPANY_ADMIN + HR_MANAGER) owns employment: status,
--   contract, hours, pay, position, department, location, employee number.
--   DISPATCHER reads all of it and writes none of it; that is the same
--   HR/scheduling split 0012 drew from the other side.
--
--   THE EMPLOYEE owns exactly one column here — phone — plus their own rows in
--   profiles, emergency_contacts and employee_availability, which 0002 already
--   grants and this migration does not touch.
--
--   NOBODY owns id, company_id, profile_id, created_at or updated_at. profile_id
--   is set by the account-linking flow that does not exist yet (Phase G).
--
-- position and department_id look like description and are not: matchesRequired-
-- Role() (eligibility.ts:110) compares shifts.required_role against exactly
-- those two values, so a self-editable position would let someone qualify
-- themselves for a restricted shift. email is HR's for the same kind of reason —
-- the future invite flow will key on it, and an employee who can rewrite it can
-- redirect their own invitation.
--
-- ---------------------------------------------------------------------------
-- Not in scope: auth users, invitations, profile↔employee linking, membership
-- lifecycle, photo upload, documents and certificates, vacation balances
-- (vacation_days_total/_used stay unreferenced and unexposed), time aggregation,
-- onboarding, safety. Qualification and availability rules are NOT added to
-- approve_shift_offer — see section 8.

-- ---------------------------------------------------------------------------
-- 1 · Command-specific employee policies
--
-- employees_write was `for all using app.is_hr(...)`, so DELETE permission rode
-- along with the right to edit a phone number. Measured against HEAD: a
-- COMPANY_ADMIN deleted an employee who had a completed time entry carrying
-- clock-in coordinates, and the entry, their qualifications and their emergency
-- contact all vanished with them — fifteen tables cascade from employees.
--
-- Split one policy per command so each states its own boundary, the same shape
-- 0012 used for shifts and 0013 for time entries:
--
--   SELECT  is_staff or own row      — unchanged; reading was never the problem
--   INSERT  is_hr
--   UPDATE  is_hr
--   DELETE  no policy at all         — denied for every authenticated role
-- ---------------------------------------------------------------------------
drop policy if exists employees_write on public.employees;

create policy employees_hr_insert on public.employees
  for insert to authenticated
  with check (app.is_hr(company_id));

create policy employees_hr_update on public.employees
  for update to authenticated
  using (app.is_hr(company_id))
  with check (app.is_hr(company_id));

-- No DELETE policy, for anyone. An employment record is history; someone who
-- has left becomes 'terminated'. See the trigger in section 3.

comment on policy employees_hr_update on public.employees is
  'HR owns employment data. DISPATCHER keeps the read it needs to staff shifts '
  'and gains no edit rights — the mirror of the scheduling split in 0012.';

-- ---------------------------------------------------------------------------
-- 2 · The employee's own row: one column, enforced two ways
--
-- employees_self_update (0002:171) had `with check (profile_id = auth.uid() and
-- company_id = company_id)`. The second clause compares a column to itself and
-- is therefore always true, so the policy authorised the employee to write every
-- column of their own row. Measured against HEAD as a plain EMPLOYEE session:
--
--   ALLOWED  hourly_rate := 999
--   ALLOWED  employment_status := 'terminated'
--   ALLOWED  vacation_days_total := 99
--   ALLOWED  employee_no := 'A-999'
--   ALLOWED  weekly_hours := 1
--   ALLOWED  contract_type := 'mini_job'
--   ALLOWED  company_id := <another tenant>
--
-- The last one is a tenant escape of the employee's own record. It appeared
-- refused on the first probe, but only because a sick_leaves row happened to
-- exist and Phase E's composite FK caught it; with no absence rows it succeeds.
-- That is why the test for it deletes the absence rows first.
--
-- RLS is row-oriented: `using` picks the rows, `with check` validates the
-- result, and neither can compare OLD to NEW or restrict a single column. So the
-- policy below fixes the tautology and the trigger states the actual rule.
-- ---------------------------------------------------------------------------
drop policy if exists employees_self_update on public.employees;

create policy employees_self_update on public.employees
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3 · The self-service field set, stated as a whitelist
--
-- Written as a whitelist rather than a blocklist, the same decision as
-- guard_time_entry_mutation() (0013) and for the same reason: employees has 20
-- columns today, and naming the protected ones would leave every column added
-- by a later migration editable by default. Comparing whole rows as jsonb minus
-- the permitted keys means a new column is immutable until someone deliberately
-- adds it here. That is the safe direction to be wrong in.
--
-- updated_at is excluded because set_updated_at (0001:496) is also a BEFORE
-- UPDATE trigger and sorts before this one alphabetically, so by the time this
-- runs the timestamp has already changed.
--
-- The invariant, in words: for a non-HR caller, the only thing that may differ
-- between OLD and NEW on an employees row is the phone number.
-- ---------------------------------------------------------------------------
create or replace function public.guard_employee_field_ownership()
returns trigger
language plpgsql
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  -- HR keeps full rights. is_hr() rather than is_staff(): dispatch has no
  -- update policy at all now, so it never reaches this trigger.
  if app.is_hr(old.company_id) then
    return new;
  end if;

  v_old := to_jsonb(old) - 'phone' - 'updated_at';
  v_new := to_jsonb(new) - 'phone' - 'updated_at';

  if v_old <> v_new then
    raise exception 'an employee may only change their own phone number'
      using errcode = 'check_violation',
            hint = 'Employment data — status, contract, hours, pay, position, '
                   'department, location and employee number — is maintained by '
                   'HR. Ask them to correct it.';
  end if;

  return new;
end $$;

comment on function public.guard_employee_field_ownership() is
  'For a non-HR caller, the only permitted change to an employees row is the '
  'phone number. Whitelisted, so a column added by a later migration is '
  'immutable until someone decides otherwise.';

-- Named to sort BEFORE guard_employee_profile_link: Postgres fires row triggers
-- in alphabetical order, and field ownership is the more fundamental rule. An
-- employee who tries to move their own row to another company should be told
-- they may only change their phone number, not handed a confusing message about
-- account membership.
drop trigger if exists guard_employee_self_mutation on public.employees;
drop trigger if exists guard_employee_field_ownership on public.employees;
create trigger guard_employee_field_ownership
  before update on public.employees
  for each row execute function public.guard_employee_field_ownership();

-- ---------------------------------------------------------------------------
-- 4 · Employment history does not disappear with the employee
--
-- Two behaviours, measured, and the difference is why the trigger is needed:
--
--   employee WITH a shift_assignment  → already refused, because the cascade
--     reaches shift_assignments and fires guard_history_delete() from 0012.
--     That guard was written for a different reason and holds here by accident.
--
--   employee with NO assignment but a completed time entry → ALLOWED, and the
--     time entry (with its clock-in coordinates), qualifications and emergency
--     contact were erased. time_entries has no delete guard of its own; 0013
--     removed the employee's DELETE policy, but HR's cascade is a different door.
--
-- Reuses the existing guard function rather than writing a second one: same
-- message, same app.allow_history_delete escape hatch for genuine maintenance,
-- no new concept for a reader to learn. Belt and braces with the missing DELETE
-- policy above, and unlike the policy it also covers service_role.
--
-- Consequence worth stating: this also blocks the companies → employees cascade.
-- Deleting a company is not a product operation, and shift_assignments has had
-- the same property since 0012.
-- ---------------------------------------------------------------------------
drop trigger if exists guard_no_employee_delete on public.employees;
create trigger guard_no_employee_delete
  before delete on public.employees
  for each row execute function public.guard_history_delete();

-- ---------------------------------------------------------------------------
-- 5 · An employee's references belong to the same tenant
--
-- Same class Phase E found on the absence tables: every write policy checks only
-- the company_id written on the row, never that the thing it points at belongs
-- to that company. Four holes measured against HEAD, all as company B's admin:
--
--   ALLOWED  employee_qualifications row: company_id = B, employee_id = A's
--   ALLOWED  employee_availability   row: company_id = B, employee_id = A's
--   ALLOWED  emergency_contacts      row: company_id = B, employee_id = A's
--   ALLOWED  employees row in B carrying A's profile_id
--   ALLOWED  employees row in B carrying A's location_id
--
-- The three child tables and the two lookups are expressible as composite
-- foreign keys, which is better than a trigger: declarative, unbypassable, and
-- it makes the pair the key. employees already gained `unique (id, company_id)`
-- in Phase E; locations and departments need theirs here.
--
-- profile_id cannot be done this way — profiles have no company_id — so it gets
-- the trigger in section 6.
--
-- SCOPE: exactly the tables Phase F writes. The same class exists elsewhere in
-- the schema and is deliberately left alone; that sweep is its own phase.
-- ---------------------------------------------------------------------------
alter table public.locations
  drop constraint if exists locations_id_company_key;
alter table public.locations
  add constraint locations_id_company_key unique (id, company_id);

alter table public.departments
  drop constraint if exists departments_id_company_key;
alter table public.departments
  add constraint departments_id_company_key unique (id, company_id);

alter table public.employees
  drop constraint if exists employees_location_same_company;
alter table public.employees
  add constraint employees_location_same_company
  foreign key (location_id, company_id)
  references public.locations (id, company_id) on delete set null;

alter table public.employees
  drop constraint if exists employees_department_same_company;
alter table public.employees
  add constraint employees_department_same_company
  foreign key (department_id, company_id)
  references public.departments (id, company_id) on delete set null;

alter table public.employee_qualifications
  drop constraint if exists qualifications_employee_same_company;
alter table public.employee_qualifications
  add constraint qualifications_employee_same_company
  foreign key (employee_id, company_id)
  references public.employees (id, company_id) on delete cascade;

alter table public.employee_availability
  drop constraint if exists availability_employee_same_company;
alter table public.employee_availability
  add constraint availability_employee_same_company
  foreign key (employee_id, company_id)
  references public.employees (id, company_id) on delete cascade;

alter table public.emergency_contacts
  drop constraint if exists emergency_employee_same_company;
alter table public.emergency_contacts
  add constraint emergency_employee_same_company
  foreign key (employee_id, company_id)
  references public.employees (id, company_id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 6 · A linked profile must be a member of the same company
--
-- The one reference a foreign key cannot express: profiles are global, so
-- there is no (id, company_id) pair to point at. Without this, company B can
-- attach company A's person to a B employee row — measured, and it succeeded.
--
-- 'invited' is accepted as well as 'active' so the Phase G invitation flow can
-- create the membership first and link the employee before the person has
-- accepted. Phase F itself never writes profile_id; this guards the column
-- against everything else, now and later.
--
-- security definer so the check sees memberships regardless of the writer's own
-- row visibility, with an empty search_path — the same shape as every other
-- guard in this schema.
-- ---------------------------------------------------------------------------
create or replace function public.guard_employee_profile_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.profile_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.profile_id is not distinct from new.profile_id
     and old.company_id is not distinct from new.company_id then
    return new;
  end if;

  if not exists (
    select 1 from public.company_memberships m
    where m.profile_id = new.profile_id
      and m.company_id = new.company_id
      and m.status in ('active', 'invited')
  ) then
    raise exception 'the linked account is not a member of this company'
      using errcode = 'foreign_key_violation',
            hint = 'An employee record may only be linked to a person who holds '
                   'a membership in the same company.';
  end if;

  return new;
end $$;

comment on function public.guard_employee_profile_link() is
  'employees.profile_id must name someone with a membership in the same '
  'company. The tenant check a foreign key cannot express, because profiles are '
  'global.';

drop trigger if exists guard_employee_profile_link on public.employees;
create trigger guard_employee_profile_link
  before insert or update on public.employees
  for each row execute function public.guard_employee_profile_link();

-- ---------------------------------------------------------------------------
-- 7 · set_employment_status
--
-- Employment status is a FACT about the person, so this commits and reports;
-- it does not refuse. That is the Phase E asymmetry applied one table further
-- out: a vacation request is discretionary, so approving it while someone holds
-- a shift is refused — but sickness, and equally a resignation or a dismissal,
-- is not something the roster gets a vote on. Refusing to record a termination
-- because next week's plan is stale would make the system lie about who works
-- here in order to protect a derived view.
--
-- So: the status changes, EXISTING ASSIGNMENTS ARE LEFT ALONE, and the future
-- assignments that now conflict are returned for a human to resolve through
-- remove_shift_assignment() (0010), which records a reason, notifies the person
-- and reopens the vacancy. Nobody is taken off a shift as a side effect of an HR
-- click.
--
-- The state cannot widen afterwards: approve_shift_offer already refuses an
-- employee outside ('active','probation') and takes the same employee lock
-- first, so a deactivation racing an approval is already serialised. Measured on
-- independent connections in both orders before this was written — no new lock
-- is needed and the global order is unchanged:
--
--   employees → shifts → {cancellation_requests, shift_assignments} → narrower
-- ---------------------------------------------------------------------------
create or replace function public.set_employment_status(
  p_employee_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_employee public.employees%rowtype;
  v_previous public.employment_status;
  v_conflicts jsonb;
  v_count integer;
begin
  if p_status not in ('active', 'probation', 'on_leave', 'terminated') then
    return jsonb_build_object('status', 'invalid_status');
  end if;

  select * into v_employee from public.employees where id = p_employee_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.is_hr(v_employee.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- The outermost lock in the global order. approve_shift_offer() and
  -- decide_vacation_request() take the same row first.
  perform app.lock_employee(p_employee_id);

  select * into v_employee from public.employees where id = p_employee_id for update;
  v_previous := v_employee.employment_status;

  if v_previous::text = p_status then
    return jsonb_build_object('status', 'unchanged', 'current', p_status);
  end if;

  update public.employees
  set employment_status = p_status::public.employment_status
  where id = p_employee_id;

  -- Reported, never acted on. Only FUTURE work is a conflict: a shift that has
  -- already happened is history, and someone leaving does not un-work it.
  select coalesce(jsonb_agg(jsonb_build_object(
           'assignment_id', sa.id,
           'shift_id', s.id,
           'date', s.date,
           'status', sa.status)), '[]'::jsonb),
         count(*)
    into v_conflicts, v_count
  from public.shift_assignments sa
  join public.shifts s on s.id = sa.shift_id
  where sa.employee_id = p_employee_id
    and sa.status in ('assigned', 'accepted', 'cancellation_requested')
    and s.start_time > now();

  -- Only the transition itself. No name, no pay, no contact details: the audit
  -- is read by every company admin, and the event here is the status change.
  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_employee.company_id, auth.uid(),
    'employee.status_changed', 'employees', p_employee_id::text,
    jsonb_build_object(
      'from', v_previous,
      'to', p_status,
      'future_assignments', v_count
    )
  );

  return jsonb_build_object(
    'status', 'changed',
    'from', v_previous,
    'to', p_status,
    'conflicts', v_conflicts,
    'count', v_count
  );
end $$;

comment on function public.set_employment_status(uuid, text) is
  'Change one employee''s employment status. Always commits — employment is a '
  'fact, not a request — and returns the FUTURE assignments that now conflict '
  'so a human can release them through remove_shift_assignment(). Never cancels '
  'anything itself.';

revoke all on function public.set_employment_status(uuid, text) from public;
grant execute on function public.set_employment_status(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8 · remove_qualification
--
-- Same shape, same reason. Removing a qualification never removes an assignment
-- somebody already committed to; the affected future shifts are returned and
-- shown.
--
-- Note what this deliberately does NOT do: approve_shift_offer has never
-- checked qualifications, so there is no SQL invariant here to lose and this is
-- not a race — the removal simply commits. Adding qualification matching to
-- that function would mean porting matchesRequiredRole() and the availability
-- window arithmetic too, i.e. reimplementing the eligibility engine in SQL. The
-- engine stays in TypeScript (eligibility.ts) and the conflict is surfaced to a
-- person instead. Recorded rather than hidden.
--
-- shifts.required_qualification is a single text column matched on the exact
-- trimmed name (hasValidQualification, eligibility.ts:129). This query uses the
-- same rule, so the two cannot disagree about what "required" means.
-- ---------------------------------------------------------------------------
create or replace function public.remove_qualification(p_qualification_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_qual public.employee_qualifications%rowtype;
  v_conflicts jsonb;
  v_count integer;
begin
  select * into v_qual
  from public.employee_qualifications
  where id = p_qualification_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.is_hr(v_qual.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform app.lock_employee(v_qual.employee_id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'assignment_id', sa.id,
           'shift_id', s.id,
           'date', s.date,
           'required_qualification', s.required_qualification)), '[]'::jsonb),
         count(*)
    into v_conflicts, v_count
  from public.shift_assignments sa
  join public.shifts s on s.id = sa.shift_id
  where sa.employee_id = v_qual.employee_id
    and sa.status in ('assigned', 'accepted', 'cancellation_requested')
    and s.start_time > now()
    and btrim(coalesce(s.required_qualification, '')) = btrim(v_qual.name);

  delete from public.employee_qualifications where id = p_qualification_id;

  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_qual.company_id, auth.uid(),
    'qualification.removed', 'employee_qualifications', p_qualification_id::text,
    jsonb_build_object(
      'employee_id', v_qual.employee_id,
      'name', v_qual.name,
      'affected_assignments', v_count
    )
  );

  return jsonb_build_object(
    'status', 'removed',
    'employee_id', v_qual.employee_id,
    'name', v_qual.name,
    'conflicts', v_conflicts,
    'count', v_count
  );
end $$;

comment on function public.remove_qualification(uuid) is
  'Remove one qualification and report the FUTURE assignments that required it. '
  'Never cancels an assignment: a commitment already made is resolved by a '
  'person, through remove_shift_assignment().';

revoke all on function public.remove_qualification(uuid) from public;
grant execute on function public.remove_qualification(uuid) to authenticated, service_role;

-- Clockwise · Migration 0013 · Employee mutation integrity (Phase D.2)
--
-- Additive only. 0001–0012 are untouched as files; this migration supersedes
-- one policy by name and adds two triggers.
--
-- Two holes, both reproduced against HEAD before this was written.
--
-- 1. AN EMPLOYEE COULD REWRITE OR ERASE THEIR OWN WORKED TIME.
--    time_entries_self was FOR ALL keyed only on ownership (0002:294), so a
--    measured employee session could back-date clock_in, extend clock_out on a
--    closed entry, detach it from its shift, relabel the source as 'manual',
--    resurrect a completed entry as running, or delete it outright. Only
--    employee_id was protected, and only because it is the ownership key.
--
-- 2. AN EMPLOYEE COULD PARK THEIR OWN ASSIGNMENT WITHOUT ASKING.
--    assignments_self_update lists 'cancellation_requested' in its with-check
--    (0002:260), so the status could be set directly, bypassing
--    request_shift_cancellation(). Measured result: assignment parked, zero
--    pending requests, the manager's decide path with nothing to decide, and
--    the employee unable to undo it — a stuck state only a removal clears.
--
-- Deliberately NOT here: breaks, time-correction requests, timesheet approval,
-- payroll, absences. This is an integrity phase. time_entries_staff is left
-- exactly as it was — narrowing manager time permissions belongs with the
-- correction workflow that will need them.

-- ---------------------------------------------------------------------------
-- 1 · Employee time-entry policies, one per command
--
-- UPDATE is restricted to a live entry only. 'on_break' is deliberately absent:
-- no application code produces that status today, and a permission for a
-- workflow that does not exist is a permission nobody is testing. When breaks
-- are built, this policy gets extended on purpose.
-- ---------------------------------------------------------------------------
drop policy if exists time_entries_self on public.time_entries;

create policy time_entries_self_select on public.time_entries
  for select to authenticated
  using (employee_id = app.current_employee_id(company_id));

create policy time_entries_self_insert on public.time_entries
  for insert to authenticated
  with check (employee_id = app.current_employee_id(company_id));

create policy time_entries_self_update on public.time_entries
  for update to authenticated
  using (
    employee_id = app.current_employee_id(company_id)
    and status = 'running'
    and clock_out is null
  )
  with check (employee_id = app.current_employee_id(company_id));

-- No self DELETE policy. Worked time is a record of what happened.

comment on policy time_entries_self_update on public.time_entries is
  'An employee may only touch a running, not-yet-closed entry — and, per '
  'guard_time_entry_mutation(), only to clock out of it.';

-- ---------------------------------------------------------------------------
-- 2 · The clock-out transition, stated positively
--
-- RLS is row-oriented: `using` picks which rows may be updated and `with check`
-- validates the result, but neither can compare OLD to NEW or restrict a single
-- column. So the row policy above stops history being rewritten, and this
-- trigger stops a LIVE entry being used as a loophole.
--
-- Written as a whitelist rather than a blocklist, deliberately. time_entries
-- has 21 columns; protecting the five obvious identity fields would have left
-- an employee free to edit location_note and — far worse — the clock_in
-- geofence evidence: clock_in_lat/lng/accuracy_m/distance_m and
-- clock_in_location_status. Someone who clocked in from the wrong place could
-- simply overwrite 'outside_geofence' with 'verified'.
--
-- Comparing whole rows as jsonb minus the permitted keys also means a column
-- added in a later migration is immutable by default. That is the safe
-- direction to be wrong in.
--
-- updated_at is excluded because set_updated_at (0001:502) is also a BEFORE
-- UPDATE trigger and sorts before this one alphabetically, so by the time this
-- runs the timestamp has already changed.
--
-- The invariant, in words: for a non-staff caller, an UPDATE must be exactly
-- the clock-out transition — a running entry becoming a completed one with an
-- end time — and nothing else about the row may move.
-- ---------------------------------------------------------------------------
create or replace function public.guard_time_entry_mutation()
returns trigger
language plpgsql
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  -- Staff keep full rights: manager time correction is a later phase and this
  -- must not pre-empt it. is_staff() rather than the scheduling helper, because
  -- time is an HR and dispatch concern alike.
  if app.is_staff(old.company_id) then
    return new;
  end if;

  if old.clock_out is not null then
    raise exception 'time entry is closed and cannot be changed'
      using errcode = 'check_violation',
            hint = 'A completed time entry is a record of what happened. '
                   'Ask a manager to correct it.';
  end if;

  if not (old.status = 'running' and new.status = 'completed' and new.clock_out is not null) then
    raise exception 'the only change an employee may make to a time entry is clocking out'
      using errcode = 'check_violation';
  end if;

  v_old := to_jsonb(old)
    - 'clock_out' - 'status'
    - 'clock_out_lat' - 'clock_out_lng' - 'clock_out_accuracy_m'
    - 'clock_out_distance_m' - 'clock_out_location_status'
    - 'updated_at';
  v_new := to_jsonb(new)
    - 'clock_out' - 'status'
    - 'clock_out_lat' - 'clock_out_lng' - 'clock_out_accuracy_m'
    - 'clock_out_distance_m' - 'clock_out_location_status'
    - 'updated_at';

  if v_old <> v_new then
    raise exception 'a time entry may not be altered while clocking out'
      using errcode = 'check_violation',
            hint = 'Only the clock-out time, status and clock-out location may change.';
  end if;

  return new;
end $$;

comment on function public.guard_time_entry_mutation() is
  'For a non-staff caller, the only permitted UPDATE on a time entry is the '
  'clock-out transition. Everything else about the row — including the '
  'clock-in geofence evidence — is immutable.';

drop trigger if exists guard_time_entry_mutation on public.time_entries;
create trigger guard_time_entry_mutation
  before update on public.time_entries
  for each row execute function public.guard_time_entry_mutation();

-- ---------------------------------------------------------------------------
-- 3 · cancellation_requested implies a pending request
--
-- request_shift_cancellation() (0009) inserts the request and THEN parks the
-- assignment, both inside one transaction — verified before relying on it. So
-- this invariant is satisfied by the RPC and violated by anything else,
-- including a direct table write from a Supabase session.
--
-- assignments_self_update is left untouched. Narrowing its with-check would
-- have been the obvious move and would have broken the RPC: it is SECURITY
-- INVOKER, so its own UPDATE runs under the employee's policies. Expressing
-- the rule as data integrity instead keeps the RPC working and states
-- something stronger than a permission would — the parked state simply cannot
-- exist without the request that explains it.
--
-- Applies to every caller. Nothing in the product parks someone else's
-- assignment; a manager taking someone off a shift uses
-- remove_shift_assignment(), which writes 'cancelled'.
-- ---------------------------------------------------------------------------
create or replace function public.guard_assignment_cancellation_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancellation_requested'
     and old.status is distinct from 'cancellation_requested' then
    if not exists (
      select 1 from public.cancellation_requests
      where shift_assignment_id = new.id and status = 'pending'
    ) then
      raise exception 'an assignment cannot be parked without a cancellation request'
        using errcode = 'check_violation',
              hint = 'Use request_shift_cancellation(), which records the reason '
                     'and parks the assignment together.';
    end if;
  end if;
  return new;
end $$;

comment on function public.guard_assignment_cancellation_request() is
  'Enforces that shift_assignments.status = cancellation_requested always has a '
  'pending cancellation_requests row behind it. security definer so the check '
  'sees the request regardless of the caller''s own row visibility.';

drop trigger if exists guard_assignment_cancellation_request on public.shift_assignments;
create trigger guard_assignment_cancellation_request
  before update on public.shift_assignments
  for each row execute function public.guard_assignment_cancellation_request();

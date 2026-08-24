-- Clockwise · Migration 0011 · Shift lifecycle (Phase D)
--
-- Additive only. 0001–0010 are untouched, and no Phase B/C function is
-- replaced. Until now a shift could not be created, changed or called off by
-- the application at all — every shift in the system came from a seed script,
-- while the entire staffing workflow downstream of it was fully implemented.
--
-- Three manager actions, and only three:
--
--   create_shift()   plan work
--   update_shift()   change the plan, within limits that get stricter the
--                    further the staffing conversation has gone
--   cancel_shift()   call the work off
--
-- `open` and `staffed` are NOT actions. They are derived from occupancy by
-- recalc_shift_staffing() (0001:526) and nothing here lets a human choose
-- between them — that is how the two would drift apart. `cancelled` is the one
-- status a manager sets. `in_progress` and `completed` remain unreachable;
-- they need a scheduled job and a definition of "worked", which is a later
-- phase, not something to fake here.
--
-- ---------------------------------------------------------------------------
-- LOCK ORDER
--
-- Same as 0007/0009/0010: the shift row first, then narrower rows. These
-- functions hold a shift id rather than an assignment id and the caller is
-- always staff, who pass the UPDATE policy on shifts — so they take the lock
-- directly instead of through app.lock_shift_of_assignment(), which exists for
-- employees who may read a shift but not update it.
--
-- ---------------------------------------------------------------------------
-- WHY cancel_shift LOCKS THE ASSIGNMENTS
--
-- Cancelling a shift while somebody is clocking in must not produce the state
-- "shift cancelled, assignment cancelled, and worked time recorded afterwards".
--
-- Clock-in is not one transaction — it is a sequence of separate PostgREST
-- statements ending in an INSERT into time_entries. It takes no lock on shifts
-- and none on shift_assignments. An UPDATE of shift_assignments.status would
-- not stop it either: a plain UPDATE of a non-key column takes FOR NO KEY
-- UPDATE, which does not conflict with the FOR KEY SHARE that an inserting
-- child row takes on its parent.
--
-- An explicit SELECT ... FOR UPDATE does conflict with FOR KEY SHARE, and
-- time_entries.shift_assignment_id is a foreign key to shift_assignments
-- (0001:238). So locking the occupying assignments makes the two operations
-- serialise on that row, through the foreign key. Verified experimentally on
-- two connections before this was written, and again in
-- tests/db/shift-lifecycle.test.ts.
--
-- The worked-time check therefore happens AFTER the lock is taken. That
-- ordering is the whole guarantee: whichever transaction gets there first
-- wins cleanly, and the other sees a committed fact.
--
-- ---------------------------------------------------------------------------
-- DATE DERIVATION
--
-- shifts.date is a separate column from start_time and is what eligibility
-- compares vacation, sick leave, qualification expiry and availability against
-- (candidates.ts:154,155,162,195). If the two drift, the engine silently
-- evaluates the wrong calendar day, so date is ALWAYS derived here and never
-- accepted from a caller.
--
-- The project has no per-company timezone and this migration does not invent
-- one. It uses the convention the repository already established: scripts/
-- seed.ts builds every start_time in German local time and stores the local
-- calendar date, and kiel-demo-plan.ts gives an overnight 22:00–06:00 shift
-- the date of the day it starts. 'Europe/Berlin' names that convention and,
-- unlike the seed's hard-coded +02:00, stays correct across DST.
--
-- When per-company timezone arrives, this is the one line to change.

alter type public.notification_type add value if not exists 'shift_cancelled';

-- ---------------------------------------------------------------------------
-- No worked time against a dead assignment.
--
-- The lock in cancel_shift() is necessary but NOT sufficient, which was proved
-- on two connections rather than reasoned about: the insert blocks on the
-- foreign key while the cancellation holds its lock, and then — once the
-- cancellation commits — proceeds and succeeds anyway. The result was exactly
-- the state Phase D must never produce: shift cancelled, assignment cancelled,
-- worked time recorded afterwards.
--
-- So the check has to happen after the wait, on the row as it then is. A plain
-- SELECT would not do it: a BEFORE INSERT trigger runs before the foreign-key
-- check, so under READ COMMITTED it would read the pre-cancellation snapshot
-- and wave the insert through. `for update` makes the trigger itself wait on
-- the same lock and re-read the committed row afterwards.
--
-- security definer because an employee's UPDATE policy on shift_assignments
-- only exposes 'assigned' and 'accepted' rows, so under the caller's own
-- rights a cancelled row would come back "not found" and be allowed. The
-- function returns no data — it reads one status and takes one lock.
--
-- This also closes a defence-in-depth gap that predates Phase D: time_entries
-- RLS is ownership-only, so the database itself never refused a time entry
-- against a cancelled assignment. The application always did; now both do.
-- ---------------------------------------------------------------------------
create or replace function public.guard_time_entry_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.assignment_status;
begin
  if new.shift_assignment_id is null then
    return new;   -- standalone time entry, nothing to check against
  end if;

  select status into v_status
  from public.shift_assignments
  where id = new.shift_assignment_id
  for update;

  if not found then
    return new;
  end if;

  if v_status not in ('assigned', 'accepted', 'cancellation_requested') then
    raise exception 'assignment_not_active'
      using errcode = 'check_violation',
            hint = 'This assignment was cancelled or completed; no time can be recorded against it.';
  end if;

  return new;
end $$;

comment on function public.guard_time_entry_assignment() is
  'Refuses a time entry whose assignment is no longer active, taking the '
  'assignment row lock so it serialises against cancel_shift() and '
  'remove_shift_assignment().';

drop trigger if exists guard_time_entry_assignment on public.time_entries;
create trigger guard_time_entry_assignment
  before insert on public.time_entries
  for each row execute function public.guard_time_entry_assignment();

-- ---------------------------------------------------------------------------
-- Who may run these three functions.
--
-- NOT app.is_staff(): that helper includes HR_MANAGER (0002:47), and shift
-- authoring is a scheduling act, not a people act. This mirrors the
-- `scheduling.manage` permission in src/lib/permissions.ts:48 exactly, so the
-- application check and the database check cannot drift apart.
-- ---------------------------------------------------------------------------
create or replace function app.can_manage_scheduling(cid uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select app.has_role(cid, array['SUPER_ADMIN','COMPANY_ADMIN','DISPATCHER']::public.membership_role[])
$$;

comment on function app.can_manage_scheduling(uuid) is
  'True for the roles holding scheduling.manage. Deliberately narrower than '
  'app.is_staff(), which also admits HR_MANAGER.';

revoke all on function app.can_manage_scheduling(uuid) from public, anon;
grant execute on function app.can_manage_scheduling(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- create_shift
-- ---------------------------------------------------------------------------
create or replace function public.create_shift(
  p_job_id uuid,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_required_count integer,
  p_required_role text default null,
  p_required_qualification text default null,
  p_instructions text default null,
  p_contact_person text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_shift_id uuid;
  v_date date;
begin
  -- RLS scopes this read, so a job in another tenant does not resolve. The
  -- company is taken from the job, never from the caller's input.
  select * into v_job from public.jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.can_manage_scheduling(v_job.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_end_time <= p_start_time then
    return jsonb_build_object('status', 'invalid_interval');
  end if;
  if p_required_count is null or p_required_count < 1 then
    return jsonb_build_object('status', 'invalid_count');
  end if;
  if p_start_time <= now() then
    return jsonb_build_object('status', 'start_in_past');
  end if;

  v_date := (p_start_time at time zone 'Europe/Berlin')::date;

  insert into public.shifts (
    company_id, job_id, date, start_time, end_time, required_count,
    required_role, required_qualification, instructions, contact_person, status
  )
  values (
    v_job.company_id, v_job.id, v_date, p_start_time, p_end_time, p_required_count,
    nullif(btrim(coalesce(p_required_role, '')), ''),
    nullif(btrim(coalesce(p_required_qualification, '')), ''),
    nullif(btrim(coalesce(p_instructions, '')), ''),
    nullif(btrim(coalesce(p_contact_person, '')), ''),
    'open'
  )
  returning id into v_shift_id;

  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_job.company_id, auth.uid(), 'shift.created', 'shifts', v_shift_id::text,
    jsonb_build_object(
      'job_id', v_job.id,
      'date', v_date,
      'start_time', p_start_time,
      'end_time', p_end_time,
      'required_count', p_required_count,
      'required_role', p_required_role,
      'required_qualification', p_required_qualification
    )
  );

  return jsonb_build_object('status', 'created', 'shift_id', v_shift_id, 'date', v_date);
end $$;

comment on function public.create_shift(uuid, timestamptz, timestamptz, integer, text, text, text, text) is
  'Create one shift under an existing job. The company comes from the job, the '
  'calendar date is derived from start_time, and the status is always open — '
  'the staffing trigger decides when it becomes staffed.';

revoke all on function public.create_shift(uuid, timestamptz, timestamptz, integer, text, text, text, text) from public;
grant execute on function public.create_shift(uuid, timestamptz, timestamptz, integer, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- update_shift
--
-- The patch is jsonb because presence and null must be distinguishable:
-- omitting `required_role` means "leave it", passing null means "clear it".
-- Only the keys present are considered, and only those that actually differ
-- are applied — a form that posts every field on every save must not count as
-- an edit.
-- ---------------------------------------------------------------------------
create or replace function public.update_shift(
  p_shift_id uuid,
  p_patch jsonb,
  p_confirm boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_job public.jobs%rowtype;
  v_occupancy integer;
  v_interested integer;
  v_open_offer uuid;
  v_has_time boolean;
  v_engagement text;
  v_changed text[] := '{}';
  v_risk integer := 0;   -- 0 informational · 1 capacity · 2 eligibility · 3 commitment
  v_field text;
  v_diff jsonb := '{}'::jsonb;
  v_new_start timestamptz;
  v_new_end timestamptz;
  v_new_count integer;
  v_new_job uuid;
  v_date date;
  v_status public.shift_status;
  v_offer_closed boolean := false;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.can_manage_scheduling(v_shift.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if v_shift.status = 'cancelled' then
    return jsonb_build_object('status', 'shift_cancelled');
  end if;

  -- ---- what actually differs -------------------------------------------
  v_new_start := coalesce((p_patch->>'start_time')::timestamptz, v_shift.start_time);
  v_new_end   := coalesce((p_patch->>'end_time')::timestamptz, v_shift.end_time);
  v_new_count := coalesce((p_patch->>'required_count')::integer, v_shift.required_count);
  v_new_job   := coalesce((p_patch->>'job_id')::uuid, v_shift.job_id);

  if p_patch ? 'job_id' and v_new_job is distinct from v_shift.job_id then
    v_changed := v_changed || 'job_id'::text;
  end if;
  if p_patch ? 'start_time' and v_new_start is distinct from v_shift.start_time then
    v_changed := v_changed || 'start_time'::text;
  end if;
  if p_patch ? 'end_time' and v_new_end is distinct from v_shift.end_time then
    v_changed := v_changed || 'end_time'::text;
  end if;
  if p_patch ? 'required_count' and v_new_count is distinct from v_shift.required_count then
    v_changed := v_changed || 'required_count'::text;
  end if;
  if p_patch ? 'required_role'
     and nullif(btrim(coalesce(p_patch->>'required_role', '')), '') is distinct from v_shift.required_role then
    v_changed := v_changed || 'required_role'::text;
  end if;
  if p_patch ? 'required_qualification'
     and nullif(btrim(coalesce(p_patch->>'required_qualification', '')), '') is distinct from v_shift.required_qualification then
    v_changed := v_changed || 'required_qualification'::text;
  end if;
  if p_patch ? 'instructions'
     and nullif(btrim(coalesce(p_patch->>'instructions', '')), '') is distinct from v_shift.instructions then
    v_changed := v_changed || 'instructions'::text;
  end if;
  if p_patch ? 'contact_person'
     and nullif(btrim(coalesce(p_patch->>'contact_person', '')), '') is distinct from v_shift.contact_person then
    v_changed := v_changed || 'contact_person'::text;
  end if;

  if array_length(v_changed, 1) is null then
    return jsonb_build_object('status', 'no_changes');
  end if;

  -- ---- engagement, read under the shift lock ---------------------------
  select count(*) into v_occupancy
  from public.shift_assignments
  where shift_id = v_shift.id
    and status in ('assigned', 'accepted', 'cancellation_requested');

  select id into v_open_offer
  from public.shift_offers
  where shift_id = v_shift.id and status = 'open';

  select count(*) into v_interested
  from public.shift_offer_responses r
  join public.shift_offers o on o.id = r.offer_id
  where o.shift_id = v_shift.id and r.response = 'interested' and r.decided_at is null;

  select exists (
    select 1 from public.time_entries te
    join public.shift_assignments sa on sa.id = te.shift_assignment_id
    where sa.shift_id = v_shift.id
  ) into v_has_time;

  v_engagement := case
    when v_shift.end_time <= now() then 'past'
    when v_has_time then 'worked'
    when v_occupancy > 0 then 'assigned'
    when v_interested > 0 then 'interested'
    when v_open_offer is not null then 'offered'
    else 'none'
  end;

  -- ---- the matrix, mirroring src/lib/shift-lifecycle.ts ----------------
  -- Ranked numerically, not alphabetically: the strictest field in the edit
  -- decides, and an edit is one transaction so it cannot be partly applied.
  -- Mirrors FIELD_RISK in src/lib/shift-lifecycle.ts.
  foreach v_field in array v_changed loop
    v_risk := greatest(v_risk, case v_field
      when 'instructions' then 0
      when 'contact_person' then 0
      when 'required_count' then 1
      when 'required_role' then 2
      when 'required_qualification' then 2
      else 3   -- start_time, end_time, job_id
    end);
  end loop;

  if v_engagement = 'past' then
    return jsonb_build_object('status', 'shift_ended');
  end if;

  if v_risk >= 2 then
    if v_engagement = 'worked' then
      return jsonb_build_object('status', 'has_time_entries');
    end if;
    if v_engagement = 'assigned' then
      return jsonb_build_object('status', 'has_assignments', 'assignments', v_occupancy);
    end if;
    if 'job_id' = any(v_changed) and v_engagement <> 'none' then
      return jsonb_build_object('status', 'job_locked');
    end if;
    -- offered / interested: allowed, but it invalidates the invitation.
    if v_engagement <> 'none' and not p_confirm then
      return jsonb_build_object(
        'status', 'requires_confirmation',
        'reason', 'invalidates_open_offer',
        'engagement', v_engagement,
        'interested', v_interested,
        'changed', to_jsonb(v_changed)
      );
    end if;
  end if;

  -- ---- capacity --------------------------------------------------------
  if 'required_count' = any(v_changed) then
    if v_new_count < 1 then
      return jsonb_build_object('status', 'invalid_count');
    end if;
    if v_new_count < v_occupancy then
      -- Never drop someone as a side effect of arithmetic. The manager
      -- releases a person explicitly (0010) and then reduces the count.
      return jsonb_build_object(
        'status', 'below_occupancy',
        'occupancy', v_occupancy,
        'requested', v_new_count
      );
    end if;
  end if;

  -- ---- interval --------------------------------------------------------
  if v_new_end <= v_new_start then
    return jsonb_build_object('status', 'invalid_interval');
  end if;
  if ('start_time' = any(v_changed) or 'end_time' = any(v_changed))
     and v_new_start <= now() then
    return jsonb_build_object('status', 'start_in_past');
  end if;

  -- ---- job must stay inside the tenant ---------------------------------
  if 'job_id' = any(v_changed) then
    select * into v_job from public.jobs where id = v_new_job;
    if not found or v_job.company_id <> v_shift.company_id then
      return jsonb_build_object('status', 'not_found');
    end if;
  end if;

  -- ---- apply -----------------------------------------------------------
  v_date := (v_new_start at time zone 'Europe/Berlin')::date;

  foreach v_field in array v_changed loop
    v_diff := v_diff || jsonb_build_object(
      v_field,
      jsonb_build_object(
        'from', to_jsonb(v_shift) -> v_field,
        'to', case v_field
          when 'job_id' then to_jsonb(v_new_job)
          when 'start_time' then to_jsonb(v_new_start)
          when 'end_time' then to_jsonb(v_new_end)
          when 'required_count' then to_jsonb(v_new_count)
          else to_jsonb(nullif(btrim(coalesce(p_patch->>v_field, '')), ''))
        end
      )
    );
  end loop;

  update public.shifts
  set job_id = v_new_job,
      start_time = v_new_start,
      end_time = v_new_end,
      date = v_date,
      required_count = v_new_count,
      required_role = case when 'required_role' = any(v_changed)
        then nullif(btrim(coalesce(p_patch->>'required_role', '')), '') else required_role end,
      required_qualification = case when 'required_qualification' = any(v_changed)
        then nullif(btrim(coalesce(p_patch->>'required_qualification', '')), '') else required_qualification end,
      instructions = case when 'instructions' = any(v_changed)
        then nullif(btrim(coalesce(p_patch->>'instructions', '')), '') else instructions end,
      contact_person = case when 'contact_person' = any(v_changed)
        then nullif(btrim(coalesce(p_patch->>'contact_person', '')), '') else contact_person end
  where id = v_shift.id;

  -- The staffing trigger fires on shift_assignments, never on shifts, so a
  -- capacity change would otherwise leave shifts.status stale — a shift with
  -- required_count raised from 1 to 3 would keep saying 'staffed' while
  -- genuinely understaffed, and approve_shift_offer gates on that column.
  if 'required_count' = any(v_changed) and v_shift.status in ('open', 'staffed') then
    v_status := case when v_occupancy >= v_new_count then 'staffed' else 'open' end;
    update public.shifts set status = v_status where id = v_shift.id;
  end if;

  -- An invitation made against the old shift is no longer the same offer.
  -- Responses are left untouched as history; closing the offer is what makes
  -- them non-actionable, exactly as approve_shift_offer does when a shift fills.
  if v_risk >= 2 and v_open_offer is not null then
    update public.shift_offers
    set status = 'cancelled', closed_at = now()
    where id = v_open_offer and status = 'open';
    v_offer_closed := true;
  end if;

  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_shift.company_id, auth.uid(), 'shift.updated', 'shifts', v_shift.id::text,
    jsonb_build_object('engagement', v_engagement, 'offer_closed', v_offer_closed, 'changes', v_diff)
  );

  return jsonb_build_object(
    'status', 'updated',
    'shift_id', v_shift.id,
    'changed', to_jsonb(v_changed),
    'offer_closed', v_offer_closed,
    'notify', v_risk <> 1,
    'engagement', v_engagement
  );
end $$;

comment on function public.update_shift(uuid, jsonb, boolean) is
  'Change a shift, within limits that tighten as the staffing conversation '
  'progresses. Informational fields and capacity are always editable; role and '
  'qualification and times need confirmation once anyone has been invited and '
  'are refused once anyone is assigned; the job — and therefore the site — is '
  'locked as soon as anyone has been invited.';

revoke all on function public.update_shift(uuid, jsonb, boolean) from public;
grant execute on function public.update_shift(uuid, jsonb, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- cancel_shift
-- ---------------------------------------------------------------------------
create or replace function public.cancel_shift(
  p_shift_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_assignments integer := 0;
  v_offers integer := 0;
  v_requests integer := 0;
  v_has_time boolean;
begin
  if coalesce(btrim(p_reason), '') = '' then
    return jsonb_build_object('status', 'reason_required');
  end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.can_manage_scheduling(v_shift.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if v_shift.status = 'cancelled' then
    -- Idempotent and silent: no second audit row, nobody notified again.
    return jsonb_build_object('status', 'already_cancelled');
  end if;

  if v_shift.end_time <= now() then
    return jsonb_build_object('status', 'shift_ended');
  end if;

  -- THE LOCK THAT CLOSES THE CLOCK-IN RACE. See the header: an inserting
  -- time_entries row takes FOR KEY SHARE on its parent assignment through the
  -- foreign key, which conflicts with FOR UPDATE. Taking it here, BEFORE the
  -- worked-time check below, is what makes cancel and clock-in serialise.
  perform 1
  from public.shift_assignments
  where shift_id = v_shift.id
    and status in ('assigned', 'accepted', 'cancellation_requested')
  for update;

  select exists (
    select 1 from public.time_entries te
    join public.shift_assignments sa on sa.id = te.shift_assignment_id
    where sa.shift_id = v_shift.id
  ) into v_has_time;

  if v_has_time then
    -- Someone worked, or is working. Calling the shift off now would leave
    -- recorded time attached to work that officially never happened.
    return jsonb_build_object('status', 'already_worked');
  end if;

  -- Settle pending release requests first: leaving one pending against a
  -- cancelled shift would be a state nothing could ever resolve. Same
  -- reasoning as 0010.
  with settled as (
    update public.cancellation_requests cr
    set status = 'approved', decided_by = auth.uid(), decided_at = now()
    where cr.status = 'pending'
      and cr.shift_assignment_id in (
        select id from public.shift_assignments where shift_id = v_shift.id
      )
    returning 1
  )
  select count(*) into v_requests from settled;

  with cancelled_assignments as (
    update public.shift_assignments
    set status = 'cancelled'
    where shift_id = v_shift.id
      and status in ('assigned', 'accepted', 'cancellation_requested')
    returning 1
  )
  select count(*) into v_assignments from cancelled_assignments;

  with closed as (
    update public.shift_offers
    set status = 'cancelled', closed_at = now()
    where shift_id = v_shift.id and status = 'open'
    returning 1
  )
  select count(*) into v_offers from closed;

  -- Last, so the staffing trigger above has already run against a shift that
  -- was still open/staffed. 'cancelled' is terminal and recalc_shift_staffing
  -- deliberately never overwrites it (0001:546).
  update public.shifts set status = 'cancelled' where id = v_shift.id;

  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_shift.company_id, auth.uid(), 'shift.cancelled', 'shifts', v_shift.id::text,
    jsonb_build_object(
      'reason', p_reason,
      'assignments_cancelled', v_assignments,
      'offers_closed', v_offers,
      'requests_settled', v_requests,
      'start_time', v_shift.start_time
    )
  );

  return jsonb_build_object(
    'status', 'cancelled',
    'shift_id', v_shift.id,
    'assignments_cancelled', v_assignments,
    'offers_closed', v_offers,
    'requests_settled', v_requests
  );
end $$;

comment on function public.cancel_shift(uuid, text) is
  'Call off one shift: releases everyone holding a seat, closes the open offer '
  'and settles pending release requests, in one transaction. Refuses once any '
  'time has been recorded. Never deletes: responses, time entries and '
  'attendance history all survive.';

revoke all on function public.cancel_shift(uuid, text) from public;
grant execute on function public.cancel_shift(uuid, text) to authenticated, service_role;

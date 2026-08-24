-- Clockwise · Migration 0012 · Harden scheduling authorization and history (Phase D.1)
--
-- Additive only. 0001–0011 are untouched as files; this migration supersedes
-- two policies and three function bodies by name, which is the only way to
-- change them without editing history.
--
-- Two problems, both measured rather than assumed:
--
-- 1. HISTORY COULD BE PHYSICALLY DELETED. One DELETE of a single shift removed
--    its assignments, offers, responses, cancellation requests and attendance
--    alerts through cascades — and left the time entries behind with a null
--    shift_assignment_id. Worked hours pointing at nothing is worse than
--    hours that are gone: the timesheet still shows them, with no context.
--    The same subtree dies from deleting one assignment directly, and the
--    whole thing again from deleting the job above it (jobs → shifts is
--    CASCADE too).
--
--    No application code has ever issued such a DELETE — an exhaustive search
--    of src/, scripts/ and the migrations finds none. The guard exists so that
--    stays true by construction rather than by discipline.
--
-- 2. THE DATABASE HAD ONE PRIVILEGE TIER WHERE THE APPLICATION HAS FOUR.
--    app.is_staff() (0002:47) admits COMPANY_ADMIN, HR_MANAGER and DISPATCHER,
--    and nearly every write policy used it. Measured result: an HR manager and
--    a dispatcher had identical rights on every scheduling table, so HR could
--    create shifts, assign people, approve offers and remove employees —
--    either through the RPCs or, worse, by writing the tables directly and
--    skipping every capacity check, overlap check, lock and audit entry.
--
--    The application layer always refused HR (permissions.ts:48). The database
--    did not. This aligns them.
--
-- What is deliberately NOT here:
--   · vacation_requests / sick_leaves — a dispatcher can currently approve
--     absences, which is the mirror-image mistake. Phase E owns that boundary,
--     alongside the workflow it protects.
--   · time_entries — an employee can currently rewrite and delete their own
--     recorded hours. A design is written up but not applied: removing UPDATE
--     outright would break clock-out, which legitimately updates the row.
--   · assignments_self_update — left exactly as it was, see the note below it.

-- ---------------------------------------------------------------------------
-- 1 · Historical delete guard
--
-- Operational history is status-transitioned, never physically removed: a
-- cancelled shift, a removed assignment and a released employee all remain as
-- rows that say what happened. Nothing in the product needs to erase them.
--
-- A trigger rather than a DELETE policy, deliberately. RLS does not apply to
-- service_role (BYPASSRLS), and this application already uses a service-role
-- client for notification fan-out and the attendance runner — precisely the
-- kind of code where a mistaken DELETE would go unnoticed. A trigger binds
-- every caller: authenticated users, service_role, the table owner and any
-- future maintenance script.
--
-- The escape hatch is a session flag, so removing history is possible but only
-- as a deliberate, visible act:
--
--   set local app.allow_history_delete = 'on';
--
-- The default is always protected: an unset flag reads as 'off'.
-- ---------------------------------------------------------------------------
create or replace function public.guard_history_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.allow_history_delete', true), 'off') = 'on' then
    return old;
  end if;

  raise exception
    'Deleting % is not permitted: operational history is cancelled, not removed.', tg_table_name
    using errcode = 'check_violation',
          hint = 'Cancel or remove the record instead. For genuine maintenance, '
                 'set local app.allow_history_delete = ''on'' first.';
end $$;

comment on function public.guard_history_delete() is
  'Refuses DELETE on the tables that carry staffing history, for every caller '
  'including service_role. Bypassed only by an explicit session flag.';

drop trigger if exists guard_no_job_delete on public.jobs;
create trigger guard_no_job_delete
  before delete on public.jobs
  for each row execute function public.guard_history_delete();

drop trigger if exists guard_no_shift_delete on public.shifts;
create trigger guard_no_shift_delete
  before delete on public.shifts
  for each row execute function public.guard_history_delete();

drop trigger if exists guard_no_assignment_delete on public.shift_assignments;
create trigger guard_no_assignment_delete
  before delete on public.shift_assignments
  for each row execute function public.guard_history_delete();

-- ---------------------------------------------------------------------------
-- 2 · Command-specific scheduling policies
--
-- shifts_staff and assignments_staff were FOR ALL, which is why write and
-- delete permission rode along with read. Split into one policy per command so
-- each can express its own boundary:
--
--   SELECT  app.is_staff             — unchanged breadth. An HR manager still
--                                      needs to see the schedule to do their
--                                      own job; reading was never the problem.
--   INSERT  app.can_manage_scheduling
--   UPDATE  app.can_manage_scheduling
--   DELETE  no policy at all         — denied for every authenticated role,
--                                      belt and braces with the trigger above.
--
-- Checked before dropping anything: the only later policies on these tables
-- are SELECT (shifts_assigned_select 0002:235, shifts_offered_select 0008:19,
-- assignments_self_select 0002:249). Permissive policies are OR'd, so a
-- forgotten broad write policy would silently preserve the hole — there is
-- none. assignments_self_update (0002:252) is employee self-service and is
-- deliberately left in place.
-- ---------------------------------------------------------------------------
drop policy if exists shifts_staff on public.shifts;

create policy shifts_staff_select on public.shifts
  for select to authenticated
  using (app.is_staff(company_id));

create policy shifts_scheduling_insert on public.shifts
  for insert to authenticated
  with check (app.can_manage_scheduling(company_id));

create policy shifts_scheduling_update on public.shifts
  for update to authenticated
  using (app.can_manage_scheduling(company_id))
  with check (app.can_manage_scheduling(company_id));

drop policy if exists assignments_staff on public.shift_assignments;

create policy assignments_staff_select on public.shift_assignments
  for select to authenticated
  using (app.is_staff(company_id));

create policy assignments_scheduling_insert on public.shift_assignments
  for insert to authenticated
  with check (app.can_manage_scheduling(company_id));

create policy assignments_scheduling_update on public.shift_assignments
  for update to authenticated
  using (app.can_manage_scheduling(company_id))
  with check (app.can_manage_scheduling(company_id));

comment on policy shifts_staff_select on public.shifts is
  'Reading the schedule stays open to all staff, including HR. Only writing is '
  'restricted to the scheduling roles.';

-- ---------------------------------------------------------------------------
-- 3 · Legacy RPC authorization
--
-- The table boundary above already stops an HR manager from reaching these
-- outcomes by writing directly. These three functions should also say the
-- boundary themselves rather than inheriting a helper that means something
-- wider — an RPC that expresses a permission ought to express the right one,
-- and the refusal a caller gets should be 'forbidden' rather than an RLS error
-- from deep inside a transaction.
--
-- The bodies below are byte-identical to 0007, 0009 and 0010 apart from the
-- single authorization line in each. They are reproduced in full because
-- CREATE OR REPLACE cannot patch one statement.
-- ---------------------------------------------------------------------------
create or replace function public.approve_shift_offer(p_response_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_response public.shift_offer_responses%rowtype;
  v_offer public.shift_offers%rowtype;
  v_shift public.shifts%rowtype;
  v_employment_status public.employment_status;
  v_occupied integer;
  v_assignment_id uuid;
  v_filled boolean := false;
begin
  -- RLS scopes this read, so a response outside the caller's tenant simply
  -- does not resolve.
  select * into v_response
  from public.shift_offer_responses
  where id = p_response_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Explicit authorization rather than relying on the UI or on an RLS error:
  -- an employee reaching this function gets a clean refusal.
  if not app.can_manage_scheduling(v_response.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if v_response.decided_at is not null then
    return jsonb_build_object(
      'status', 'already_decided',
      'assignment_id', v_response.resulting_assignment_id
    );
  end if;

  if v_response.response <> 'interested' then
    return jsonb_build_object('status', 'not_interested');
  end if;

  select * into v_offer from public.shift_offers where id = v_response.offer_id;
  if not found or v_offer.status <> 'open' then
    return jsonb_build_object('status', 'offer_closed');
  end if;

  -- The lock. Everything after this point is serialized per shift, so two
  -- managers approving different candidates for one seat cannot both win.
  select * into v_shift
  from public.shifts
  where id = v_offer.shift_id
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_shift.status not in ('open', 'staffed') then
    return jsonb_build_object('status', 'shift_not_open');
  end if;
  if v_shift.start_time <= now() then
    return jsonb_build_object('status', 'shift_in_past');
  end if;

  select employment_status into v_employment_status
  from public.employees
  where id = v_response.employee_id;
  if v_employment_status is null or v_employment_status not in ('active', 'probation') then
    return jsonb_build_object('status', 'employee_inactive');
  end if;

  if exists (
    select 1 from public.shift_assignments
    where shift_id = v_shift.id
      and employee_id = v_response.employee_id
      and status in ('assigned', 'accepted', 'cancellation_requested')
  ) then
    return jsonb_build_object('status', 'already_assigned');
  end if;

  -- Overlap is re-checked here as well as in TypeScript: another approval in
  -- flight could have booked this employee elsewhere a moment ago.
  if exists (
    select 1
    from public.shift_assignments sa
    join public.shifts s on s.id = sa.shift_id
    where sa.employee_id = v_response.employee_id
      and sa.status in ('assigned', 'accepted', 'cancellation_requested')
      and s.start_time < v_shift.end_time
      and v_shift.start_time < s.end_time
  ) then
    return jsonb_build_object('status', 'overlapping_assignment');
  end if;

  select count(*) into v_occupied
  from public.shift_assignments
  where shift_id = v_shift.id
    and status in ('assigned', 'accepted', 'cancellation_requested');

  if v_occupied >= v_shift.required_count then
    return jsonb_build_object('status', 'no_vacancy');
  end if;

  insert into public.shift_assignments (company_id, shift_id, employee_id, status, assigned_by)
  values (v_response.company_id, v_shift.id, v_response.employee_id, 'assigned', auth.uid())
  returning id into v_assignment_id;

  update public.shift_offer_responses
  set decided_by = auth.uid(),
      decided_at = now(),
      resulting_assignment_id = v_assignment_id
  where id = v_response.id;

  -- The staffing trigger has already recalculated shifts.status by now.
  v_filled := (v_occupied + 1) >= v_shift.required_count;
  if v_filled then
    update public.shift_offers
    set status = 'filled', closed_at = now()
    where id = v_offer.id and status = 'open';
  end if;

  return jsonb_build_object(
    'status', 'approved',
    'assignment_id', v_assignment_id,
    'shift_filled', v_filled
  );
end $$;

create or replace function public.decide_cancellation_request(
  p_request_id uuid,
  p_approve boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.cancellation_requests%rowtype;
  v_assignment public.shift_assignments%rowtype;
  v_shift public.shifts%rowtype;
  v_restored public.assignment_status;
  v_occupied integer;
begin
  -- RLS scopes this read, so a request outside the caller's tenant simply does
  -- not resolve.
  select * into v_request
  from public.cancellation_requests
  where id = p_request_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Explicit authorization rather than a raw RLS error: an employee reaching
  -- this function gets a clean refusal.
  if not app.can_manage_scheduling(v_request.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select * into v_assignment
  from public.shift_assignments
  where id = v_request.shift_assignment_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The lock. Everything after this point is serialized per shift, so an
  -- approval here and an offer approval on the same shift cannot interleave
  -- and both believe a seat is free. Same helper and therefore the same lock
  -- order as the employee side.
  if app.lock_shift_of_assignment(v_assignment.id) is null then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select * into v_shift from public.shifts where id = v_assignment.shift_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Re-read both rows under the lock: a concurrent decision may have landed
  -- between the first read and here. This is what makes a manager's second
  -- click a refusal instead of a second decision.
  select * into v_request
  from public.cancellation_requests
  where id = p_request_id
  for update;

  select * into v_assignment
  from public.shift_assignments
  where id = v_request.shift_assignment_id
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_request.status <> 'pending' then
    return jsonb_build_object(
      'status', 'not_pending',
      'decision', v_request.status
    );
  end if;

  -- Nothing else moves an assignment out of 'cancellation_requested', so this
  -- is a should-not-happen guard rather than a routine path. It refuses
  -- without writing, so the request stays visible instead of vanishing.
  if v_assignment.status <> 'cancellation_requested' then
    return jsonb_build_object(
      'status', 'assignment_not_active',
      'assignment_status', v_assignment.status
    );
  end if;

  if p_approve then
    -- Freeing the seat is a single status change; the staffing trigger
    -- recalculates shifts.status and jobs.status from it, and the vacancy
    -- surfaces to the dispatcher through the existing planning list.
    update public.shift_assignments
    set status = 'cancelled'
    where id = v_assignment.id;

    update public.cancellation_requests
    set status = 'approved',
        decided_by = auth.uid(),
        decided_at = now()
    where id = v_request.id;
  else
    -- 'cancellation_requested' is a parking state, not history: the assignment
    -- returns to whatever it was. accepted_at is the only durable record of the
    -- employee having accepted.
    v_restored := case
      when v_assignment.accepted_at is not null then 'accepted'
      else 'assigned'
    end::public.assignment_status;

    update public.shift_assignments
    set status = v_restored
    where id = v_assignment.id;

    update public.cancellation_requests
    set status = 'rejected',
        decided_by = auth.uid(),
        decided_at = now()
    where id = v_request.id;
  end if;

  select count(*) into v_occupied
  from public.shift_assignments
  where shift_id = v_shift.id
    and status in ('assigned', 'accepted', 'cancellation_requested');

  return jsonb_build_object(
    'status', case when p_approve then 'approved' else 'rejected' end,
    'assignment_id', v_assignment.id,
    'shift_id', v_shift.id,
    'assignment_status', case when p_approve then 'cancelled' else v_restored end,
    'seats_open', greatest(v_shift.required_count - v_occupied, 0)
  );
end $$;

create or replace function public.remove_shift_assignment(
  p_assignment_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_assignment public.shift_assignments%rowtype;
  v_shift public.shifts%rowtype;
  v_previous public.assignment_status;
  v_request_id uuid;
  v_resolved_request boolean := false;
  v_occupied integer;
  v_shift_status public.shift_status;
begin
  -- A reason is not optional. It is the whole content of the audit record, and
  -- the only thing that explains the removal to anyone reading it later.
  if coalesce(btrim(p_reason), '') = '' then
    return jsonb_build_object('status', 'reason_required');
  end if;

  -- RLS scopes this read, so an assignment outside the caller's tenant simply
  -- does not resolve.
  select * into v_assignment
  from public.shift_assignments
  where id = p_assignment_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Explicit authorization rather than a raw RLS error. An employee reaching
  -- this function — including against their own assignment — gets a clean
  -- refusal: releasing yourself is Flow A, and it goes through a manager.
  if not app.can_manage_scheduling(v_assignment.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- Same lock, same order as request_shift_cancellation,
  -- decide_cancellation_request and approve_shift_offer: the shift row first.
  -- Reused rather than reinvented — its authorization admits staff, which is
  -- exactly who reaches this point.
  if app.lock_shift_of_assignment(p_assignment_id) is null then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select * into v_shift from public.shifts where id = v_assignment.shift_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Re-read under the lock: a concurrent removal or cancellation decision may
  -- have landed since the first read. This is what makes a second click a
  -- refusal rather than a second removal.
  select * into v_assignment
  from public.shift_assignments
  where id = p_assignment_id
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_previous := v_assignment.status;

  if v_previous = 'cancelled' then
    return jsonb_build_object('status', 'already_removed');
  end if;
  if v_previous = 'completed' then
    -- A worked shift is history. Correcting one is a different workflow and
    -- deliberately not reachable from here.
    return jsonb_build_object('status', 'completed');
  end if;
  if v_previous not in ('assigned', 'accepted', 'cancellation_requested') then
    return jsonb_build_object('status', 'not_active');
  end if;

  -- Past shifts are history too. In-progress shifts are NOT refused: "they
  -- never turned up, take them off and find someone" is the single most
  -- operationally useful moment for this function.
  if v_shift.end_time <= now() then
    return jsonb_build_object('status', 'shift_ended');
  end if;

  -- Any time entry at all means the employee was actually on this job. Removing
  -- them would leave worked time attached to a cancelled assignment and corrupt
  -- what the timesheet says happened.
  if exists (
    select 1 from public.time_entries
    where shift_assignment_id = v_assignment.id
  ) then
    return jsonb_build_object('status', 'already_clocked_in');
  end if;

  -- If the employee had already asked to be released, the manager is granting
  -- that request by removing them. Settling it here is the only way to avoid a
  -- request that stays pending forever against a cancelled assignment. The
  -- audit row still records this as a manager removal, so the two events stay
  -- distinguishable in history.
  select id into v_request_id
  from public.cancellation_requests
  where shift_assignment_id = v_assignment.id and status = 'pending'
  for update;

  if v_request_id is not null then
    update public.cancellation_requests
    set status = 'approved',
        decided_by = auth.uid(),
        decided_at = now()
    where id = v_request_id;
    v_resolved_request := true;
  end if;

  -- The seat is freed by this one status change; recalc_shift_staffing()
  -- recomputes shifts.status and jobs.status from it. Staffing is never
  -- written by hand here.
  update public.shift_assignments
  set status = 'cancelled'
  where id = v_assignment.id;

  -- Durable history, inside the transaction. Distinguishable by action from
  -- the Flow A entries written by the application
  -- ('cancellation_request.approved' / '.rejected').
  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_assignment.company_id,
    auth.uid(),
    'shift_assignment.removed_by_manager',
    'shift_assignments',
    v_assignment.id::text,
    jsonb_build_object(
      'reason', p_reason,
      'employee_id', v_assignment.employee_id,
      'shift_id', v_shift.id,
      'previous_status', v_previous,
      'resolved_cancellation_request', v_resolved_request,
      'cancellation_request_id', v_request_id
    )
  );

  select count(*) into v_occupied
  from public.shift_assignments
  where shift_id = v_shift.id
    and status in ('assigned', 'accepted', 'cancellation_requested');

  select status into v_shift_status from public.shifts where id = v_shift.id;

  return jsonb_build_object(
    'status', 'removed',
    'assignment_id', v_assignment.id,
    'employee_id', v_assignment.employee_id,
    'shift_id', v_shift.id,
    'previous_status', v_previous,
    'resolved_request', v_resolved_request,
    'seats_open', greatest(v_shift.required_count - v_occupied, 0),
    'shift_status', v_shift_status
  );
end $$;

comment on function public.approve_shift_offer(uuid) is
  'Atomically approve one shift-offer response. Locks the shift row so the '
  'final seat cannot be taken twice. Scheduling rules live in application '
  'code; only concurrency-sensitive checks are repeated here. '
  '(0012: authorization narrowed from app.is_staff to scheduling roles.)';

comment on function public.decide_cancellation_request(uuid, boolean) is
  'Atomically approve or reject one cancellation request. '
  '(0012: authorization narrowed from app.is_staff to scheduling roles.)';

comment on function public.remove_shift_assignment(uuid, text) is
  'Manager removes one employee from a shift. '
  '(0012: authorization narrowed from app.is_staff to scheduling roles.)';

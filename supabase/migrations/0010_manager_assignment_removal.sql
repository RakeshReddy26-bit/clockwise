-- Clockwise · Migration 0010 · Manager-initiated assignment removal (Phase C.1)
--
-- Additive only. 0001–0009 are untouched.
--
-- Two ways an assignment can end, and they are different business events:
--
--   FLOW A (Phase C)  the EMPLOYEE asks to be released, a manager decides.
--                     decide_cancellation_request() — request row is the record.
--   FLOW B (here)     the MANAGER removes the employee. No request exists and
--                     none is fabricated: inventing a cancellation_request would
--                     make the history say the employee asked, which is a lie.
--
-- The durable record for Flow B is an audit_logs row written INSIDE this
-- function, so it commits with the removal or not at all. Notifications stay in
-- the application layer, as everywhere else in this project — a lost
-- notification is recoverable, a lost audit entry is not.
--
-- No new columns: audit_logs.diff already carries reason, actor, employee,
-- shift and previous status as a durable jsonb record, and the assignment keeps
-- its history by moving to 'cancelled' rather than being deleted.

-- Truthful notification type. 'cancellation_approved' would imply the employee
-- requested it; 'assignment_removed' says what actually happened. Only added
-- here — the value is used at runtime by the application, never in this file,
-- so adding it alongside the function is safe.
alter type public.notification_type add value if not exists 'assignment_removed';

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
  if not app.is_staff(v_assignment.company_id) then
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

comment on function public.remove_shift_assignment(uuid, text) is
  'Manager removes one employee from a shift. Distinct from an employee-'
  'requested cancellation: no request is fabricated, and the durable record is '
  'an audit_logs row written in the same transaction. Refuses worked, '
  'completed, past and already-removed assignments rather than rewriting '
  'history. Frees exactly one seat; the staffing trigger reopens the shift and '
  'the existing offer workflow fills it.';

revoke all on function public.remove_shift_assignment(uuid, text) from public;
grant execute on function public.remove_shift_assignment(uuid, text) to authenticated, service_role;

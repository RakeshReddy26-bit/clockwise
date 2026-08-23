-- Clockwise · Migration 0009 · Cancellation decision (Phase C)
--
-- Additive only. Nothing in 0001–0008 is altered: the cancellation_requests
-- table, its policies and the assignment_status enum have been in place since
-- 0001, and recalc_shift_staffing() already treats 'cancellation_requested' as
-- occupying and 'cancelled' as free. This migration supplies the four things
-- the application layer needs on top of that.
--
-- 0. app.lock_shift_of_assignment(): the shared lock, see below.
--
-- 1. One open request per assignment, enforced by the database rather than by
--    a check-then-insert that a double click can race. Mirrors
--    shift_offers_one_open_per_shift from 0006.
--
-- 2. request_shift_cancellation(): the employee side. Recording the request and
--    parking the assignment are one change, not two — a request that exists
--    while the assignment still reads 'assigned' would be a lie on both
--    screens.
--
-- 3. decide_cancellation_request(): the approve/reject transaction.
--
-- SECURITY INVOKER, exactly like approve_shift_offer: the function runs as the
-- calling manager, every RLS policy still applies, and an employee reaching it
-- is refused by the explicit staff check. It is not a privilege escalation
-- path — it exists because "free the seat" and "record the decision" must
-- either both happen or neither, while nobody else is touching the shift.
--
-- Lock order is deliberately the same as approve_shift_offer's: the shift row
-- first, then narrower rows. Two functions that lock the same resources in the
-- same order cannot deadlock against each other.

-- ---------------------------------------------------------------------------
-- Lock helper
--
-- `select ... for update` applies the UPDATE policy as well as the SELECT one,
-- and an employee has no update policy on shifts — so an employee locking the
-- shift row directly sees no row at all. The lock is still wanted: the status
-- update below fires the staffing trigger, which touches that same row, and
-- taking it explicitly is what keeps request/decide/approve in one lock order.
--
-- security definer, therefore, but narrow: it takes an assignment id, refuses
-- anyone who is neither that assignment's employee nor staff of the company,
-- returns no data, and only ever acquires a row lock that the caller's own
-- transaction was about to acquire anyway.
-- ---------------------------------------------------------------------------
create or replace function app.lock_shift_of_assignment(p_assignment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shift_id uuid;
  v_company_id uuid;
  v_employee_id uuid;
begin
  select shift_id, company_id, employee_id
    into v_shift_id, v_company_id, v_employee_id
  from public.shift_assignments
  where id = p_assignment_id;
  if not found then
    return null;
  end if;

  if not (
    app.is_staff(v_company_id)
    or v_employee_id = app.current_employee_id(v_company_id)
  ) then
    return null;
  end if;

  perform 1 from public.shifts where id = v_shift_id for update;
  return v_shift_id;
end $$;

comment on function app.lock_shift_of_assignment(uuid) is
  'Take the shift row lock for one assignment, for callers who may read the '
  'shift but not update it. Refuses anyone outside that assignment.';

revoke all on function app.lock_shift_of_assignment(uuid) from public, anon;
grant execute on function app.lock_shift_of_assignment(uuid) to authenticated, service_role;

create unique index if not exists cancellation_requests_one_open_per_assignment
  on public.cancellation_requests (shift_assignment_id)
  where status = 'pending';

comment on index public.cancellation_requests_one_open_per_assignment is
  'At most one pending cancellation request per assignment. Makes a repeated '
  'submit a refusal rather than a second row.';

create or replace function public.request_shift_cancellation(
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
  v_request_id uuid;
begin
  -- RLS scopes this read to the caller's own assignments.
  select * into v_assignment
  from public.shift_assignments
  where id = p_assignment_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The employee, and only the employee, may ask to be released. A manager
  -- removing someone is a different act and is not modelled here.
  if v_assignment.employee_id is distinct from app.current_employee_id(v_assignment.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- Same lock order as decide_cancellation_request and approve_shift_offer:
  -- shift first. Through the helper, because an employee may read this shift
  -- but not update it, and a locking read applies the update policy too.
  if app.lock_shift_of_assignment(p_assignment_id) is null then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select * into v_shift from public.shifts where id = v_assignment.shift_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Asked first, because the first request parked the assignment: without
  -- this the second submit would be refused as 'not_cancellable', which is
  -- true but tells the employee the wrong story. The unique index below is
  -- still the authority — this is here to name the reason.
  if exists (
    select 1 from public.cancellation_requests
    where shift_assignment_id = p_assignment_id and status = 'pending'
  ) then
    return jsonb_build_object('status', 'already_requested');
  end if;

  -- Re-read under the lock. assignments_self_update only exposes 'assigned'
  -- and 'accepted' rows for locking, so a row that has already moved to
  -- cancellation_requested simply does not come back here — which is the same
  -- answer, arrived at from the other direction.
  select * into v_assignment
  from public.shift_assignments
  where id = p_assignment_id
  for update;
  if not found or v_assignment.status not in ('assigned', 'accepted') then
    return jsonb_build_object('status', 'not_cancellable');
  end if;

  if v_shift.end_time <= now() then
    return jsonb_build_object('status', 'shift_ended');
  end if;

  -- The reason is stored verbatim. Trimming, casing and length are the
  -- application's business; what reaches the manager is what was written.
  begin
    insert into public.cancellation_requests (company_id, shift_assignment_id, reason)
    values (v_assignment.company_id, v_assignment.id, p_reason)
    returning id into v_request_id;
  exception when unique_violation then
    -- cancellation_requests_one_open_per_assignment. A second submit is a
    -- refusal, never a second row.
    return jsonb_build_object('status', 'already_requested');
  end;

  -- The seat is NOT freed here: 'cancellation_requested' still occupies it, so
  -- nobody is left uncovered while a manager is still deciding.
  update public.shift_assignments
  set status = 'cancellation_requested'
  where id = v_assignment.id;

  return jsonb_build_object(
    'status', 'requested',
    'request_id', v_request_id,
    'shift_id', v_shift.id
  );
end $$;

comment on function public.request_shift_cancellation(uuid, text) is
  'Employee asks to be released from one of their own assignments. Records the '
  'request and parks the assignment in cancellation_requested in one '
  'transaction; the seat stays occupied until a manager approves.';

revoke all on function public.request_shift_cancellation(uuid, text) from public;
grant execute on function public.request_shift_cancellation(uuid, text) to authenticated, service_role;

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
  if not app.is_staff(v_request.company_id) then
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

comment on function public.decide_cancellation_request(uuid, boolean) is
  'Atomically approve or reject one cancellation request. Approval cancels the '
  'assignment so the staffing trigger reopens the shift; rejection restores the '
  'assignment to accepted or assigned. Locks the shift row, in the same order '
  'as approve_shift_offer, so the two cannot deadlock or race over a seat.';

-- anon has no business calling this; authenticated covers both managers and
-- employees, and the staff check inside the function separates them.
revoke all on function public.decide_cancellation_request(uuid, boolean) from public;
grant execute on function public.decide_cancellation_request(uuid, boolean) to authenticated, service_role;

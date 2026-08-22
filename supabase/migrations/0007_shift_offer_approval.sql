-- Clockwise · Migration 0007 · Atomic offer approval (Phase B4)
--
-- One function, one job: take the last seat safely. Everything a human would
-- call a scheduling rule — vacation, sick leave, qualifications, declared
-- availability, role matching — stays in src/lib/eligibility.ts and is
-- revalidated in TypeScript immediately before this is called. What lives here
-- is only what a concurrent transaction could invalidate between that check and
-- the insert, and therefore has to be decided while holding a lock.
--
-- SECURITY INVOKER: the function runs as the calling manager, so every RLS
-- policy still applies. It is not a privilege escalation path — an employee
-- calling it is refused by the explicit staff check below, and would in any
-- case be refused by the shift_assignments policies.
--
-- Decision model: there is no 'approved' response state. A decided response is
-- one with decided_at set; it was approved when resulting_assignment_id is also
-- set, and not selected when it is null. That keeps the employee-facing enum
-- describing what the employee said, never what the company decided.

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
  if not app.is_staff(v_response.company_id) then
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

comment on function public.approve_shift_offer(uuid) is
  'Atomically approve one shift-offer response. Locks the shift row so the '
  'final seat cannot be taken twice. Scheduling rules live in application '
  'code; only concurrency-sensitive checks are repeated here.';

-- anon has no business calling this; authenticated covers both managers and
-- employees, and the staff check inside the function separates them.
revoke all on function public.approve_shift_offer(uuid) from public;
grant execute on function public.approve_shift_offer(uuid) to authenticated, service_role;

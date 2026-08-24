-- Clockwise · Migration 0015 · Absence: vacation and sick leave (Phase E)
--
-- Additive only. 0001–0014 are untouched as files; this migration supersedes
-- two policies and one function by name.
--
-- The tables have existed since 0001 with complete RLS and have never had a
-- line of application code: the eligibility engine reads them (candidates.ts:
-- 148-162) and nothing writes them. Phase E makes them writable, which turns a
-- dormant asymmetry into a live one — see the lock note below.
--
-- ---------------------------------------------------------------------------
-- VACATION AND SICK LEAVE ARE NOT SYMMETRICAL
--
-- Vacation is a REQUEST: pending → approved | rejected | cancelled. It blocks
-- scheduling only once approved, and approving it while the employee still
-- holds a shift is REFUSED. A human releases them first through
-- remove_shift_assignment() (0010), which records a reason, notifies them and
-- reopens the vacancy — then the approval succeeds. Nobody is taken off a
-- shift as a side effect of an HR click.
--
-- Sickness is a FACT: reported → confirmed → closed. Reporting blocks
-- scheduling immediately and can NEVER be refused because a shift exists —
-- an employer does not decline an illness, and the enum has no state for it.
-- The conflict is surfaced to the manager, who decides whether to release the
-- person. Attendance deliberately keeps expecting them until someone does, so
-- the no-show alert remains the safety net.
--
-- ---------------------------------------------------------------------------
-- THE LOCK, AND WHY IT IS ON employees
--
-- Two directions have to hold at once:
--
--   A. approved vacation exists → a manager approves an offer
--   B. an assignment exists     → HR approves vacation
--
-- Checking each side is not enough. Under READ COMMITTED two concurrent
-- transactions each fail to see the other's uncommitted row and both commit,
-- and SELECT ... FOR UPDATE cannot lock a row that does not exist yet — so the
-- assignment INSERT in direction A has nothing for direction B to block on.
--
-- The only row both operations are certainly about is the EMPLOYEE. Both now
-- take it FOR UPDATE first, so they serialise and the second sees a committed
-- world.
--
-- Global lock order, established here:
--
--   employees → shifts → {cancellation_requests, shift_assignments} → narrower
--
-- Verified mechanically against every function in the catalogue before this was
-- written: no existing function locks employees at all, and every function that
-- touches more than one table already takes shifts first. decide_cancellation_
-- request and remove_shift_assignment differ in whether they reach
-- cancellation_requests or shift_assignments second, but both are gated behind
-- the same shift lock, so two transactions on one shift serialise there and
-- never interleave into the narrower rows. Adding employees above shifts
-- introduces no cycle.
--
-- ---------------------------------------------------------------------------
-- Not in scope: vacation balances and accrual (employees.vacation_days_total /
-- _used remain unreferenced), medical certificates (sick_leaves.document_id
-- keeps its FK from 0001:359 and stays unused), absence calendars, half-days,
-- public holidays.

-- The 'cancelled' status arrives in 0014, which must be applied first: an
-- enum value cannot be used in the transaction that adds it, and the employee
-- withdrawal policy below references it.

-- ---------------------------------------------------------------------------
-- Who may decide an absence.
--
-- Mirrors `absence.decide` in src/lib/permissions.ts:45 exactly. NOT
-- app.is_staff(), which also admits DISPATCHER — dispatch needs to SEE
-- absences to staff around them, and must not be able to grant them. This is
-- the mirror image of the HR/scheduling problem 0012 fixed.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- The employee lock helper.
--
-- `select ... for update` applies the UPDATE policy as well as the SELECT one,
-- and a DISPATCHER has no update policy on employees — so locking the row
-- directly returned nothing and every approval failed as 'employee_inactive'.
-- Same shape as app.lock_shift_of_assignment (0010), and the same reason.
--
-- security definer, but narrow: it takes an employee id, refuses anyone who is
-- neither staff of that company nor the employee themself, returns no data,
-- and only acquires a row lock.
-- ---------------------------------------------------------------------------
create or replace function app.lock_employee(p_employee_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from public.employees where id = p_employee_id;
  if not found then
    return null;
  end if;

  if not (
    app.is_staff(v_company_id)
    or p_employee_id = app.current_employee_id(v_company_id)
  ) then
    return null;
  end if;

  perform 1 from public.employees where id = p_employee_id for update;
  return v_company_id;
end $$;

comment on function app.lock_employee(uuid) is
  'Take the employee row lock — the outermost lock in the global order — for '
  'callers who may read the row but not update it. Refuses anyone outside the '
  'tenant.';

revoke all on function app.lock_employee(uuid) from public, anon;
grant execute on function app.lock_employee(uuid) to authenticated, service_role;

create or replace function app.can_decide_absence(cid uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select app.has_role(cid, array['SUPER_ADMIN','COMPANY_ADMIN','HR_MANAGER']::public.membership_role[])
$$;

comment on function app.can_decide_absence(uuid) is
  'True for the roles holding absence.decide. Deliberately excludes DISPATCHER, '
  'who reads absences but never decides them.';

revoke all on function app.can_decide_absence(uuid) from public, anon;
grant execute on function app.can_decide_absence(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Command-specific absence policies.
--
-- vacation_staff and sick_staff were FOR ALL using app.is_staff (0002:319,332),
-- which is why a dispatcher could approve holiday. SELECT keeps that breadth —
-- staffing decisions genuinely need it — and writes narrow to the decision
-- roles. The employee's own INSERT policies from 0002 are untouched; they
-- already pin status to 'pending' / 'reported'.
-- ---------------------------------------------------------------------------
drop policy if exists vacation_staff on public.vacation_requests;

create policy vacation_staff_select on public.vacation_requests
  for select to authenticated
  using (app.is_staff(company_id));

create policy vacation_decide_update on public.vacation_requests
  for update to authenticated
  using (app.can_decide_absence(company_id))
  with check (app.can_decide_absence(company_id));

create policy vacation_decide_insert on public.vacation_requests
  for insert to authenticated
  with check (app.can_decide_absence(company_id));

-- The employee's own withdrawal: only while nobody has decided, and only to
-- 'cancelled'. Never a DELETE — a withdrawn request is history like any other.
create policy vacation_self_withdraw on public.vacation_requests
  for update to authenticated
  using (
    employee_id = app.current_employee_id(company_id)
    and status = 'pending'
  )
  with check (
    employee_id = app.current_employee_id(company_id)
    and status = 'cancelled'
  );

drop policy if exists sick_staff on public.sick_leaves;

create policy sick_staff_select on public.sick_leaves
  for select to authenticated
  using (app.is_staff(company_id));

create policy sick_decide_update on public.sick_leaves
  for update to authenticated
  using (app.can_decide_absence(company_id))
  with check (app.can_decide_absence(company_id));

create policy sick_decide_insert on public.sick_leaves
  for insert to authenticated
  with check (app.can_decide_absence(company_id));

comment on policy vacation_staff_select on public.vacation_requests is
  'Reading absences stays open to all staff including dispatch, who must plan '
  'around them. Only deciding is restricted.';

-- No DELETE policy on either table, for anyone. An absence that happened is a
-- record; a request that was withdrawn says so in its status.

-- ---------------------------------------------------------------------------
-- One live vacation request per employee per period.
--
-- Probed before writing this: two overlapping pending requests were accepted.
-- Partial on the live statuses so a rejected or withdrawn request never blocks
-- asking again for the same days. daterange with '[]' matches the inclusive
-- semantics used everywhere else.
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist;

alter table public.vacation_requests
  drop constraint if exists vacation_requests_no_overlap;

alter table public.vacation_requests
  add constraint vacation_requests_no_overlap
  exclude using gist (
    employee_id with =,
    daterange(start_date, end_date, '[]') with &&
  )
  where (status in ('pending', 'approved'));

-- ---------------------------------------------------------------------------
-- An absence belongs to an employee of the SAME company.
--
-- Found by the Phase E test suite, not predicted by the design. Every write
-- policy on these tables — the old `for all using is_staff(company_id)` and the
-- narrower ones above alike — checks only the company_id written on the ROW.
-- Nothing checked that the employee named in it belongs to that company, and
-- there was no composite key to check against: company_id and employee_id were
-- two independent FKs.
--
-- Measured against HEAD before this was added: company B's admin could insert
-- a vacation_requests row carrying company_id = B and employee_id = one of
-- company A's employees, and it was accepted. It could then be approved by B's
-- own HR, since can_decide_absence() also only sees the row's company_id.
--
-- Company A never sees the row (RLS scopes their reads by company_id), so it
-- does not corrupt A's scheduling — but B holds and can decide an absence
-- record about a person who is not theirs, and that is a tenant boundary
-- failure however it is displayed.
--
-- Expressed as a composite foreign key rather than a trigger: it is declarative,
-- it cannot be bypassed by any future code path, and it makes the pair the key.
--
-- SCOPE NOTE: the same class of gap exists on other tenant tables whose rows
-- carry both a company_id and a child id (shift_assignments among them). Those
-- are NOT touched here — this migration closes it only on the two tables Phase E
-- makes writable. The sweep belongs in its own phase with its own proofs.
-- ---------------------------------------------------------------------------
alter table public.employees
  drop constraint if exists employees_id_company_key;
alter table public.employees
  add constraint employees_id_company_key unique (id, company_id);

alter table public.vacation_requests
  drop constraint if exists vacation_requests_employee_same_company;
alter table public.vacation_requests
  add constraint vacation_requests_employee_same_company
  foreign key (employee_id, company_id)
  references public.employees (id, company_id) on delete cascade;

alter table public.sick_leaves
  drop constraint if exists sick_leaves_employee_same_company;
alter table public.sick_leaves
  add constraint sick_leaves_employee_same_company
  foreign key (employee_id, company_id)
  references public.employees (id, company_id) on delete cascade;

-- ---------------------------------------------------------------------------
-- decide_vacation_request
--
-- Refuses rather than releasing anybody. If the employee still holds a shift
-- inside the requested period, the conflicting assignments are returned so HR
-- can see exactly what has to be resolved first, and NOTHING is written.
-- ---------------------------------------------------------------------------
create or replace function public.decide_vacation_request(
  p_request_id uuid,
  p_approve boolean,
  p_note text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.vacation_requests%rowtype;
  v_conflicts jsonb;
  v_count integer;
begin
  select * into v_request
  from public.vacation_requests
  where id = p_request_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.can_decide_absence(v_request.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- The outermost lock. approve_shift_offer() takes the same row first, so an
  -- offer approval for this person cannot slip in between the conflict check
  -- below and the commit.
  perform app.lock_employee(v_request.employee_id);

  -- Re-read under the lock: a concurrent decision may have landed.
  select * into v_request
  from public.vacation_requests
  where id = p_request_id
  for update;

  if v_request.status <> 'pending' then
    return jsonb_build_object('status', 'not_pending', 'current', v_request.status);
  end if;

  if p_approve then
    select coalesce(jsonb_agg(jsonb_build_object(
             'assignment_id', sa.id,
             'shift_id', s.id,
             'date', s.date,
             'status', sa.status)), '[]'::jsonb),
           count(*)
      into v_conflicts, v_count
    from public.shift_assignments sa
    join public.shifts s on s.id = sa.shift_id
    where sa.employee_id = v_request.employee_id
      and sa.status in ('assigned', 'accepted', 'cancellation_requested')
      and s.date between v_request.start_date and v_request.end_date;

    if v_count > 0 then
      -- Deliberately no partial mutation: the request stays pending and HR
      -- sees what to resolve. Releasing people automatically would attribute a
      -- dispatcher's decision to an HR click.
      return jsonb_build_object(
        'status', 'conflicting_assignments',
        'conflicts', v_conflicts,
        'count', v_count
      );
    end if;
  end if;

  update public.vacation_requests
  set status = case when p_approve then 'approved' else 'rejected' end::public.vacation_status,
      decided_by = auth.uid(),
      decided_at = now()
  where id = v_request.id;

  -- The employee's own note is left out of the audit diff on purpose: it may
  -- say why they need the time off, and the audit is read by the whole company.
  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_request.company_id, auth.uid(),
    case when p_approve then 'vacation.approved' else 'vacation.rejected' end,
    'vacation_requests', v_request.id::text,
    jsonb_build_object(
      'employee_id', v_request.employee_id,
      'start_date', v_request.start_date,
      'end_date', v_request.end_date,
      'days_count', v_request.days_count,
      'decision_note_present', coalesce(btrim(p_note), '') <> ''
    )
  );

  return jsonb_build_object(
    'status', case when p_approve then 'approved' else 'rejected' end,
    'request_id', v_request.id,
    'employee_id', v_request.employee_id
  );
end $$;

comment on function public.decide_vacation_request(uuid, boolean, text) is
  'Approve or reject one vacation request. Approval is refused while the '
  'employee still holds a shift in the period — the conflicting assignments '
  'are returned and nothing is written. Locks the employee row first, so it '
  'cannot race an offer approval for the same person.';

revoke all on function public.decide_vacation_request(uuid, boolean, text) from public;
grant execute on function public.decide_vacation_request(uuid, boolean, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- decide_sick_leave
--
-- reported → confirmed → closed. No rejection: the schema has no such state
-- and an employer does not decline an illness. Conflicts are reported back for
-- the manager to act on, never acted on here.
-- ---------------------------------------------------------------------------
create or replace function public.decide_sick_leave(
  p_sick_leave_id uuid,
  p_status text,
  p_end_date date default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sick public.sick_leaves%rowtype;
begin
  if p_status not in ('confirmed', 'closed') then
    return jsonb_build_object('status', 'not_a_transition');
  end if;

  select * into v_sick from public.sick_leaves where id = p_sick_leave_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.can_decide_absence(v_sick.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform app.lock_employee(v_sick.employee_id);

  select * into v_sick from public.sick_leaves where id = p_sick_leave_id for update;

  if v_sick.status = 'closed' then
    return jsonb_build_object('status', 'already_closed');
  end if;
  if p_status = 'confirmed' and v_sick.status <> 'reported' then
    return jsonb_build_object('status', 'not_a_transition');
  end if;

  update public.sick_leaves
  set status = p_status::public.sick_leave_status,
      expected_end_date = case
        when p_status = 'closed' then coalesce(p_end_date, expected_end_date, current_date)
        else expected_end_date
      end
  where id = v_sick.id;

  -- The employee's comment about their health never enters the audit trail.
  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_sick.company_id, auth.uid(),
    case when p_status = 'confirmed' then 'sick_leave.confirmed' else 'sick_leave.closed' end,
    'sick_leaves', v_sick.id::text,
    jsonb_build_object('employee_id', v_sick.employee_id, 'start_date', v_sick.start_date)
  );

  return jsonb_build_object('status', p_status, 'sick_leave_id', v_sick.id);
end $$;

comment on function public.decide_sick_leave(uuid, text, date) is
  'Confirm that a certificate arrived, or close a sick leave. Never refuses a '
  'reported illness and never releases an assignment.';

revoke all on function public.decide_sick_leave(uuid, text, date) from public;
grant execute on function public.decide_sick_leave(uuid, text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- approve_shift_offer, third revision
--
-- Body identical to 0012 apart from two changes, both marked inline: the
-- employee row is now locked FIRST (see the header), and approved vacation /
-- open sick leave are refused here as well as in TypeScript.
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

  -- 0015: the employee row is now the OUTERMOST lock in this transaction.
  -- decide_vacation_request() takes the same lock first, so approving an offer
  -- and approving holiday for the same person serialise here. Without it both
  -- transactions read a world without the other and both commit, leaving
  -- someone on approved leave and rostered at the same time.
  --
  -- Global order, established in 0015 and unchanged elsewhere:
  --   employees → shifts → {cancellation_requests, shift_assignments} → narrower
  -- Verified before this was written: no other function locks employees at all.
  if app.lock_employee(v_response.employee_id) is null then
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

  -- Unmoved by 0015. Only the LOCK had to become outermost; leaving this check
  -- where it was keeps the order of refusals identical to 0012, so an inactive
  -- employee whose response was already decided still reports 'already_decided'.
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

  -- 0015: absence, checked here rather than only in TypeScript.
  --
  -- The eligibility engine already refuses these candidates, and this repeats
  -- only what a concurrent transaction could invalidate between that check and
  -- this insert — the same rule the rest of this function follows. Approved
  -- vacation is a hard block; a pending request deliberately is NOT, or an
  -- employee could make themselves unschedulable before anyone decided.
  if exists (
    select 1 from public.vacation_requests v
    where v.employee_id = v_response.employee_id
      and v.status = 'approved'
      and v_shift.date between v.start_date and v.end_date
  ) then
    return jsonb_build_object('status', 'on_vacation');
  end if;

  -- 'reported' blocks as hard as 'confirmed': confirmation records that a
  -- certificate arrived, it is not what makes someone unwell.
  if exists (
    select 1 from public.sick_leaves s
    where s.employee_id = v_response.employee_id
      and s.status in ('reported', 'confirmed')
      and v_shift.date >= s.start_date
      and (s.expected_end_date is null or v_shift.date <= s.expected_end_date)
  ) then
    return jsonb_build_object('status', 'on_sick_leave');
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
  'Atomically approve one shift-offer response. Locks the employee row, then '
  'the shift. Refuses an employee on approved vacation or open sick leave. '
  '(0012: authorization narrowed. 0015: employee lock + absence checks.)';

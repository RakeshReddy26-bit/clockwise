-- Clockwise · Migration 0017 · Account invitation + access lifecycle (Phase G)
--
-- Additive only. 0001–0016 are untouched as files; this migration redefines two
-- functions by name and adds one trigger and three RPCs.
--
-- ---------------------------------------------------------------------------
-- 1 · SUSPENSION MUST ACTUALLY SUSPEND
--
-- Measured against HEAD before this was written. With worker A's membership set
-- to 'suspended' and committed, the same session still:
--
--   1 row   select own employees row       1 row   select own profile
--   1 row   select shifts                  1 row   select notifications
--   1 row   UPDATE own phone               1 row   INSERT own availability
--   1 row   INSERT own vacation request    1 row   INSERT own time entry
--
-- A suspended employee could still CLOCK IN. 40 of 96 policies are self-scoped
-- and never consult membership status; 29 of those reach the employee through
-- app.current_employee_id(), which resolved the row without asking whether the
-- membership was still active.
--
-- One clause closes all 29. The 11 that remain are profile-scoped and benign:
-- own profiles row, own notifications, own conversations/messages, own
-- applications, and employees_self_update — which 0016 already limits to the
-- phone number. Those are deliberately left alone; revoking someone's ability
-- to read their own name is not what suspension means.
--
-- Access is denied on the next request. It is NOT a logout: an already-issued
-- JWT stays valid until it expires, and Phase G does not force session
-- revocation. What changes is that the token no longer reaches any of the data.
-- ---------------------------------------------------------------------------
create or replace function app.current_employee_id(cid uuid)
returns uuid language sql stable security definer
set search_path = ''
as $$
  select e.id from public.employees e
  where e.company_id = cid
    and e.profile_id = auth.uid()
    and app.is_member(cid)
  limit 1
$$;

comment on function app.current_employee_id(uuid) is
  'The caller''s employee row in one company — and only while their membership '
  'is active. The membership check is what makes suspension real: without it, '
  'the 29 self-scoped policies that resolve through this function stayed open '
  'to a suspended session, clock-in included.';

-- ---------------------------------------------------------------------------
-- 2 · profile_id becomes genuinely system-owned
--
-- 0016 classified profile_id as system-owned in TypeScript and
-- filterEditableFields() drops it from every HR patch — but that was
-- application-only. Measured against HEAD: HR linked the dispatcher's profile,
-- then the admin's profile, to a colleague's employee record, and re-linked an
-- already-linked employee to a different profile. employees_hr_update covers
-- the whole row and the field-ownership trigger exempts HR.
--
-- That is the account-takeover surface: whoever controls profile_id decides
-- whose time entries, absences and emergency contact a session can reach.
--
-- The rule: profile_id may go from NULL to a value exactly once, and only from
-- inside invite_employee(), which sets a session flag first. Nobody — HR,
-- COMPANY_ADMIN, the employee, a direct SQL session — may relink or unlink.
-- Unlinking is not needed by any workflow: someone who leaves is terminated,
-- and their history stays attached to the account that made it.
-- ---------------------------------------------------------------------------
create or replace function public.guard_employee_profile_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.profile_id is not distinct from new.profile_id then
    return new;
  end if;

  if old.profile_id is null
     and new.profile_id is not null
     and coalesce(current_setting('app.linking_account', true), 'off') = 'on' then
    return new;
  end if;

  raise exception 'employees.profile_id is set by the invitation flow and never changed'
    using errcode = 'check_violation',
          hint = 'Invite the employee to create the link. An account is never '
                 'moved between employment records.';
end $$;

comment on function public.guard_employee_profile_immutable() is
  'profile_id is write-once, and only invite_employee() may write it. Closes '
  'the relink path measured on HEAD, where HR could point any employment '
  'record at any colleague''s account.';

-- Sorts after guard_employee_field_ownership and before
-- guard_employee_profile_link, so the employee still hears "you may only change
-- your own phone number" rather than a message about accounts.
drop trigger if exists guard_employee_profile_immutable on public.employees;
create trigger guard_employee_profile_immutable
  before update on public.employees
  for each row execute function public.guard_employee_profile_immutable();

-- ---------------------------------------------------------------------------
-- 3 · invite_employee
--
-- The DB half of the invitation. The auth user and the profiles row already
-- exist by the time this runs: the Server Action called
-- auth.admin.inviteUserByEmail() first, which created the identity and fired
-- handle_new_user() (0003).
--
-- Two external systems cannot share a transaction, so the split is deliberate:
-- Auth is called first and this function is atomic. If Auth succeeds and this
-- fails, nothing is half-linked — see the orphan note in the action.
--
-- Linking immediately is safe HERE and only here. inviteUserByEmail CREATES the
-- user; a success means nobody has ever controlled that address in this
-- project, no password is set, and only the invited mailbox can complete it. An
-- address that already existed makes the Auth call fail, so this function is
-- never reached for it — Phase G refuses existing accounts rather than
-- attaching them, because email equality is not authorization.
--
-- Role is the literal 'EMPLOYEE'. It is never read from input, from invite
-- metadata, or from raw_user_meta_data, so no invite path can mint privilege.
-- Elevating anyone stays a COMPANY_ADMIN act on company_memberships.
-- ---------------------------------------------------------------------------
create or replace function public.invite_employee(
  p_employee_id uuid,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees%rowtype;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- security definer sees every row, so the tenant check RLS used to provide
  -- has to be explicit. A foreign caller gets 'not_found', not 'forbidden':
  -- confirming that an employee id exists is itself a small leak.
  if not app.is_member(v_employee.company_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.is_hr(v_employee.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- Outermost lock in the global order, so two managers inviting the same
  -- person serialise and the second sees a linked row rather than a stale one.
  perform app.lock_employee(p_employee_id);

  select * into v_employee from public.employees where id = p_employee_id for update;

  if v_employee.profile_id is not null then
    return jsonb_build_object('status', 'already_linked');
  end if;

  if p_profile_id is null or not exists (
    select 1 from public.profiles where id = p_profile_id
  ) then
    return jsonb_build_object('status', 'profile_missing');
  end if;

  -- The invited identity must not already be somebody in this company.
  if exists (
    select 1 from public.employees
    where company_id = v_employee.company_id and profile_id = p_profile_id
  ) then
    return jsonb_build_object('status', 'profile_in_use');
  end if;

  insert into public.company_memberships (profile_id, company_id, role, status)
  values (p_profile_id, v_employee.company_id, 'EMPLOYEE', 'invited')
  on conflict (profile_id, company_id) do nothing;

  set local app.linking_account = 'on';
  update public.employees set profile_id = p_profile_id where id = p_employee_id;
  set local app.linking_account = 'off';

  -- No email address, no token, no link. audit_logs is readable by every
  -- company admin, and the employee id already identifies the person to anyone
  -- entitled to know.
  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_employee.company_id, auth.uid(), 'employee.invited', 'employees',
    p_employee_id::text,
    jsonb_build_object('profile_id', p_profile_id, 'had_existing_account', false)
  );

  return jsonb_build_object('status', 'invited', 'profile_id', p_profile_id);
end $$;

comment on function public.invite_employee(uuid, uuid) is
  'Links a freshly created account to an employment record and gives it an '
  'invited membership. security definer because HR cannot write '
  'company_memberships; the role written is always the literal EMPLOYEE.';

revoke all on function public.invite_employee(uuid, uuid) from public, anon;
grant execute on function public.invite_employee(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4 · activate_my_membership
--
-- Called once by the invited person themselves, from /welcome, after Supabase
-- has established their session. They cannot write company_memberships
-- directly — memberships_admin is COMPANY_ADMIN only — so this is the whole of
-- what an invitee is allowed to do to their own access.
--
-- 'invited' → 'active' and nothing else. A suspended membership is NOT
-- reactivated by it, so somebody terminated between invitation and acceptance
-- cannot let themselves in. Refreshing /welcome is a no-op rather than a
-- duplicate, because this is a guarded single-row UPDATE and never an INSERT.
-- ---------------------------------------------------------------------------
create or replace function public.activate_my_membership()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership public.company_memberships%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('status', 'unauthenticated');
  end if;

  select * into v_membership
  from public.company_memberships
  where profile_id = auth.uid() and status = 'invited'
  order by created_at
  limit 1
  for update;

  if not found then
    return jsonb_build_object('status', 'nothing_to_activate');
  end if;

  update public.company_memberships
  set status = 'active'
  where id = v_membership.id;

  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_membership.company_id, auth.uid(), 'employee.account_linked',
    'company_memberships', v_membership.id::text,
    jsonb_build_object('from', 'invited', 'to', 'active')
  );

  return jsonb_build_object('status', 'activated', 'company_id', v_membership.company_id);
end $$;

comment on function public.activate_my_membership() is
  'The invited person activates their own membership, once. Never touches a '
  'suspended row, so a termination between invite and acceptance still holds.';

revoke all on function public.activate_my_membership() from public, anon;
grant execute on function public.activate_my_membership() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5 · set_membership_access
--
-- Manual suspend / reactivate, COMPANY_ADMIN only. Deliberately NOT is_hr():
-- taking someone's access away is a security act, not an HR one, and HR already
-- reaches the same outcome through termination below. Keeping the manual switch
-- narrower means an HR account compromise cannot lock the company out.
-- ---------------------------------------------------------------------------
create or replace function public.set_membership_access(
  p_employee_id uuid,
  p_suspend boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees%rowtype;
  v_membership public.company_memberships%rowtype;
  -- Computed up front: a CASE expression inside an IF condition confuses the
  -- PL/pgSQL statement parser, because its THEN closes the IF.
  v_target public.membership_status :=
    (case when p_suspend then 'suspended' else 'active' end)::public.membership_status;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- security definer sees every row, so the tenant check RLS used to provide
  -- has to be explicit. A foreign caller gets 'not_found', not 'forbidden':
  -- confirming that an employee id exists is itself a small leak.
  if not app.is_member(v_employee.company_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.has_role(
    v_employee.company_id,
    array['SUPER_ADMIN','COMPANY_ADMIN']::public.membership_role[]
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if v_employee.profile_id is null then
    return jsonb_build_object('status', 'no_account');
  end if;

  perform app.lock_employee(p_employee_id);

  select * into v_membership
  from public.company_memberships
  where profile_id = v_employee.profile_id and company_id = v_employee.company_id
  for update;
  if not found then
    return jsonb_build_object('status', 'no_account');
  end if;

  -- An invitation that was never accepted is not reactivated into 'active' by
  -- an admin click; that would skip the acceptance that proves mailbox control.
  if not p_suspend and v_membership.status = 'invited' then
    return jsonb_build_object('status', 'still_invited');
  end if;

  if v_membership.status = v_target then
    return jsonb_build_object('status', 'unchanged', 'current', v_membership.status);
  end if;

  update public.company_memberships
  set status = v_target
  where id = v_membership.id;

  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_employee.company_id, auth.uid(),
    (case when p_suspend then 'employee.access_suspended' else 'employee.access_reactivated' end),
    'employees', p_employee_id::text,
    jsonb_build_object('reason', 'manual', 'from', v_membership.status)
  );

  return jsonb_build_object(
    'status', (case when p_suspend then 'suspended' else 'reactivated' end)
  );
end $$;

comment on function public.set_membership_access(uuid, boolean) is
  'Manual access suspend/reactivate. COMPANY_ADMIN only — HR reaches the same '
  'outcome through termination, and a security switch should not ride along '
  'with routine people administration.';

revoke all on function public.set_membership_access(uuid, boolean) from public, anon;
grant execute on function public.set_membership_access(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6 · set_employment_status, revised
--
-- Body identical to 0016 apart from one addition, marked inline: after the
-- status update and before the audit write, the linked membership follows.
--
--   terminated               → membership suspended
--   terminated → schedulable → membership reactivated, but ONLY if this
--                              mechanism suspended it. A membership an admin
--                              suspended deliberately is not reopened by an HR
--                              status correction.
--   on_leave, probation      → access untouched. Someone on leave still needs
--                              their roster, their documents and their messages.
--
-- Lock-order audit performed before writing this, the same mechanical scan as
-- Phase E and F: NO function anywhere locks company_memberships. The global
-- order therefore gains a level below employees and no cycle is introduced:
--
--   employees → company_memberships → shifts
--             → {cancellation_requests, shift_assignments} → narrower
--
-- The employee row is already locked above, so the membership is only ever
-- reached behind it.
--
-- Auth users are never deleted. History stays attached to the account that
-- made it, and profile_id is untouched by any status change.
-- ---------------------------------------------------------------------------
create or replace function public.set_employment_status(
  p_employee_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees%rowtype;
  v_previous public.employment_status;
  v_conflicts jsonb;
  v_count integer;
  v_access text := 'unchanged';
begin
  if p_status not in ('active', 'probation', 'on_leave', 'terminated') then
    return jsonb_build_object('status', 'invalid_status');
  end if;

  select * into v_employee from public.employees where id = p_employee_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- security definer sees every row, so the tenant check RLS used to provide
  -- has to be explicit. A foreign caller gets 'not_found', not 'forbidden':
  -- confirming that an employee id exists is itself a small leak.
  if not app.is_member(v_employee.company_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not app.is_hr(v_employee.company_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform app.lock_employee(p_employee_id);

  select * into v_employee from public.employees where id = p_employee_id for update;
  v_previous := v_employee.employment_status;

  if v_previous::text = p_status then
    return jsonb_build_object('status', 'unchanged', 'current', p_status);
  end if;

  update public.employees
  set employment_status = p_status::public.employment_status
  where id = p_employee_id;

  -- 0017: access follows employment. security definer, because HR holds no
  -- write permission on company_memberships and deliberately still does not —
  -- the only membership change they can cause is this one, on this employee,
  -- between these two statuses.
  if v_employee.profile_id is not null then
    if p_status = 'terminated' then
      -- 'invited' as well as 'active'. Found by the Phase G test suite, not
      -- predicted: suspending only active memberships left a terminated person
      -- able to accept a stale invitation, because activate_my_membership()
      -- moves 'invited' → 'active' and would have seen an untouched row. A
      -- reactivated membership that was never accepted is inert on its own —
      -- the person still has no password — but the state was wrong.
      update public.company_memberships
      set status = 'suspended'
      where profile_id = v_employee.profile_id
        and company_id = v_employee.company_id
        and status in ('active', 'invited');
      if found then v_access := 'suspended'; end if;
    elsif p_status in ('active', 'probation') and v_previous = 'terminated' then
      update public.company_memberships
      set status = 'active'
      where profile_id = v_employee.profile_id
        and company_id = v_employee.company_id
        and status = 'suspended';
      if found then v_access := 'reactivated'; end if;
    end if;
  end if;

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

  insert into public.audit_logs (company_id, actor_profile_id, action, entity, entity_id, diff)
  values (
    v_employee.company_id, auth.uid(),
    'employee.status_changed', 'employees', p_employee_id::text,
    jsonb_build_object(
      'from', v_previous,
      'to', p_status,
      'future_assignments', v_count,
      'access', v_access
    )
  );

  return jsonb_build_object(
    'status', 'changed',
    'from', v_previous,
    'to', p_status,
    'access', v_access,
    'conflicts', v_conflicts,
    'count', v_count
  );
end $$;

comment on function public.set_employment_status(uuid, text) is
  'Change one employee''s employment status. Always commits and returns the '
  'FUTURE assignments that now conflict; never cancels one. (0017: access '
  'follows employment — terminated suspends, and reactivation reopens only a '
  'membership this mechanism suspended.)';

revoke all on function public.set_employment_status(uuid, text) from public;
grant execute on function public.set_employment_status(uuid, text) to authenticated, service_role;

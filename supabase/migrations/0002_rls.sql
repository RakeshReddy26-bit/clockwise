-- Clockwise · Migration 0002 · RLS
-- Helper functions (schema app) + row-level security on every table.
-- RLS is the final isolation layer; Server Actions validate the full chain
-- (auth → membership → role → resource tenant) before any write.

create schema if not exists app;
grant usage on schema app to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Helpers · security definer, empty search_path, fully qualified names
-- ---------------------------------------------------------------------------
create or replace function app.current_profile_id()
returns uuid language sql stable
set search_path = ''
as $$ select auth.uid() $$;

create or replace function app.is_member(cid uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.company_memberships m
    where m.company_id = cid
      and m.profile_id = auth.uid()
      and m.status = 'active'
  )
$$;

create or replace function app.has_role(cid uuid, roles public.membership_role[])
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.company_memberships m
    where m.company_id = cid
      and m.profile_id = auth.uid()
      and m.status = 'active'
      and m.role = any (roles)
  )
$$;

-- COMPANY_ADMIN, HR_MANAGER, DISPATCHER
create or replace function app.is_staff(cid uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select app.has_role(cid, array['COMPANY_ADMIN','HR_MANAGER','DISPATCHER']::public.membership_role[])
$$;

-- COMPANY_ADMIN, HR_MANAGER (people & document data)
create or replace function app.is_hr(cid uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select app.has_role(cid, array['COMPANY_ADMIN','HR_MANAGER']::public.membership_role[])
$$;

create or replace function app.current_employee_id(cid uuid)
returns uuid language sql stable security definer
set search_path = ''
as $$
  select e.id from public.employees e
  where e.company_id = cid and e.profile_id = auth.uid()
  limit 1
$$;

create or replace function app.is_participant(conv uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_participants p
    where p.conversation_id = conv and p.profile_id = auth.uid()
  )
$$;

revoke execute on function
  app.is_member(uuid), app.has_role(uuid, public.membership_role[]),
  app.is_staff(uuid), app.is_hr(uuid), app.current_employee_id(uuid),
  app.is_participant(uuid), app.current_profile_id()
from anon;

-- ---------------------------------------------------------------------------
-- Grants (mirror Supabase defaults; RLS does the restricting)
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, anon, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
create policy companies_select on public.companies
  for select to authenticated using (app.is_member(id));
create policy companies_update on public.companies
  for update to authenticated
  using (app.has_role(id, array['COMPANY_ADMIN']::public.membership_role[]))
  with check (app.has_role(id, array['COMPANY_ADMIN']::public.membership_role[]));
-- insert/delete: service role only (tenant provisioning)

-- ---------------------------------------------------------------------------
-- locations / departments
-- ---------------------------------------------------------------------------
create policy locations_select on public.locations
  for select to authenticated using (app.is_member(company_id));
create policy locations_write on public.locations
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));

create policy departments_select on public.departments
  for select to authenticated using (app.is_member(company_id));
create policy departments_write on public.departments
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));

-- ---------------------------------------------------------------------------
-- profiles · own row, or someone sharing an active company
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.company_memberships mine
      join public.company_memberships theirs
        on mine.company_id = theirs.company_id
      where mine.profile_id = auth.uid() and mine.status = 'active'
        and theirs.profile_id = public.profiles.id and theirs.status = 'active'
    )
  );
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_insert on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- company_memberships · own rows; admins manage company rows
-- ---------------------------------------------------------------------------
create policy memberships_select on public.company_memberships
  for select to authenticated
  using (profile_id = auth.uid() or app.is_staff(company_id));
create policy memberships_admin on public.company_memberships
  for all to authenticated
  using (app.has_role(company_id, array['COMPANY_ADMIN']::public.membership_role[]))
  with check (app.has_role(company_id, array['COMPANY_ADMIN']::public.membership_role[]));

-- ---------------------------------------------------------------------------
-- employees
-- ---------------------------------------------------------------------------
create policy employees_select on public.employees
  for select to authenticated
  using (app.is_staff(company_id) or profile_id = auth.uid());
create policy employees_write on public.employees
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));
create policy employees_self_update on public.employees
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid() and company_id = company_id);

-- ---------------------------------------------------------------------------
-- emergency_contacts · HR everything, employee manages own
-- ---------------------------------------------------------------------------
create policy emergency_hr on public.emergency_contacts
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));
create policy emergency_self on public.emergency_contacts
  for all to authenticated
  using (employee_id = app.current_employee_id(company_id))
  with check (employee_id = app.current_employee_id(company_id));

-- ---------------------------------------------------------------------------
-- employee_availability · staff everything, employee manages own
-- ---------------------------------------------------------------------------
create policy availability_staff on public.employee_availability
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy availability_self on public.employee_availability
  for all to authenticated
  using (employee_id = app.current_employee_id(company_id))
  with check (employee_id = app.current_employee_id(company_id));

-- ---------------------------------------------------------------------------
-- employee_qualifications · HR writes, staff + owner read
-- ---------------------------------------------------------------------------
create policy qualifications_select on public.employee_qualifications
  for select to authenticated
  using (app.is_staff(company_id) or employee_id = app.current_employee_id(company_id));
create policy qualifications_write on public.employee_qualifications
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));

-- ---------------------------------------------------------------------------
-- audit_logs · admins read, members append
-- ---------------------------------------------------------------------------
create policy audit_select on public.audit_logs
  for select to authenticated
  using (app.has_role(company_id, array['COMPANY_ADMIN']::public.membership_role[]));
create policy audit_insert on public.audit_logs
  for insert to authenticated with check (app.is_member(company_id));

-- ---------------------------------------------------------------------------
-- jobs / shifts · staff manage; employees see what they're assigned to
-- ---------------------------------------------------------------------------
create policy jobs_staff on public.jobs
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy jobs_assigned_select on public.jobs
  for select to authenticated
  using (exists (
    select 1 from public.shifts s
    join public.shift_assignments sa on sa.shift_id = s.id
    where s.job_id = public.jobs.id
      and sa.employee_id = app.current_employee_id(public.jobs.company_id)
  ));

create policy shifts_staff on public.shifts
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy shifts_assigned_select on public.shifts
  for select to authenticated
  using (exists (
    select 1 from public.shift_assignments sa
    where sa.shift_id = public.shifts.id
      and sa.employee_id = app.current_employee_id(public.shifts.company_id)
  ));

-- ---------------------------------------------------------------------------
-- shift_assignments · staff manage; employee reads own, accept / request only
-- ---------------------------------------------------------------------------
create policy assignments_staff on public.shift_assignments
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy assignments_self_select on public.shift_assignments
  for select to authenticated
  using (employee_id = app.current_employee_id(company_id));
create policy assignments_self_update on public.shift_assignments
  for update to authenticated
  using (
    employee_id = app.current_employee_id(company_id)
    and status in ('assigned','accepted')
  )
  with check (
    employee_id = app.current_employee_id(company_id)
    and status in ('accepted','cancellation_requested')
  );

-- ---------------------------------------------------------------------------
-- cancellation_requests · employee files own; staff decides
-- ---------------------------------------------------------------------------
create policy cancellations_staff on public.cancellation_requests
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy cancellations_self_select on public.cancellation_requests
  for select to authenticated
  using (exists (
    select 1 from public.shift_assignments sa
    where sa.id = shift_assignment_id
      and sa.employee_id = app.current_employee_id(public.cancellation_requests.company_id)
  ));
create policy cancellations_self_insert on public.cancellation_requests
  for insert to authenticated
  with check (
    status = 'pending' and decided_by is null
    and exists (
      select 1 from public.shift_assignments sa
      where sa.id = shift_assignment_id
        and sa.company_id = public.cancellation_requests.company_id
        and sa.employee_id = app.current_employee_id(public.cancellation_requests.company_id)
    )
  );

-- ---------------------------------------------------------------------------
-- time_entries / time_breaks · employee manages own, staff everything
-- ---------------------------------------------------------------------------
create policy time_entries_staff on public.time_entries
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy time_entries_self on public.time_entries
  for all to authenticated
  using (employee_id = app.current_employee_id(company_id))
  with check (employee_id = app.current_employee_id(company_id));

create policy time_breaks_staff on public.time_breaks
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy time_breaks_self on public.time_breaks
  for all to authenticated
  using (exists (
    select 1 from public.time_entries te
    where te.id = time_entry_id
      and te.employee_id = app.current_employee_id(public.time_breaks.company_id)
  ))
  with check (exists (
    select 1 from public.time_entries te
    where te.id = time_entry_id
      and te.company_id = public.time_breaks.company_id
      and te.employee_id = app.current_employee_id(public.time_breaks.company_id)
  ));

-- ---------------------------------------------------------------------------
-- vacation_requests / sick_leaves
-- ---------------------------------------------------------------------------
create policy vacation_staff on public.vacation_requests
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy vacation_self_select on public.vacation_requests
  for select to authenticated
  using (employee_id = app.current_employee_id(company_id));
create policy vacation_self_insert on public.vacation_requests
  for insert to authenticated
  with check (
    employee_id = app.current_employee_id(company_id)
    and status = 'pending' and decided_by is null
  );

create policy sick_staff on public.sick_leaves
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));
create policy sick_self_select on public.sick_leaves
  for select to authenticated
  using (employee_id = app.current_employee_id(company_id));
create policy sick_self_insert on public.sick_leaves
  for insert to authenticated
  with check (
    employee_id = app.current_employee_id(company_id)
    and status = 'reported'
  );

-- ---------------------------------------------------------------------------
-- calendar_events · members read, staff manage
-- ---------------------------------------------------------------------------
create policy calendar_select on public.calendar_events
  for select to authenticated using (app.is_member(company_id));
create policy calendar_write on public.calendar_events
  for all to authenticated
  using (app.is_staff(company_id)) with check (app.is_staff(company_id));

-- ---------------------------------------------------------------------------
-- recruitment · HR manages; applicants see own application
-- ---------------------------------------------------------------------------
create policy postings_hr on public.job_postings
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));
create policy postings_member_select on public.job_postings
  for select to authenticated
  using (published and app.is_member(company_id));

create policy applications_hr on public.applications
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));
create policy applications_self_select on public.applications
  for select to authenticated
  using (applicant_profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- documents · HR everything; employee reads own + uploads own
-- (dispatcher gets no document access — payroll data stays HR-only)
-- ---------------------------------------------------------------------------
create policy documents_hr on public.documents
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));
create policy documents_self_select on public.documents
  for select to authenticated
  using (employee_id = app.current_employee_id(company_id));
create policy documents_self_insert on public.documents
  for insert to authenticated
  with check (
    employee_id = app.current_employee_id(company_id)
    and uploaded_by = auth.uid()
    and category in ('certificate','work_permit','training','sick_note','other')
  );

-- ---------------------------------------------------------------------------
-- chat · participant-scoped
-- ---------------------------------------------------------------------------
create policy conversations_select on public.conversations
  for select to authenticated using (app.is_participant(id));
create policy conversations_insert on public.conversations
  for insert to authenticated
  with check (app.is_member(company_id) and created_by = auth.uid());

create policy participants_select on public.conversation_participants
  for select to authenticated
  using (profile_id = auth.uid() or app.is_participant(conversation_id));
create policy participants_insert on public.conversation_participants
  for insert to authenticated
  with check (
    app.is_member(company_id)
    and (
      app.is_staff(company_id)
      or exists (
        select 1 from public.conversations c
        where c.id = conversation_id and c.created_by = auth.uid()
      )
      or profile_id = auth.uid()
    )
  );
create policy participants_self_update on public.conversation_participants
  for update to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

create policy messages_select on public.messages
  for select to authenticated using (app.is_participant(conversation_id));
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    app.is_participant(conversation_id)
    and sender_id = auth.uid()
    and app.is_member(company_id)
  );

-- ---------------------------------------------------------------------------
-- news · members read published, HR manages
-- ---------------------------------------------------------------------------
create policy news_select on public.news_posts
  for select to authenticated
  using (app.is_member(company_id) and published_at is not null);
create policy news_hr on public.news_posts
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));

-- ---------------------------------------------------------------------------
-- notifications · strictly own
-- ---------------------------------------------------------------------------
create policy notifications_self_select on public.notifications
  for select to authenticated using (profile_id = auth.uid());
create policy notifications_self_update on public.notifications
  for update to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
create policy notifications_insert_staff on public.notifications
  for insert to authenticated with check (app.is_staff(company_id));

-- ---------------------------------------------------------------------------
-- onboarding · HR manages, employee reads own
-- ---------------------------------------------------------------------------
create policy onboarding_hr on public.onboarding_items
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));
create policy onboarding_self_select on public.onboarding_items
  for select to authenticated
  using (employee_id = app.current_employee_id(company_id));

-- ---------------------------------------------------------------------------
-- safety · members read instructions; employee confirms own completion
-- ---------------------------------------------------------------------------
create policy safety_select on public.safety_instructions
  for select to authenticated using (app.is_member(company_id));
create policy safety_write on public.safety_instructions
  for all to authenticated
  using (app.is_hr(company_id)) with check (app.is_hr(company_id));

create policy safety_completions_select on public.safety_completions
  for select to authenticated
  using (app.is_staff(company_id) or employee_id = app.current_employee_id(company_id));
create policy safety_completions_insert on public.safety_completions
  for insert to authenticated
  with check (employee_id = app.current_employee_id(company_id));

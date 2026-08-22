-- Clockwise · Migration 0008 · Offer-derived shift visibility (Phase B4.1)
--
-- Defect this fixes: 0002 grants an employee SELECT on a shift only through an
-- existing shift_assignment. An offer is deliberately not an assignment, so an
-- employee who was offered a shift could read the offer and their own response
-- row but not the shift behind them — and the offer list, which joins through
-- to the shift, therefore rendered nothing at all.
--
-- Additive only: 0002's policies are untouched, and PostgreSQL ORs permissive
-- policies together, so assigned-shift visibility keeps working exactly as
-- before. This adds one further path and no more.
--
-- The grant is deliberately narrow. It lasts only while the offer is open, so
-- visibility ends the moment the offer is filled, cancelled or expired, and it
-- is keyed on app.current_employee_id(company_id), which resolves per tenant —
-- an employee of another company gets a different (or null) employee id and
-- matches nothing.

create policy shifts_offered_select on public.shifts
  for select to authenticated
  using (
    exists (
      select 1
      from public.shift_offer_responses r
      join public.shift_offers o on o.id = r.offer_id
      where o.shift_id = public.shifts.id
        and o.status = 'open'
        and r.company_id = public.shifts.company_id
        and r.employee_id = app.current_employee_id(public.shifts.company_id)
    )
  );

-- The shift card names the client, which lives on the job.
create policy jobs_offered_select on public.jobs
  for select to authenticated
  using (
    exists (
      select 1
      from public.shift_offer_responses r
      join public.shift_offers o on o.id = r.offer_id
      join public.shifts s on s.id = o.shift_id
      where s.job_id = public.jobs.id
        and o.status = 'open'
        and r.company_id = public.jobs.company_id
        and r.employee_id = app.current_employee_id(public.jobs.company_id)
    )
  );

comment on policy shifts_offered_select on public.shifts is
  'Lets an employee read a shift they have been offered, while that offer is '
  'open. Additive to shifts_assigned_select; neither replaces the other.';

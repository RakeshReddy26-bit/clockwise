-- Isolation-test fixtures: two tenants, fixed UUIDs.
-- Company A: 11111111-...  Company B: 22222222-...
-- Users: a-admin aaaa...01, a-dispatcher aaaa...02, a-employee aaaa...03,
--        b-admin bbbb...01, b-employee bbbb...03

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@a.test'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'dispatch@a.test'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'worker@a.test'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'admin@b.test'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'worker@b.test');

-- handle_new_user trigger created profiles; make names deterministic
update public.profiles set full_name = 'Admin A'      where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update public.profiles set full_name = 'Dispatcher A' where id = 'aaaaaaaa-0000-0000-0000-000000000002';
update public.profiles set full_name = 'Worker A'     where id = 'aaaaaaaa-0000-0000-0000-000000000003';
update public.profiles set full_name = 'Admin B'      where id = 'bbbbbbbb-0000-0000-0000-000000000001';
update public.profiles set full_name = 'Worker B'     where id = 'bbbbbbbb-0000-0000-0000-000000000003';

insert into public.companies (id, name) values
  ('11111111-0000-0000-0000-000000000000', 'Firma A GmbH'),
  ('22222222-0000-0000-0000-000000000000', 'Firma B GmbH');

insert into public.company_memberships (profile_id, company_id, role, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000', 'COMPANY_ADMIN', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000000', 'DISPATCHER', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000000', 'EMPLOYEE', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000', 'COMPANY_ADMIN', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000000', 'EMPLOYEE', 'active');

insert into public.employees (id, company_id, profile_id, employee_no, full_name) values
  ('aaaa1111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000003', 'A-001', 'Worker A'),
  ('aaaa1111-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000000', null, 'A-002', 'Colleague A'),
  ('bbbb1111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000003', 'B-001', 'Worker B');

-- Synthetic site coordinates (no real employee locations)
insert into public.locations (id, company_id, name, address, lat, lng, geofence_radius_m, geofence_enabled) values
  ('aaaa0000-1111-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000',
   'Standort A', 'Teststraße 1', 52.52000, 13.40500, 100, true),
  ('bbbb0000-1111-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000',
   'Standort B', 'Teststraße 2', 48.13710, 11.57540, 100, true);

insert into public.jobs (id, company_id, client_name, location_id) values
  ('aaaa2222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000', 'Kunde A',
   'aaaa0000-1111-0000-0000-000000000001'),
  ('bbbb2222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000', 'Kunde B',
   'bbbb0000-1111-0000-0000-000000000001');

insert into public.shifts (id, company_id, job_id, date, start_time, end_time, required_count) values
  ('aaaa3333-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000',
   'aaaa2222-0000-0000-0000-000000000001', '2026-09-01', '2026-09-01 08:00+02', '2026-09-01 16:00+02', 2),
  ('bbbb3333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000',
   'bbbb2222-0000-0000-0000-000000000001', '2026-09-01', '2026-09-01 08:00+02', '2026-09-01 16:00+02', 1);

insert into public.shift_assignments (id, company_id, shift_id, employee_id, status) values
  ('aaaa4444-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000',
   'aaaa3333-0000-0000-0000-000000000001', 'aaaa1111-0000-0000-0000-000000000001', 'assigned'),
  ('bbbb4444-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000000',
   'bbbb3333-0000-0000-0000-000000000001', 'bbbb1111-0000-0000-0000-000000000001', 'assigned');

insert into public.notifications (company_id, profile_id, type) values
  ('11111111-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000003', 'shift_assigned'),
  ('22222222-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000003', 'shift_assigned');

insert into public.conversations (id, company_id, topic, created_by) values
  ('aaaa5555-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000000', 'schedule', 'aaaaaaaa-0000-0000-0000-000000000002');
insert into public.conversation_participants (company_id, conversation_id, profile_id) values
  ('11111111-0000-0000-0000-000000000000', 'aaaa5555-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'),
  ('11111111-0000-0000-0000-000000000000', 'aaaa5555-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003');
insert into public.messages (company_id, conversation_id, sender_id, body) values
  ('11111111-0000-0000-0000-000000000000', 'aaaa5555-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'Hallo');

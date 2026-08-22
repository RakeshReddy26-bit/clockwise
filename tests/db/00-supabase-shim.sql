-- Local-test shim replicating the Supabase runtime environment.
-- NEVER run against a real Supabase project (auth schema exists there).
--
-- Roles are cluster-wide, so they are created once and reused by every test
-- database. On PostgreSQL 16 and newer, creating a BYPASSRLS role requires the
-- creating role to have BYPASSRLS itself — CREATEROLE alone is not enough — so
-- a non-superuser test owner must have the roles provisioned for it. The
-- error below says exactly what to run.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    begin
      create role service_role nologin bypassrls;
    exception when insufficient_privilege then
      raise exception 'cannot create role "service_role" with BYPASSRLS'
        using hint =
          'Run once as a superuser (e.g. psql -U postgres): '
          'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; '
          'CREATE ROLE service_role NOLOGIN BYPASSRLS;';
    end;
  end if;
end $$;

-- A service_role without BYPASSRLS would silently read zero rows and make the
-- isolation suite fail in a confusing way. Fail loudly and specifically here.
do $$ begin
  if not exists (
    select 1 from pg_roles where rolname = 'service_role' and rolbypassrls
  ) then
    raise exception 'role "service_role" exists but lacks BYPASSRLS'
      using hint = 'Run once as a superuser: ALTER ROLE service_role BYPASSRLS;';
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Same semantics as Supabase: uid comes from the JWT 'sub' claim.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;

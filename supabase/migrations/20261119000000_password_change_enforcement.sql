-- Phase 2.1, part 1 of 2: server-side enforcement of the mandatory password change (review finding F1).
--
-- Problem (proved by scripts/probe-temp-password-local.mjs on the Phase 2 schema): a login with an admin-issued
-- temporary password could already use the data API, and the "must change password" flag lived in user_metadata,
-- which the user can write. The rule was only a screen.
--
-- Fix: the requirement is a column on public.staff that clients cannot write (no INSERT/UPDATE grant; only the
-- service role and SECURITY DEFINER functions can). While it is true:
--   * current_tenant_ids() is empty  -> every tenant-scoped policy, RPC, storage rule and Realtime event is closed,
--   * is_admin() / is_active_staff() are false -> the platform admin console and admin RPCs are closed too,
--   * the Edge Functions treat the login as having no tenant (send, mark-read) or refuse it (admin functions).
-- The check is a live database lookup, not a token claim, so it applies to sessions that already exist (for example
-- after an admin resets a password) the moment the flag is set.
-- The only way to clear it is the complete-password-change Edge Function, which verifies the caller and sets the
-- password itself.
--
-- Additive and idempotent. Existing logins keep false: the Owner (test) tenant and every current user are untouched.

alter table public.staff add column if not exists must_change_password boolean not null default false;
comment on column public.staff.must_change_password is
  'True while the login still has an administrator-issued temporary password. Blocks all application data access. Written only by the service role.';

-- ---------------------------------------------------------------------------------------------
-- The identity helpers now refuse a login that still has to change its password
-- ---------------------------------------------------------------------------------------------

create or replace function public.current_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
    from public.tenant_memberships m
    join public.tenants t on t.id = m.tenant_id
    join public.staff s on s.user_id = m.user_id
   where m.user_id = (select auth.uid())
     and not m.disabled
     and not s.disabled
     and not s.must_change_password
     and t.status = 'active';
$$;

create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = (select auth.uid()) and not s.disabled and not s.must_change_password
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = (select auth.uid()) and not s.disabled and not s.must_change_password and s.role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Account creation: new accounts start with the requirement set (the default), in the same transaction
-- ---------------------------------------------------------------------------------------------

drop function if exists public.create_client_account(uuid, text, text, text, uuid, text, text);

create or replace function public.create_client_account(
  p_user_id uuid, p_staff_id text, p_display_name text, p_role text,
  p_tenant_id uuid default null, p_client_name text default null, p_membership_role text default 'owner',
  p_must_change_password boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := p_tenant_id;
  v_name   text := nullif(left(trim(coalesce(p_client_name, '')), 120), '');
  v_slug   text;
begin
  if p_role not in ('admin', 'staff') then raise exception 'invalid role' using errcode = '22023'; end if;
  if p_membership_role not in ('owner', 'agent') then raise exception 'invalid membership role' using errcode = '22023'; end if;
  if p_role = 'staff' and v_tenant is null and v_name is null then
    raise exception 'a client name or an existing tenant is required' using errcode = '22023';
  end if;

  insert into public.staff (user_id, staff_id, display_name, role, must_change_password)
  values (p_user_id, p_staff_id, p_display_name, p_role, coalesce(p_must_change_password, true));

  if v_tenant is not null then
    if not exists (select 1 from public.tenants t where t.id = v_tenant) then
      raise exception 'tenant not found' using errcode = 'P0002';
    end if;
  elsif v_name is not null then
    v_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
    v_slug := left(coalesce(nullif(v_slug, ''), 'client'), 30) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    insert into public.tenants (slug, name) values (v_slug, v_name) returning id into v_tenant;
  end if;

  if v_tenant is not null then
    insert into public.tenant_memberships (tenant_id, user_id, role) values (v_tenant, p_user_id, p_membership_role);
  end if;

  return jsonb_build_object('user_id', p_user_id, 'staff_id', p_staff_id, 'display_name', p_display_name,
                            'role', p_role, 'disabled', false, 'must_change_password', coalesce(p_must_change_password, true),
                            'tenant_id', v_tenant);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setting and clearing the requirement (service role only: Edge Functions)
-- ---------------------------------------------------------------------------------------------

create or replace function public.set_must_change_password(p_user_id uuid, p_value boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.staff set must_change_password = coalesce(p_value, true) where user_id = p_user_id;
  if not found then raise exception 'staff not found' using errcode = 'P0002'; end if;
end $$;

revoke all on function public.set_must_change_password(uuid, boolean),
                       public.create_client_account(uuid, text, text, text, uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.set_must_change_password(uuid, boolean),
                          public.create_client_account(uuid, text, text, text, uuid, text, text, boolean)
  to service_role;

-- The helpers keep the grants they had (CREATE OR REPLACE preserves them); re-assert for clarity.
revoke all on function public.current_tenant_ids(), public.current_tenant_id() from public, anon;
grant execute on function public.current_tenant_ids(), public.current_tenant_id() to authenticated, service_role;

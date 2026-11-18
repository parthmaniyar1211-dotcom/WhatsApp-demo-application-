-- ROLLBACK of the two Phase 2.1 migrations:
--   20261119000100_webhook_quarantine.sql
--   20261119000000_password_change_enforcement.sql
-- It returns the schema to exactly the Phase 2 state (after 20261118000300_routing_admin.sql).
--
-- NOT a migration: it lives in supabase/rollbacks/ so no tool applies it by accident.
--
-- SAFETY GUARDS (each refuses and changes nothing, because rolling back would be unsafe):
--   1. Pending quarantined events exist: dropping the table would destroy customer messages that were never
--      stored. Replay them (webhook-replay) or let them expire first. Override only on purpose:
--        set app.confirm_discard_quarantine = 'yes';
--   2. A login still has a temporary password (staff.must_change_password = true): after the rollback the
--      database would no longer lock it, so a temporary-password login would reach its tenant's data again
--      (the F1 weakness). Finish or reset those accounts first, or accept it explicitly:
--        set app.confirm_unlock_temporary_accounts = 'yes';
--
-- After the rollback the Edge Functions of Phase 2.1 must NOT stay deployed: they call functions that no longer exist.
-- Redeploy the Phase 2 functions first (docs/PHASE2_1_SECURITY_REPORT.md, "Rollback").
--
-- Idempotent: running it twice is harmless. Tested on a LOCAL database only (supabase/rollbacks/rehearse_phase21_local.sh).

\set ON_ERROR_STOP on
begin;

do $$
declare v_pending bigint := 0; v_locked bigint := 0;
begin
  if to_regclass('public.webhook_quarantine') is not null then   -- dynamic: the table is gone on a second run
    execute 'select count(*) from public.webhook_quarantine where replayed_at is null and payload is not null and expires_at > now()' into v_pending;
  end if;
  if v_pending > 0 and coalesce(current_setting('app.confirm_discard_quarantine', true), '') <> 'yes' then
    raise exception 'Rollback refused: quarantined webhook events are still waiting. Replay them or let them expire first (or set app.confirm_discard_quarantine = ''yes'').';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'staff' and column_name = 'must_change_password') then
    execute 'select count(*) from public.staff where must_change_password' into v_locked;
  end if;
  if v_locked > 0 and coalesce(current_setting('app.confirm_unlock_temporary_accounts', true), '') <> 'yes' then
    raise exception 'Rollback refused: some logins still have a temporary password and would become fully usable. Finish or reset them first (or set app.confirm_unlock_temporary_accounts = ''yes'').';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Part 2 (webhook quarantine), undone first
-- ---------------------------------------------------------------------------------------------
drop function if exists public.admin_routing_diagnostics();
drop function if exists public.purge_expired_webhook_data(interval, interval);
drop function if exists public.finish_quarantine_replay(uuid, boolean, text);
drop function if exists public.claim_quarantine(text, integer);
drop function if exists public.quarantine_webhook_change(uuid, text, text, text, text, jsonb);
drop function if exists public.record_webhook_event(text, text, text, uuid, text, text, uuid, text, uuid);

create or replace function public.record_webhook_event(
  p_phone_number_id text, p_waba_id text, p_field text, p_connection_id uuid, p_outcome text, p_detail text default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.webhook_events (phone_number_id, waba_id, field, connection_id, outcome, detail)
  values (left(p_phone_number_id, 64), left(p_waba_id, 64), left(p_field, 64), p_connection_id, p_outcome, left(p_detail, 200));
  if p_connection_id is not null and p_outcome = 'routed' then
    update public.whatsapp_connections set last_webhook_at = now() where id = p_connection_id;
  end if;
end $$;
revoke all on function public.record_webhook_event(text, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_webhook_event(text, text, text, uuid, text, text) to service_role;

drop index if exists public.webhook_events_reason_idx;
alter table public.webhook_events drop column if exists quarantine_id;
alter table public.webhook_events drop column if exists reason;
alter table public.webhook_events drop column if exists event_id;
drop table if exists public.webhook_quarantine;

-- ---------------------------------------------------------------------------------------------
-- Part 1 (password change enforcement), undone second
-- ---------------------------------------------------------------------------------------------
drop function if exists public.set_must_change_password(uuid, boolean);
drop function if exists public.create_client_account(uuid, text, text, text, uuid, text, text, boolean);

create or replace function public.create_client_account(
  p_user_id uuid, p_staff_id text, p_display_name text, p_role text,
  p_tenant_id uuid default null, p_client_name text default null, p_membership_role text default 'owner'
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

  insert into public.staff (user_id, staff_id, display_name, role) values (p_user_id, p_staff_id, p_display_name, p_role);

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
                            'role', p_role, 'disabled', false, 'tenant_id', v_tenant);
end $$;
revoke all on function public.create_client_account(uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_client_account(uuid, text, text, text, uuid, text, text) to service_role;

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
     and t.status = 'active';
$$;

create or replace function public.is_active_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = (select auth.uid()) and not s.disabled
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = (select auth.uid()) and not s.disabled and s.role = 'admin'
  );
$$;

revoke all on function public.current_tenant_ids(), public.current_tenant_id() from public, anon;
grant execute on function public.current_tenant_ids(), public.current_tenant_id() to authenticated, service_role;

alter table public.staff drop column if exists must_change_password;

commit;

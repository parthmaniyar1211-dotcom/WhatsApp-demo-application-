-- Multi-tenant foundation, part 4 of 4: webhook routing by Phone Number ID, client account creation,
-- audit log, admin-only reporting, push device registration.
--
-- Service-role functions are for the Edge Functions only. The admin_* functions check is_admin()
-- inside and return counts and states only, never message content or tokens.

-- ---------------------------------------------------------------------------------------------
-- Webhook routing
-- ---------------------------------------------------------------------------------------------

-- Finds the connection that owns a Meta phone number id (trusted identifier from the signed webhook).
create or replace function public.resolve_connection(p_phone_number_id text)
returns table (
  connection_id     uuid,
  tenant_id         uuid,
  waba_id           text,
  status            text,
  credential_source text,
  tenant_active     boolean
)
language sql stable security definer set search_path = '' as $$
  select c.id, c.tenant_id, c.waba_id, c.status, c.credential_source, (t.status = 'active')
    from public.whatsapp_connections c
    join public.tenants t on t.id = c.tenant_id
   where p_phone_number_id is not null and c.phone_number_id = p_phone_number_id;
$$;

-- The legacy test number does not know its phone number id yet (it lives in the WA_PHONE_ID secret).
-- The Edge Function that holds that secret calls this once; afterwards normal routing applies.
-- Returns the connection id, or null when nothing was bound (already bound, or id taken).
create or replace function public.bind_legacy_connection(p_phone_number_id text, p_waba_id text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_phone_number_id is null or char_length(p_phone_number_id) not between 5 and 40 then
    return null;
  end if;
  update public.whatsapp_connections c
     set phone_number_id = p_phone_number_id,
         waba_id = coalesce(c.waba_id, nullif(p_waba_id, '')),
         updated_at = now()
   where c.credential_source = 'platform_env'
     and c.phone_number_id is null
     and not exists (select 1 from public.whatsapp_connections o where o.phone_number_id = p_phone_number_id)
  returning c.id into v_id;
  return v_id;
end $$;

-- Routing ledger. Detail is cut to 200 characters and must never carry message content.
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

create or replace function public.purge_webhook_events(p_older_than interval default interval '30 days')
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_count bigint;
begin
  delete from public.webhook_events where received_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.set_connection_state(p_connection_id uuid, p_status text, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('pending', 'connected', 'disconnected', 'revoked', 'error') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  update public.whatsapp_connections
     set status = p_status, last_error = left(p_error, 300), updated_at = now()
   where id = p_connection_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Audit log (insert only; written by trusted functions)
-- ---------------------------------------------------------------------------------------------

create or replace function public.write_audit(
  p_tenant_id uuid, p_actor_user_id uuid, p_action text, p_target text default null, p_detail jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (tenant_id, actor_user_id, actor_staff_id, action, target, detail)
  values (p_tenant_id, p_actor_user_id,
          (select s.staff_id from public.staff s where s.user_id = p_actor_user_id),
          left(p_action, 80), left(p_target, 200), coalesce(p_detail, '{}'::jsonb));
end $$;

-- Nobody can alter or delete audit rows through the API (no policies, no grants); make it explicit.
revoke update, delete, truncate on public.audit_logs from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Client (staff) account creation: staff row + tenant + membership in ONE transaction
-- ---------------------------------------------------------------------------------------------

-- Called by the admin-staff Edge Function after it created the auth user. Either joins an existing
-- tenant (p_tenant_id) or creates a new one named p_client_name. A platform admin may be created
-- without a tenant.
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

-- ---------------------------------------------------------------------------------------------
-- Admin reporting (platform admin only; counts and states, never content or secrets)
-- ---------------------------------------------------------------------------------------------

create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'tenants',          (select count(*) from public.tenants),
    'tenants_active',   (select count(*) from public.tenants where status = 'active'),
    'staff_total',      (select count(*) from public.staff where role = 'staff'),
    'staff_active',     (select count(*) from public.staff where role = 'staff' and not disabled),
    'connections',      (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                           from (select status, count(*) as n from public.whatsapp_connections group by status) x),
    'messages_24h',     jsonb_build_object(
                          'in',     (select count(*) from public.wa_messages where direction = 'in'  and created_at > now() - interval '24 hours'),
                          'out',    (select count(*) from public.wa_messages where direction = 'out' and created_at > now() - interval '24 hours'),
                          'failed', (select count(*) from public.wa_messages where status = 'failed' and created_at > now() - interval '24 hours')),
    'tokens_expiring_7d', (select count(*) from public.whatsapp_connections
                            where status = 'connected' and token_expires_at is not null and token_expires_at < now() + interval '7 days'),
    'unrouted_events_24h', (select count(*) from public.webhook_events
                             where outcome in ('unrouted', 'mismatch') and received_at > now() - interval '24 hours'),
    'generated_at',     now()
  );
end $$;

create or replace function public.admin_tenant_summary()
returns table (
  tenant_id uuid, name text, slug text, status text,
  staff_count bigint, staff_active bigint,
  connection_count bigint, connections_connected bigint, last_webhook_at timestamptz,
  messages_24h_in bigint, messages_24h_out bigint, failed_24h bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select t.id, t.name, t.slug, t.status,
         (select count(*) from public.tenant_memberships m where m.tenant_id = t.id),
         (select count(*) from public.tenant_memberships m join public.staff s on s.user_id = m.user_id
           where m.tenant_id = t.id and not m.disabled and not s.disabled),
         (select count(*) from public.whatsapp_connections c where c.tenant_id = t.id),
         (select count(*) from public.whatsapp_connections c where c.tenant_id = t.id and c.status = 'connected'),
         (select max(c.last_webhook_at) from public.whatsapp_connections c where c.tenant_id = t.id),
         (select count(*) from public.wa_messages w where w.tenant_id = t.id and w.direction = 'in'  and w.created_at > now() - interval '24 hours'),
         (select count(*) from public.wa_messages w where w.tenant_id = t.id and w.direction = 'out' and w.created_at > now() - interval '24 hours'),
         (select count(*) from public.wa_messages w where w.tenant_id = t.id and w.status = 'failed' and w.created_at > now() - interval '24 hours')
    from public.tenants t
   order by t.created_at;
end $$;

-- Suspending a tenant locks all of its logins out of data access at once (current_tenant_ids becomes empty).
create or replace function public.admin_set_tenant_status(p_tenant_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('active', 'suspended') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.tenants set status = p_status where id = p_tenant_id;
  if not found then raise exception 'Tenant not found' using errcode = 'P0002'; end if;
  perform public.write_audit(p_tenant_id, (select auth.uid()), 'tenant.set_status', p_tenant_id::text, jsonb_build_object('status', p_status));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Push devices (the FCM sender comes with the notification phase)
-- ---------------------------------------------------------------------------------------------

create or replace function public.register_push_device(p_token text, p_platform text default 'android')
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.push_devices (user_id, tenant_id, fcm_token, platform)
  values ((select auth.uid()), v_tenant, p_token, p_platform)
  -- a device that signs in as someone else is re-assigned, so the previous account stops getting its pushes
  on conflict (fcm_token) do update
    set user_id = excluded.user_id, tenant_id = excluded.tenant_id, platform = excluded.platform, last_seen_at = now();
end $$;

create or replace function public.unregister_push_device(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active_staff() then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.push_devices where fcm_token = p_token and user_id = (select auth.uid());
end $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function public.resolve_connection(text), public.bind_legacy_connection(text, text),
                       public.record_webhook_event(text, text, text, uuid, text, text),
                       public.purge_webhook_events(interval), public.set_connection_state(uuid, text, text),
                       public.write_audit(uuid, uuid, text, text, jsonb),
                       public.create_client_account(uuid, text, text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_connection(text), public.bind_legacy_connection(text, text),
                          public.record_webhook_event(text, text, text, uuid, text, text),
                          public.purge_webhook_events(interval), public.set_connection_state(uuid, text, text),
                          public.write_audit(uuid, uuid, text, text, jsonb),
                          public.create_client_account(uuid, text, text, text, uuid, text, text)
  to service_role;

revoke all on function public.admin_overview(), public.admin_tenant_summary(), public.admin_set_tenant_status(uuid, text),
                       public.register_push_device(text, text), public.unregister_push_device(text)
  from public, anon;
grant execute on function public.admin_overview(), public.admin_tenant_summary(), public.admin_set_tenant_status(uuid, text),
                          public.register_push_device(text, text), public.unregister_push_device(text)
  to authenticated;

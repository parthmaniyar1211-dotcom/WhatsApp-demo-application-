-- ROLLBACK of the four multi-tenant migrations (20261118000000 .. 20261118000300).
--
-- NOT a migration: it lives in supabase/rollbacks/ so no tool applies it by accident.
-- Restores the schema that existed after 20261117000000_message_delete.sql. It is meant for the case where the
-- migrations were applied but the platform is still SINGLE-TENANT in practice (only "Owner (test)").
--
-- SAFETY GUARD: the script REFUSES to run when real multi-tenant data exists (a second tenant, a Vault
-- connection, or conversations outside Owner (test)). Collapsing that data back into one shared inbox
-- would mix clients: in that case restore the pre-migration backup instead (see docs/BACKUP_AND_ROLLBACK_PLAN.md).
--
-- Before it changes anything it copies the new tables into schema rollback_snapshot (tenants, memberships,
-- connections WITHOUT token references, audit log, routing ledger, push devices, and the tenant mapping of
-- every conversation/message/quick reply) so the migrations can be applied again afterwards.
-- No message, conversation, file, flag or login is deleted or modified.
--
-- Tested only on a LOCAL database (see docs/BACKUP_AND_ROLLBACK_PLAN.md): the rolled-back schema was compared
-- object by object with a database restored from the pre-migration backup.

\set ON_ERROR_STOP on
begin;

-- ---------------------------------------------------------------------------------------------
-- 0. Guard
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.tenants) <> 1
     or not exists (select 1 from public.tenants where slug = 'owner-test') then
    raise exception 'Rollback refused: there is more than one tenant (or Owner (test) is missing). Restore the pre-migration backup instead.';
  end if;
  if exists (select 1 from public.whatsapp_connections where credential_source = 'vault') then
    raise exception 'Rollback refused: connections with a Vault token exist. Revoke and delete them first (or restore the backup).';
  end if;
  if (select count(*) from public.whatsapp_connections) <> 1 then
    raise exception 'Rollback refused: expected exactly the one legacy connection.';
  end if;
  if exists (select 1 from public.conversations c join public.tenants t on t.id = c.tenant_id where t.slug <> 'owner-test') then
    raise exception 'Rollback refused: conversations outside Owner (test) exist.';
  end if;
  if exists (select 1 from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id where t.slug <> 'owner-test') then
    raise exception 'Rollback refused: logins of other tenants exist.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Snapshot (so the migrations can be re-applied later)
-- ---------------------------------------------------------------------------------------------
create schema if not exists rollback_snapshot;
revoke all on schema rollback_snapshot from public, anon, authenticated;
drop table if exists rollback_snapshot.tenants, rollback_snapshot.tenant_memberships, rollback_snapshot.whatsapp_connections,
  rollback_snapshot.audit_logs, rollback_snapshot.webhook_events, rollback_snapshot.push_devices,
  rollback_snapshot.conversation_tenants, rollback_snapshot.message_tenants, rollback_snapshot.quick_reply_tenants;
create table rollback_snapshot.tenants            as select * from public.tenants;
create table rollback_snapshot.tenant_memberships as select * from public.tenant_memberships;
-- the Vault reference column is deliberately not copied
create table rollback_snapshot.whatsapp_connections as
  select id, tenant_id, label, display_phone_number, waba_id, phone_number_id, credential_source, status,
         onboarding_method, coexistence, token_expires_at, token_rotated_at, last_webhook_at, last_error, created_at, updated_at
    from public.whatsapp_connections;
create table rollback_snapshot.audit_logs     as select * from public.audit_logs;
create table rollback_snapshot.webhook_events as select * from public.webhook_events;
create table rollback_snapshot.push_devices   as select * from public.push_devices;
create table rollback_snapshot.conversation_tenants as select id, tenant_id, connection_id from public.conversations;
create table rollback_snapshot.message_tenants      as select id, tenant_id from public.wa_messages;
create table rollback_snapshot.quick_reply_tenants  as select id, tenant_id from public.quick_replies;
revoke all on all tables in schema rollback_snapshot from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Policies: drop the tenant ones, restore the single-tenant ones
-- ---------------------------------------------------------------------------------------------
drop policy if exists tenants_select on public.tenants;
drop policy if exists tenant_memberships_select on public.tenant_memberships;
drop policy if exists whatsapp_connections_select on public.whatsapp_connections;
drop policy if exists audit_logs_select on public.audit_logs;
drop policy if exists webhook_events_select on public.webhook_events;
drop policy if exists push_devices_select on public.push_devices;
drop policy if exists staff_select on public.staff;
drop policy if exists conversations_select on public.conversations;
drop policy if exists wa_messages_select on public.wa_messages;
drop policy if exists quick_replies_select on public.quick_replies;
drop policy if exists conversation_reads_select on public.conversation_reads;
drop policy if exists message_flags_select on public.message_flags;
drop policy if exists files_staff_read on storage.objects;
drop policy if exists files_staff_upload on storage.objects;

create policy staff_select on public.staff for select to authenticated
  using ((user_id = (select auth.uid())) or public.is_active_staff());
create policy conversations_select on public.conversations for select to authenticated using (public.is_active_staff());
create policy wa_messages_select on public.wa_messages for select to authenticated using (public.is_active_staff());
create policy quick_replies_select on public.quick_replies for select to authenticated using (public.is_active_staff());
create policy conversation_reads_select on public.conversation_reads for select to authenticated
  using ((user_id = (select auth.uid())) and public.is_active_staff());
create policy message_flags_select on public.message_flags for select to authenticated
  using ((user_id = (select auth.uid())) and public.is_active_staff());
create policy files_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'files' and public.is_active_staff());
create policy files_staff_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and public.is_active_staff()
              and (storage.foldername(name))[1] = 'outgoing'
              and (storage.foldername(name))[2] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------------------------
-- 3. Drop the new functions (the policies that used them are gone)
-- ---------------------------------------------------------------------------------------------
drop function if exists public.apply_message_status(text, text, text, uuid);
drop function if exists public.apply_customer_reaction(text, text, uuid);
drop function if exists public.current_tenant_ids();
drop function if exists public.current_tenant_id();
drop function if exists public.store_connection_token(uuid, text, timestamptz);
drop function if exists public.get_connection_token(uuid);
drop function if exists public.revoke_connection_token(uuid, text);
drop function if exists public.resolve_connection(text);
drop function if exists public.bind_legacy_connection(text, text);
drop function if exists public.record_webhook_event(text, text, text, uuid, text, text);
drop function if exists public.purge_webhook_events(interval);
drop function if exists public.set_connection_state(uuid, text, text);
drop function if exists public.write_audit(uuid, uuid, text, text, jsonb);
drop function if exists public.create_client_account(uuid, text, text, text, uuid, text, text);
drop function if exists public.admin_overview();
drop function if exists public.admin_tenant_summary();
drop function if exists public.admin_set_tenant_status(uuid, text);
drop function if exists public.register_push_device(text, text);
drop function if exists public.unregister_push_device(text);

-- ---------------------------------------------------------------------------------------------
-- 4. Constraints, indexes and columns
-- ---------------------------------------------------------------------------------------------
alter table public.wa_messages  drop constraint if exists wa_messages_conversation_tenant_fkey;
alter table public.conversations drop constraint if exists conversations_connection_tenant_fkey;
alter table public.quick_replies drop constraint if exists quick_replies_tenant_fkey;
alter table public.conversations drop constraint if exists conversations_id_tenant_key;
alter table public.conversations drop constraint if exists conversations_connection_wa_id_key;
drop index if exists public.conversations_connection_wa_user_id_key;
alter table public.quick_replies drop constraint if exists quick_replies_tenant_shortcut_key;
drop index if exists public.conversations_tenant_last_message_idx;
drop index if exists public.wa_messages_tenant_idx;
drop index if exists public.wa_messages_media_path_idx;

alter table public.conversations add constraint conversations_wa_id_key unique (wa_id);
create unique index conversations_wa_user_id_key on public.conversations (wa_user_id) where wa_user_id is not null;
alter table public.quick_replies add constraint quick_replies_shortcut_key unique (shortcut);

alter table public.conversations drop column tenant_id, drop column connection_id;
alter table public.wa_messages   drop column tenant_id;
alter table public.quick_replies drop column tenant_id;

-- ---------------------------------------------------------------------------------------------
-- 5. New tables (their data is in rollback_snapshot)
-- ---------------------------------------------------------------------------------------------
drop table public.push_devices;
drop table public.webhook_events;
drop table public.audit_logs;
drop table public.whatsapp_connections;
drop table public.tenant_memberships;
drop table public.tenants;

-- ---------------------------------------------------------------------------------------------
-- 6. The previous bodies of the functions the migrations replaced (verbatim from the pre-migration database)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_customer_reaction(p_wa_message_id text, p_emoji text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.wa_messages
     set reaction_customer = nullif(left(p_emoji, 32), '')
   where wa_message_id = p_wa_message_id;
  return found;
end $function$
;

CREATE OR REPLACE FUNCTION public.apply_message_status(p_wa_message_id text, p_status text, p_error text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.wa_messages
     set status = p_status,
         error  = case when p_status = 'failed' then left(p_error, 500) else null end
   where wa_message_id = p_wa_message_id
     and direction = 'out'
     and case p_status
           when 'sent'      then status in ('sending')
           when 'delivered' then status in ('sending', 'sent')
           when 'read'      then status in ('sending', 'sent', 'delivered')
           when 'played'    then status in ('sending', 'sent', 'delivered', 'read')
           when 'failed'    then status in ('sending', 'sent')
           else false
         end;
  return found;
end $function$
;

CREATE OR REPLACE FUNCTION public.create_outgoing(p jsonb)
 RETURNS wa_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row public.wa_messages;
begin
  insert into public.wa_messages
    (conversation_id, direction, type, body, media_path, media_mime, media_filename, media_size, media_voice,
     reply_to_wa_message_id, status, sent_by, sent_by_staff_id)
  values
    ((p->>'conversation_id')::uuid, 'out', p->>'type', p->>'body', p->>'media_path', p->>'media_mime',
     p->>'media_filename', (p->>'media_size')::bigint, coalesce((p->>'media_voice')::boolean, false),
     nullif(p->>'reply_to', ''), 'sending', (p->>'sent_by')::uuid,
     (select s.staff_id from public.staff s where s.user_id = (p->>'sent_by')::uuid))
  returning * into v_row;

  update public.conversations
     set last_message_at      = now(),
         last_message_preview = public.message_preview(p->>'type', p->>'body', p->>'media_filename')
   where id = v_row.conversation_id;

  return v_row;
end $function$
;

CREATE OR REPLACE FUNCTION public.delete_message_for_me(p_message_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.wa_messages m where m.id = p_message_id) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  insert into public.message_flags (user_id, message_id, starred, hidden, hidden_at, updated_at)
  values ((select auth.uid()), p_message_id, false, true, now(), now())
  on conflict (user_id, message_id) do update
    set hidden = true, hidden_at = coalesce(public.message_flags.hidden_at, now()), updated_at = now();
end $function$
;

CREATE OR REPLACE FUNCTION public.delete_quick_reply(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.quick_replies where id = p_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.ingest_incoming(p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_phone        text := nullif(p->>'wa_id', '');
  v_user         text := nullif(p->>'user_id', '');
  v_name         text := nullif(p->>'customer_name', '');
  v_conversation uuid;
  v_message      uuid;
  v_sent_at      timestamptz := least(coalesce((p->>'wa_timestamp')::timestamptz, now()), now());
begin
  if v_phone is null and v_user is null then
    raise exception 'ingest_incoming: wa_id or user_id is required';
  end if;

  -- Find the customer by phone number first, then by business-scoped user id.
  select c.id into v_conversation
    from public.conversations c
   where (v_phone is not null and c.wa_id = v_phone)
      or (v_user is not null and (c.wa_user_id = v_user or c.wa_id = v_user))
   order by (c.wa_id = v_phone) desc nulls last
   limit 1
     for update;

  if v_conversation is null then
    insert into public.conversations as c (wa_id, wa_user_id, customer_name)
    values (coalesce(v_phone, v_user), v_user, v_name)
    on conflict (wa_id) do update set customer_name = coalesce(excluded.customer_name, c.customer_name)
    returning c.id into v_conversation;
  else
    update public.conversations c
       set customer_name = coalesce(v_name, c.customer_name),
           -- learn the user id / phone number when Meta starts sharing it (never steal another row's)
           wa_user_id = coalesce(c.wa_user_id, case when v_user is not null and not exists (
                          select 1 from public.conversations o where o.wa_user_id = v_user) then v_user end),
           wa_id = case when v_phone is not null and c.wa_id <> v_phone and not exists (
                          select 1 from public.conversations o where o.wa_id = v_phone) then v_phone else c.wa_id end
     where c.id = v_conversation;
  end if;

  insert into public.wa_messages
    (conversation_id, wa_message_id, direction, type, body, media_mime, media_filename, media_voice,
     status, wa_timestamp, reply_to_wa_message_id, forwarded, location, contacts)
  values
    (v_conversation, p->>'wa_message_id', 'in', p->>'type', p->>'body', p->>'media_mime', p->>'media_filename',
     coalesce((p->>'media_voice')::boolean, false), 'received', v_sent_at, nullif(p->>'reply_to', ''),
     coalesce((p->>'forwarded')::boolean, false),
     case when jsonb_typeof(p->'location') = 'object' then p->'location' end,
     case when jsonb_typeof(p->'contacts') = 'array' then p->'contacts' end)
  on conflict (wa_message_id) do nothing
  returning id into v_message;

  if v_message is null then
    return null;
  end if;

  update public.conversations
     set last_message_at      = now(),
         last_inbound_at      = greatest(coalesce(last_inbound_at, v_sent_at), v_sent_at),
         last_message_preview = public.message_preview(p->>'type', p->>'body', p->>'media_filename')
   where id = v_conversation;

  return v_message;
end $function$
;

CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_conversation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.conversation_reads (user_id, conversation_id, last_read_at)
  values ((select auth.uid()), p_conversation_id, now())
  on conflict (user_id, conversation_id) do update set last_read_at = excluded.last_read_at;
end $function$
;

CREATE OR REPLACE FUNCTION public.release_conversation(p_conversation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.conversations
     set assigned_to = null, assigned_at = null
   where id = p_conversation_id
     and (assigned_to = (select auth.uid()) or public.is_admin());
end $function$
;

CREATE OR REPLACE FUNCTION public.rename_contact(p_conversation_id uuid, p_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.conversations
     set contact_name = nullif(left(trim(coalesce(p_name, '')), 80), '')
   where id = p_conversation_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.restore_message_for_me(p_message_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.message_flags
     set hidden = false, hidden_at = null, updated_at = now()
   where user_id = (select auth.uid()) and message_id = p_message_id;
  delete from public.message_flags
   where user_id = (select auth.uid()) and message_id = p_message_id and not starred and not hidden;
end $function$
;

CREATE OR REPLACE FUNCTION public.save_quick_reply(p_id uuid, p_shortcut text, p_body text)
 RETURNS quick_replies
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row      public.quick_replies;
  v_shortcut text := lower(trim(both '/ ' from coalesce(p_shortcut, '')));
  v_body     text := trim(coalesce(p_body, ''));
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_shortcut !~ '^[a-z0-9_-]{1,30}$' then
    raise exception 'Shortcut must be 1-30 letters, digits, - or _' using errcode = '22023';
  end if;
  if char_length(v_body) not between 1 and 4096 then
    raise exception 'Text must be 1-4096 characters' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.quick_replies (shortcut, body, created_by)
    values (v_shortcut, v_body, (select auth.uid()))
    returning * into v_row;
  else
    update public.quick_replies
       set shortcut = v_shortcut, body = v_body, updated_at = now()
     where id = p_id
    returning * into v_row;
  end if;
  return v_row;
exception when unique_violation then
  raise exception 'The shortcut /% already exists', v_shortcut using errcode = '23505';
end $function$
;

CREATE OR REPLACE FUNCTION public.set_message_flags(p_message_id uuid, p_starred boolean, p_hidden boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not coalesce(p_starred, false) and not coalesce(p_hidden, false) then
    delete from public.message_flags where user_id = (select auth.uid()) and message_id = p_message_id;
  else
    insert into public.message_flags (user_id, message_id, starred, hidden, hidden_at, updated_at)
    values ((select auth.uid()), p_message_id, coalesce(p_starred, false), coalesce(p_hidden, false),
            case when coalesce(p_hidden, false) then now() end, now())
    on conflict (user_id, message_id) do update
      set starred    = excluded.starred,
          hidden     = excluded.hidden,
          hidden_at  = case when excluded.hidden then coalesce(public.message_flags.hidden_at, now()) end,
          updated_at = excluded.updated_at;
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.start_conversation(p_phone text, p_name text DEFAULT NULL::text)
 RETURNS conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_name   text := nullif(left(trim(coalesce(p_name, '')), 80), '');
  v_row    public.conversations;
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(v_digits) not between 7 and 15 then
    raise exception 'Enter the full number with country code, for example 919876543210' using errcode = '22023';
  end if;
  insert into public.conversations as c (wa_id, contact_name)
  values (v_digits, v_name)
  on conflict (wa_id) do update set contact_name = coalesce(v_name, c.contact_name)
  returning * into v_row;
  return v_row;
end $function$
;

CREATE OR REPLACE FUNCTION public.take_conversation(p_conversation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.conversations
     set assigned_to = (select auth.uid()), assigned_at = now()
   where id = p_conversation_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.update_conversation_info(p_conversation_id uuid, p_notes text, p_labels text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_labels text[];
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(array_agg(label order by first_seen), '{}') into v_labels
    from (
      select left(trim(l), 30) as label, min(ord) as first_seen
        from unnest(coalesce(p_labels, '{}')) with ordinality as t (l, ord)
       where trim(l) <> ''
       group by 1
       order by 2
       limit 10
    ) cleaned;
  update public.conversations
     set notes = left(coalesce(p_notes, ''), 5000), labels = v_labels
   where id = p_conversation_id;
end $function$
;

-- The two functions whose signature changed are new objects again: restore the service-role-only ACL.
revoke all on function public.apply_message_status(text, text, text), public.apply_customer_reaction(text, text)
  from public, anon, authenticated;
grant execute on function public.apply_message_status(text, text, text), public.apply_customer_reaction(text, text)
  to service_role;

commit;

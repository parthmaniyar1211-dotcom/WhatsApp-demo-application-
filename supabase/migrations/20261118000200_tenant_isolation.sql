-- Multi-tenant foundation, part 3 of 4: enforcement.
--
--   * tenant_id / connection_id become NOT NULL and are tied together by composite foreign keys, so the
--     database itself refuses a conversation whose connection belongs to another tenant, or a message
--     whose tenant differs from its conversation's.
--   * Uniqueness becomes per connection / per tenant (the same customer number can exist under two
--     tenants; two tenants can both have a /hello quick reply).
--   * Every read policy and every RPC derives the tenant from the logged-in user (current_tenant_ids),
--     never from a parameter.
--   * Storage: a staff member can read a file only if it belongs to a message of their own tenant (or is
--     their own pending upload).
--
-- Idempotent. Requires parts 1 and 2. Nothing is deleted; existing rows keep their ids and values.

-- ---------------------------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------------------------

alter table public.conversations alter column tenant_id set not null;
alter table public.conversations alter column connection_id set not null;
alter table public.wa_messages   alter column tenant_id set not null;
alter table public.quick_replies alter column tenant_id set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_id_tenant_key') then
    alter table public.conversations add constraint conversations_id_tenant_key unique (id, tenant_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'conversations_connection_tenant_fkey') then
    alter table public.conversations add constraint conversations_connection_tenant_fkey
      foreign key (connection_id, tenant_id) references public.whatsapp_connections (id, tenant_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wa_messages_conversation_tenant_fkey') then
    alter table public.wa_messages add constraint wa_messages_conversation_tenant_fkey
      foreign key (conversation_id, tenant_id) references public.conversations (id, tenant_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quick_replies_tenant_fkey') then
    alter table public.quick_replies add constraint quick_replies_tenant_fkey
      foreign key (tenant_id) references public.tenants (id) on delete restrict;
  end if;
end $$;

-- Uniqueness per connection / tenant instead of global.
alter table public.conversations drop constraint if exists conversations_wa_id_key;
drop index if exists public.conversations_wa_user_id_key;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_connection_wa_id_key') then
    alter table public.conversations add constraint conversations_connection_wa_id_key unique (connection_id, wa_id);
  end if;
end $$;
create unique index if not exists conversations_connection_wa_user_id_key
  on public.conversations (connection_id, wa_user_id) where wa_user_id is not null;

alter table public.quick_replies drop constraint if exists quick_replies_shortcut_key;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quick_replies_tenant_shortcut_key') then
    alter table public.quick_replies add constraint quick_replies_tenant_shortcut_key unique (tenant_id, shortcut);
  end if;
end $$;

create index if not exists conversations_tenant_last_message_idx on public.conversations (tenant_id, last_message_at desc);
create index if not exists wa_messages_tenant_idx on public.wa_messages (tenant_id, created_at desc);
create index if not exists wa_messages_media_path_idx on public.wa_messages (media_path) where media_path is not null;

-- ---------------------------------------------------------------------------------------------
-- Privileges and Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.tenants             enable row level security;
alter table public.tenant_memberships  enable row level security;
alter table public.whatsapp_connections enable row level security;
alter table public.audit_logs          enable row level security;
alter table public.webhook_events      enable row level security;
alter table public.push_devices        enable row level security;

revoke all on public.tenants, public.tenant_memberships, public.whatsapp_connections,
              public.audit_logs, public.webhook_events, public.push_devices
  from anon, authenticated;
grant all on public.tenants, public.tenant_memberships, public.whatsapp_connections,
             public.webhook_events, public.push_devices
  to service_role;
-- The audit log is insert-only for everybody, the service role included.
grant select, insert on public.audit_logs to service_role;
grant usage, select on all sequences in schema public to service_role;

grant select on public.tenants, public.tenant_memberships, public.audit_logs,
                public.webhook_events, public.push_devices to authenticated;
-- Connections: column-level grant, so the Vault reference (vault_secret_id) and rotation details are
-- never readable by a logged-in user, whatever the row policy says.
grant select (id, tenant_id, label, display_phone_number, waba_id, phone_number_id, credential_source, status,
              onboarding_method, coexistence, token_expires_at, last_webhook_at, last_error, created_at, updated_at)
  on public.whatsapp_connections to authenticated;

drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants for select to authenticated
  using (id in (select public.current_tenant_ids()) or public.is_admin());

drop policy if exists tenant_memberships_select on public.tenant_memberships;
create policy tenant_memberships_select on public.tenant_memberships for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()) or public.is_admin());

drop policy if exists whatsapp_connections_select on public.whatsapp_connections;
create policy whatsapp_connections_select on public.whatsapp_connections for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()) or public.is_admin());

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (public.is_admin());

drop policy if exists webhook_events_select on public.webhook_events;
create policy webhook_events_select on public.webhook_events for select to authenticated
  using (public.is_admin());

drop policy if exists push_devices_select on public.push_devices;
create policy push_devices_select on public.push_devices for select to authenticated
  using (user_id = (select auth.uid()));

-- Existing tables: replace the "any active staff" policies with tenant-scoped ones.
drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_admin()
    or user_id in (select m.user_id from public.tenant_memberships m where m.tenant_id in (select public.current_tenant_ids()))
  );

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

drop policy if exists wa_messages_select on public.wa_messages;
create policy wa_messages_select on public.wa_messages for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

drop policy if exists quick_replies_select on public.quick_replies;
create policy quick_replies_select on public.quick_replies for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

drop policy if exists conversation_reads_select on public.conversation_reads;
create policy conversation_reads_select on public.conversation_reads for select to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.current_tenant_ids()));

drop policy if exists message_flags_select on public.message_flags;
create policy message_flags_select on public.message_flags for select to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.current_tenant_ids()));

-- Storage: existing objects keep their paths (incoming/<number>/..., outgoing/<user>/...). Access is
-- decided by ownership: the uploader's own pending files, or a file linked to a message of the caller's tenant.
drop policy if exists files_staff_read on storage.objects;
create policy files_staff_read on storage.objects for select to authenticated
  using (
    bucket_id = 'files'
    and exists (select 1 from public.current_tenant_ids())
    and (
      ((storage.foldername(name))[1] = 'outgoing' and (storage.foldername(name))[2] = (select auth.uid())::text)
      or exists (
        select 1 from public.wa_messages m
         where m.media_path = storage.objects.name
           and m.tenant_id in (select public.current_tenant_ids())
      )
    )
  );

drop policy if exists files_staff_upload on storage.objects;
create policy files_staff_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'files'
    and exists (select 1 from public.current_tenant_ids())
    and (storage.foldername(name))[1] = 'outgoing'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- ---------------------------------------------------------------------------------------------
-- Functions that existing screens call: now tenant-aware
-- ---------------------------------------------------------------------------------------------

-- A caller with no active tenant gets "not allowed"; a resource of another tenant is reported exactly
-- like a missing one ("... not found"), so ids cannot be probed across tenants.

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.conversations c where c.id = p_conversation_id and c.tenant_id = v_tenant) then
    raise exception 'Conversation not found' using errcode = 'P0002';
  end if;
  insert into public.conversation_reads (user_id, conversation_id, last_read_at)
  values ((select auth.uid()), p_conversation_id, now())
  on conflict (user_id, conversation_id) do update set last_read_at = excluded.last_read_at;
end $$;

create or replace function public.take_conversation(p_conversation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.conversations
     set assigned_to = (select auth.uid()), assigned_at = now()
   where id = p_conversation_id and tenant_id = v_tenant;
end $$;

create or replace function public.release_conversation(p_conversation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.conversations
     set assigned_to = null, assigned_at = null
   where id = p_conversation_id and tenant_id = v_tenant
     and (assigned_to = (select auth.uid()) or public.is_admin());
end $$;

create or replace function public.rename_contact(p_conversation_id uuid, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.conversations
     set contact_name = nullif(left(trim(coalesce(p_name, '')), 80), '')
   where id = p_conversation_id and tenant_id = v_tenant;
end $$;

create or replace function public.update_conversation_info(p_conversation_id uuid, p_notes text, p_labels text[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_labels text[];
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
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
   where id = p_conversation_id and tenant_id = v_tenant;
end $$;

create or replace function public.delete_message_for_me(p_message_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.wa_messages m where m.id = p_message_id and m.tenant_id = v_tenant) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  insert into public.message_flags (user_id, message_id, starred, hidden, hidden_at, updated_at)
  values ((select auth.uid()), p_message_id, false, true, now(), now())
  on conflict (user_id, message_id) do update
    set hidden = true, hidden_at = coalesce(public.message_flags.hidden_at, now()), updated_at = now();
end $$;

create or replace function public.restore_message_for_me(p_message_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.message_flags
     set hidden = false, hidden_at = null, updated_at = now()
   where user_id = (select auth.uid()) and message_id = p_message_id;
  delete from public.message_flags
   where user_id = (select auth.uid()) and message_id = p_message_id and not starred and not hidden;
end $$;

create or replace function public.set_message_flags(p_message_id uuid, p_starred boolean, p_hidden boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.wa_messages m where m.id = p_message_id and m.tenant_id = v_tenant) then
    raise exception 'Message not found' using errcode = 'P0002';
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
end $$;

create or replace function public.save_quick_reply(p_id uuid, p_shortcut text, p_body text)
returns public.quick_replies language plpgsql security definer set search_path = '' as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_row      public.quick_replies;
  v_shortcut text := lower(trim(both '/ ' from coalesce(p_shortcut, '')));
  v_body     text := trim(coalesce(p_body, ''));
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_shortcut !~ '^[a-z0-9_-]{1,30}$' then
    raise exception 'Shortcut must be 1-30 letters, digits, - or _' using errcode = '22023';
  end if;
  if char_length(v_body) not between 1 and 4096 then
    raise exception 'Text must be 1-4096 characters' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.quick_replies (tenant_id, shortcut, body, created_by)
    values (v_tenant, v_shortcut, v_body, (select auth.uid()))
    returning * into v_row;
  else
    update public.quick_replies
       set shortcut = v_shortcut, body = v_body, updated_at = now()
     where id = p_id and tenant_id = v_tenant
    returning * into v_row;
  end if;
  return v_row;
exception when unique_violation then
  raise exception 'The shortcut /% already exists', v_shortcut using errcode = '23505';
end $$;

create or replace function public.delete_quick_reply(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.quick_replies where id = p_id and tenant_id = v_tenant;
end $$;

-- A new chat goes to the tenant of the caller and to one of that tenant's WhatsApp connections.
create or replace function public.start_conversation(p_phone text, p_name text default null)
returns public.conversations language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_conn   uuid;
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_name   text := nullif(left(trim(coalesce(p_name, '')), 80), '');
  v_row    public.conversations;
begin
  if v_tenant is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if char_length(v_digits) not between 7 and 15 then
    raise exception 'Enter the full number with country code, for example 919876543210' using errcode = '22023';
  end if;
  select c.id into v_conn
    from public.whatsapp_connections c
   where c.tenant_id = v_tenant and c.status in ('connected', 'pending', 'error')
   order by (c.status = 'connected') desc, c.created_at
   limit 1;
  if v_conn is null then
    raise exception 'No WhatsApp number is connected to this account. Ask your administrator.' using errcode = 'P0002';
  end if;
  insert into public.conversations as c (tenant_id, connection_id, wa_id, contact_name)
  values (v_tenant, v_conn, v_digits, v_name)
  on conflict (connection_id, wa_id) do update set contact_name = coalesce(v_name, c.contact_name)
  returning * into v_row;
  return v_row;
end $$;

-- Service-role functions used by the Edge Functions: tenant and connection come from a trusted
-- connection id resolved from Meta's phone_number_id (webhook) or from the caller's conversation (send).

create or replace function public.ingest_incoming(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_conn         uuid := nullif(p->>'connection_id', '')::uuid;
  v_tenant       uuid;
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
  select c.tenant_id into v_tenant from public.whatsapp_connections c where c.id = v_conn;
  if v_tenant is null then
    raise exception 'ingest_incoming: unknown connection';
  end if;

  -- Find the customer of THIS connection by phone number first, then by business-scoped user id.
  select c.id into v_conversation
    from public.conversations c
   where c.connection_id = v_conn
     and ((v_phone is not null and c.wa_id = v_phone)
       or (v_user is not null and (c.wa_user_id = v_user or c.wa_id = v_user)))
   order by (c.wa_id = v_phone) desc nulls last
   limit 1
     for update;

  if v_conversation is null then
    insert into public.conversations as c (tenant_id, connection_id, wa_id, wa_user_id, customer_name)
    values (v_tenant, v_conn, coalesce(v_phone, v_user), v_user, v_name)
    on conflict (connection_id, wa_id) do update set customer_name = coalesce(excluded.customer_name, c.customer_name)
    returning c.id into v_conversation;
  else
    update public.conversations c
       set customer_name = coalesce(v_name, c.customer_name),
           wa_user_id = coalesce(c.wa_user_id, case when v_user is not null and not exists (
                          select 1 from public.conversations o where o.connection_id = v_conn and o.wa_user_id = v_user) then v_user end),
           wa_id = case when v_phone is not null and c.wa_id <> v_phone and not exists (
                          select 1 from public.conversations o where o.connection_id = v_conn and o.wa_id = v_phone) then v_phone else c.wa_id end
     where c.id = v_conversation;
  end if;

  insert into public.wa_messages
    (tenant_id, conversation_id, wa_message_id, direction, type, body, media_mime, media_filename, media_voice,
     status, wa_timestamp, reply_to_wa_message_id, forwarded, location, contacts)
  values
    (v_tenant, v_conversation, p->>'wa_message_id', 'in', p->>'type', p->>'body', p->>'media_mime', p->>'media_filename',
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
end $$;

create or replace function public.create_outgoing(p jsonb)
returns public.wa_messages language plpgsql security definer set search_path = '' as $$
declare
  v_row    public.wa_messages;
  v_tenant uuid;
  v_sender uuid := (p->>'sent_by')::uuid;
begin
  select c.tenant_id into v_tenant from public.conversations c where c.id = (p->>'conversation_id')::uuid;
  if v_tenant is null then
    raise exception 'create_outgoing: conversation not found' using errcode = 'P0002';
  end if;
  -- Defence in depth: the sender must be an active member of the conversation's tenant.
  if not exists (
    select 1 from public.tenant_memberships m join public.staff s on s.user_id = m.user_id
     where m.user_id = v_sender and m.tenant_id = v_tenant and not m.disabled and not s.disabled
  ) then
    raise exception 'create_outgoing: sender does not belong to this tenant' using errcode = '42501';
  end if;

  insert into public.wa_messages
    (tenant_id, conversation_id, direction, type, body, media_path, media_mime, media_filename, media_size, media_voice,
     reply_to_wa_message_id, status, sent_by, sent_by_staff_id)
  values
    (v_tenant, (p->>'conversation_id')::uuid, 'out', p->>'type', p->>'body', p->>'media_path', p->>'media_mime',
     p->>'media_filename', (p->>'media_size')::bigint, coalesce((p->>'media_voice')::boolean, false),
     nullif(p->>'reply_to', ''), 'sending', v_sender,
     (select s.staff_id from public.staff s where s.user_id = v_sender))
  returning * into v_row;

  update public.conversations
     set last_message_at      = now(),
         last_message_preview = public.message_preview(p->>'type', p->>'body', p->>'media_filename')
   where id = v_row.conversation_id;

  return v_row;
end $$;

-- Statuses and reactions must come from the connection that owns the message.
drop function if exists public.apply_message_status(text, text, text);
drop function if exists public.apply_customer_reaction(text, text);

create or replace function public.apply_message_status(
  p_wa_message_id text, p_status text, p_error text, p_connection_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.wa_messages m
     set status = p_status,
         error  = case when p_status = 'failed' then left(p_error, 500) else null end
   where m.wa_message_id = p_wa_message_id
     and m.direction = 'out'
     and m.conversation_id in (select c.id from public.conversations c where c.connection_id = p_connection_id)
     and case p_status
           when 'sent'      then m.status in ('sending')
           when 'delivered' then m.status in ('sending', 'sent')
           when 'read'      then m.status in ('sending', 'sent', 'delivered')
           when 'played'    then m.status in ('sending', 'sent', 'delivered', 'read')
           when 'failed'    then m.status in ('sending', 'sent')
           else false
         end;
  return found;
end $$;

create or replace function public.apply_customer_reaction(
  p_wa_message_id text, p_emoji text, p_connection_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.wa_messages m
     set reaction_customer = nullif(left(p_emoji, 32), '')
   where m.wa_message_id = p_wa_message_id
     and m.conversation_id in (select c.id from public.conversations c where c.connection_id = p_connection_id);
  return found;
end $$;

-- Function privileges (re-asserted: CREATE OR REPLACE keeps old ACLs, new signatures get defaults).
revoke all on function public.ingest_incoming(jsonb), public.create_outgoing(jsonb),
                       public.apply_message_status(text, text, text, uuid),
                       public.apply_customer_reaction(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.ingest_incoming(jsonb), public.create_outgoing(jsonb),
                          public.apply_message_status(text, text, text, uuid),
                          public.apply_customer_reaction(text, text, uuid)
  to service_role;

revoke all on function public.current_tenant_ids(), public.current_tenant_id() from public, anon;
grant execute on function public.current_tenant_ids(), public.current_tenant_id() to authenticated, service_role;

revoke all on function public.mark_conversation_read(uuid), public.take_conversation(uuid), public.release_conversation(uuid),
                       public.rename_contact(uuid, text), public.update_conversation_info(uuid, text, text[]),
                       public.delete_message_for_me(uuid), public.restore_message_for_me(uuid),
                       public.set_message_flags(uuid, boolean, boolean), public.save_quick_reply(uuid, text, text),
                       public.delete_quick_reply(uuid), public.start_conversation(text, text)
  from public, anon;
grant execute on function public.mark_conversation_read(uuid), public.take_conversation(uuid), public.release_conversation(uuid),
                          public.rename_contact(uuid, text), public.update_conversation_info(uuid, text, text[]),
                          public.delete_message_for_me(uuid), public.restore_message_for_me(uuid),
                          public.set_message_flags(uuid, boolean, boolean), public.save_quick_reply(uuid, text, text),
                          public.delete_quick_reply(uuid), public.start_conversation(text, text)
  to authenticated;

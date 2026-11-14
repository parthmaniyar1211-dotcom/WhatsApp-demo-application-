-- WhatsApp shared inbox, part 2: real-API correctness and WhatsApp-like features.
--
-- Run after 20261114000000_whatsapp_inbox.sql. Idempotent: safe to run twice.
-- whatsapp_setup.sql is all migrations concatenated in order (`npm run check:sql`).
--
-- Adds:
--   * every message type the Cloud API delivers (audio, video, sticker, location, contacts, ...)
--   * reply/quote, reactions, "played" status, file size, voice flag
--   * customers without a visible phone number (business-scoped user id, "BSUID")
--   * per-staff starred / hidden messages, shared quick replies, notes and labels, message search
--   * which incoming message was last marked as read at Meta (blue ticks for the customer)

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists wa_user_id text,                       -- Meta business-scoped user id
  add column if not exists notes text not null default '',
  add column if not exists labels text[] not null default '{}',
  add column if not exists meta_read_wa_message_id text;          -- last incoming message marked read at Meta

-- conversations.wa_id stays the address we send to: the phone number (digits) when Meta
-- shares it, otherwise the business-scoped user id.
create unique index if not exists conversations_wa_user_id_key
  on public.conversations (wa_user_id) where wa_user_id is not null;

alter table public.wa_messages
  add column if not exists reply_to_wa_message_id text,           -- the quoted message ("context")
  add column if not exists forwarded boolean not null default false,
  add column if not exists media_size bigint,
  add column if not exists media_voice boolean not null default false,
  add column if not exists location jsonb,                        -- { latitude, longitude, name, address, url }
  add column if not exists contacts jsonb,                        -- [ { name, phones: [..] } ]
  add column if not exists reaction_customer text,                -- the customer's emoji on this message
  add column if not exists reaction_business text,                -- our emoji on this message
  add column if not exists reaction_business_by text;             -- staff_id who set it

alter table public.wa_messages drop constraint if exists wa_messages_type_check;
alter table public.wa_messages add constraint wa_messages_type_check check (type in (
  'text', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contacts',
  'interactive', 'button', 'template', 'other'));

alter table public.wa_messages drop constraint if exists wa_messages_status_check;
alter table public.wa_messages add constraint wa_messages_status_check check (status in (
  'received', 'sending', 'sent', 'delivered', 'read', 'played', 'failed'));

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------

-- Per-staff flags. "hidden" only hides the message for that staff member in this app;
-- nothing is deleted for the customer (the Cloud API cannot delete messages).
create table if not exists public.message_flags (
  user_id    uuid not null references auth.users (id) on delete cascade,
  message_id uuid not null references public.wa_messages (id) on delete cascade,
  starred    boolean not null default false,
  hidden     boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

-- Saved snippets shared by all staff, inserted with "/shortcut" in the reply box.
create table if not exists public.quick_replies (
  id         uuid primary key default gen_random_uuid(),
  shortcut   text not null unique check (shortcut ~ '^[a-z0-9_-]{1,30}$'),
  body       text not null check (char_length(body) between 1 and 4096),
  created_by uuid references public.staff (user_id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.message_flags enable row level security;
alter table public.quick_replies enable row level security;

revoke all on public.message_flags, public.quick_replies from anon, authenticated;
grant select on public.message_flags, public.quick_replies to authenticated;
grant all on public.message_flags, public.quick_replies to service_role;

drop policy if exists message_flags_select on public.message_flags;
create policy message_flags_select on public.message_flags
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_active_staff());

drop policy if exists quick_replies_select on public.quick_replies;
create policy quick_replies_select on public.quick_replies
  for select to authenticated
  using (public.is_active_staff());

insert into public.quick_replies (shortcut, body)
select * from (values
  ('hello', 'Hello! Thank you for contacting us. How can we help you today?'),
  ('thanks', 'Thank you! Is there anything else we can help you with?'),
  ('hours', 'We are open Monday to Saturday, 9 am to 6 pm.')
) as defaults (shortcut, body)
where not exists (select 1 from public.quick_replies);

-- ---------------------------------------------------------------------------
-- Storage: more incoming types (voice notes, videos, stickers, office files), 16 MB
-- (WhatsApp's own limit for audio and video). Staff uploads are still checked again
-- by send-whatsapp (10 MB, 5 MB for photos).
-- ---------------------------------------------------------------------------

update storage.buckets
   set public = false,
       file_size_limit = 16777216,
       allowed_mime_types = array[
         'image/jpeg', 'image/png', 'image/webp',
         'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr',
         'video/mp4', 'video/3gpp',
         'application/pdf', 'text/plain', 'text/csv',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.ms-powerpoint',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation']
 where id = 'files';

-- ---------------------------------------------------------------------------
-- Preview text for the conversation list
-- ---------------------------------------------------------------------------

create or replace function public.message_preview(p_type text, p_body text, p_filename text)
returns text
language sql immutable set search_path = ''
as $$
  select left(case p_type
    when 'image'    then 'Photo'    || coalesce(': ' || nullif(p_body, ''), '')
    when 'video'    then 'Video'    || coalesce(': ' || nullif(p_body, ''), '')
    when 'audio'    then 'Voice message'
    when 'sticker'  then 'Sticker'
    when 'location' then 'Location' || coalesce(': ' || nullif(p_body, ''), '')
    when 'contacts' then 'Contact'  || coalesce(': ' || nullif(p_body, ''), '')
    when 'document' then 'Document' || coalesce(': ' || nullif(p_filename, ''), '')
    when 'template' then 'Template' || coalesce(': ' || nullif(p_body, ''), '')
    else coalesce(p_body, '')
  end, 120);
$$;

-- ---------------------------------------------------------------------------
-- RPCs for Edge Functions only (service_role)
-- ---------------------------------------------------------------------------

drop function if exists public.ingest_incoming_message(text, text, text, text, text, text, text, timestamptz);
drop function if exists public.create_outgoing_message(uuid, uuid, text, text, text, text, text);

-- Store one incoming WhatsApp message. p is a JSON object:
--   wa_id (phone digits, may be null), user_id (BSUID, may be null), customer_name,
--   wa_message_id, type, body, media_mime, media_filename, media_voice, wa_timestamp,
--   reply_to, forwarded, location, contacts
-- Returns the new message id, or null when wa_message_id was already stored (Meta retry).
create or replace function public.ingest_incoming(p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
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
end $$;

-- Store an outgoing message in state "sending" before the Graph API call. p is a JSON object:
--   conversation_id, sent_by, type, body, media_path, media_mime, media_filename, media_size,
--   media_voice, reply_to
create or replace function public.create_outgoing(p jsonb)
returns public.wa_messages
language plpgsql security definer set search_path = ''
as $$
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
end $$;

-- Delivery statuses, now including "played" (voice message listened to). Never moves backwards.
create or replace function public.apply_message_status(
  p_wa_message_id text,
  p_status        text,
  p_error         text
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
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
end $$;

-- The customer reacted to a message (empty emoji = reaction removed). Returns true when found.
create or replace function public.apply_customer_reaction(p_wa_message_id text, p_emoji text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.wa_messages
     set reaction_customer = nullif(left(p_emoji, 32), '')
   where wa_message_id = p_wa_message_id;
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- RPCs for staff
-- ---------------------------------------------------------------------------

-- Star or hide a message for the calling staff member only.
create or replace function public.set_message_flags(p_message_id uuid, p_starred boolean, p_hidden boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not coalesce(p_starred, false) and not coalesce(p_hidden, false) then
    delete from public.message_flags where user_id = (select auth.uid()) and message_id = p_message_id;
  else
    insert into public.message_flags (user_id, message_id, starred, hidden, updated_at)
    values ((select auth.uid()), p_message_id, coalesce(p_starred, false), coalesce(p_hidden, false), now())
    on conflict (user_id, message_id) do update
      set starred = excluded.starred, hidden = excluded.hidden, updated_at = excluded.updated_at;
  end if;
end $$;

-- Create (p_id null) or change a quick reply.
create or replace function public.save_quick_reply(p_id uuid, p_shortcut text, p_body text)
returns public.quick_replies
language plpgsql security definer set search_path = ''
as $$
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
end $$;

create or replace function public.delete_quick_reply(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.quick_replies where id = p_id;
end $$;

-- Internal notes and labels of a customer (never sent to the customer).
create or replace function public.update_conversation_info(p_conversation_id uuid, p_notes text, p_labels text[])
returns void
language plpgsql security definer set search_path = ''
as $$
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
end $$;

-- Text search in messages (all chats, or one chat). Security invoker: RLS applies.
-- Messages the caller has hidden are not returned.
create or replace function public.search_messages(
  p_query           text,
  p_conversation_id uuid default null,
  p_limit           integer default 50
)
returns setof public.wa_messages
language sql stable security invoker set search_path = ''
as $$
  select m.*
    from public.wa_messages m
   where char_length(trim(p_query)) >= 2
     and (p_conversation_id is null or m.conversation_id = p_conversation_id)
     and (m.body ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          or m.media_filename ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
     and not exists (
       select 1 from public.message_flags f
        where f.message_id = m.id and f.user_id = (select auth.uid()) and f.hidden)
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

revoke all on function
  public.ingest_incoming(jsonb),
  public.create_outgoing(jsonb),
  public.apply_customer_reaction(text, text),
  public.set_message_flags(uuid, boolean, boolean),
  public.save_quick_reply(uuid, text, text),
  public.delete_quick_reply(uuid),
  public.update_conversation_info(uuid, text, text[]),
  public.search_messages(text, uuid, integer)
from public, anon, authenticated;

grant execute on function
  public.set_message_flags(uuid, boolean, boolean),
  public.save_quick_reply(uuid, text, text),
  public.delete_quick_reply(uuid),
  public.update_conversation_info(uuid, text, text[]),
  public.search_messages(text, uuid, integer)
to authenticated;

grant execute on function
  public.ingest_incoming(jsonb),
  public.create_outgoing(jsonb),
  public.apply_customer_reaction(text, text)
to service_role;

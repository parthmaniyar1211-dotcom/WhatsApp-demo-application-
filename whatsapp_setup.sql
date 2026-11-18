-- >>> supabase/migrations/20261114000000_whatsapp_inbox.sql

-- WhatsApp shared inbox: full backend schema.
--
-- Idempotent: safe to run twice (SQL editor or `supabase db push`).
-- whatsapp_setup.sql in the repo root is an exact copy of this file
-- (checked by `npm run check:sql`).
--
-- Who may do what:
--   * anon                : nothing.
--   * authenticated staff : read conversations / messages / staff list, read files,
--                           upload outgoing files to their own folder, and call the
--                           four RPCs at the bottom (take, release, mark read, unread counts).
--   * service_role        : everything else (used only inside Edge Functions).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per staff login. Rows are created only by the admin-staff Edge Function.
create table if not exists public.staff (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  staff_id     text not null unique check (staff_id ~ '^[A-Z0-9]{3,20}$'),
  display_name text not null default '',
  role         text not null default 'staff' check (role in ('admin', 'staff')),
  disabled     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- One row per customer phone number.
create table if not exists public.conversations (
  id                   uuid primary key default gen_random_uuid(),
  wa_id                text not null unique,          -- customer number, digits only (Meta "wa_id")
  customer_name        text,
  last_message_preview text,
  last_message_at      timestamptz not null default now(),
  last_inbound_at      timestamptz,                   -- start of the 24-hour reply window
  created_at           timestamptz not null default now()
);
-- Assignment ("take chat") columns.
alter table public.conversations
  add column if not exists assigned_to uuid references public.staff (user_id) on delete set null;
alter table public.conversations
  add column if not exists assigned_at timestamptz;

create table if not exists public.wa_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  wa_message_id    text unique,                       -- Meta message id ("wamid..."); null until sent
  direction        text not null check (direction in ('in', 'out')),
  type             text not null check (type in ('text', 'image', 'document', 'template', 'other')),
  body             text,                              -- text, caption or template name
  media_path       text,                              -- object path inside the private "files" bucket
  media_mime       text,
  media_filename   text,
  status           text not null check (status in ('received', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error            text,                              -- failure reason (never message content)
  sent_by          uuid references public.staff (user_id) on delete set null,
  sent_by_staff_id text,                              -- copy of staff_id, kept if the staff row is deleted
  wa_timestamp     timestamptz,                       -- time reported by WhatsApp (incoming only)
  created_at       timestamptz not null default now() -- arrival time; used for ordering and unread counts
);

-- Per-user read state: everything up to last_read_at counts as read.
create table if not exists public.conversation_reads (
  user_id         uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (user_id, conversation_id)
);

create index if not exists conversations_last_message_at_idx on public.conversations (last_message_at desc);
create index if not exists wa_messages_conversation_idx on public.wa_messages (conversation_id, created_at);
create index if not exists wa_messages_sent_by_idx on public.wa_messages (sent_by, created_at);

-- ---------------------------------------------------------------------------
-- Role helpers (security definer so they can be used inside RLS policies)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.staff              enable row level security;
alter table public.conversations      enable row level security;
alter table public.wa_messages        enable row level security;
alter table public.conversation_reads enable row level security;

-- Clients may only read. All writes go through Edge Functions (service_role) or the RPCs below.
revoke all on public.staff, public.conversations, public.wa_messages, public.conversation_reads
  from anon, authenticated;
grant select on public.staff, public.conversations, public.wa_messages, public.conversation_reads
  to authenticated;
grant all on public.staff, public.conversations, public.wa_messages, public.conversation_reads
  to service_role;

-- A disabled user can still read their own row, so the app can say "account disabled".
drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_active_staff());

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations
  for select to authenticated
  using (public.is_active_staff());

drop policy if exists wa_messages_select on public.wa_messages;
create policy wa_messages_select on public.wa_messages
  for select to authenticated
  using (public.is_active_staff());

drop policy if exists conversation_reads_select on public.conversation_reads;
create policy conversation_reads_select on public.conversation_reads
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_active_staff());

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['conversations', 'wa_messages'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Storage: private bucket "files", 10 MB, images and PDFs only
--   incoming/<wa_id>/<file>     written by the webhook (service_role)
--   outgoing/<user_id>/<file>   uploaded by staff before calling send-whatsapp
-- Files are only ever served through short-lived signed URLs.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('files', 'files', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists files_staff_read on storage.objects;
create policy files_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'files' and public.is_active_staff());

drop policy if exists files_staff_upload on storage.objects;
create policy files_staff_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'files'
    and public.is_active_staff()
    and (storage.foldername(name))[1] = 'outgoing'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- ---------------------------------------------------------------------------
-- RPCs for staff (called from the web app and the APK)
-- ---------------------------------------------------------------------------

-- Take ownership of a chat (also takes it over from another staff member).
create or replace function public.take_conversation(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.conversations
     set assigned_to = (select auth.uid()), assigned_at = now()
   where id = p_conversation_id;
end $$;

-- Release a chat. Only the owner or an admin may release it.
create or replace function public.release_conversation(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.conversations
     set assigned_to = null, assigned_at = null
   where id = p_conversation_id
     and (assigned_to = (select auth.uid()) or public.is_admin());
end $$;

-- Mark everything in a conversation as read for the calling user (server clock).
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.conversation_reads (user_id, conversation_id, last_read_at)
  values ((select auth.uid()), p_conversation_id, now())
  on conflict (user_id, conversation_id) do update set last_read_at = excluded.last_read_at;
end $$;

-- Unread incoming messages per conversation for the calling user.
-- Security invoker: RLS on wa_messages / conversation_reads applies.
create or replace function public.unread_counts()
returns table (conversation_id uuid, unread bigint)
language sql stable security invoker set search_path = ''
as $$
  select m.conversation_id, count(*)
    from public.wa_messages m
    left join public.conversation_reads r
      on r.conversation_id = m.conversation_id and r.user_id = (select auth.uid())
   where m.direction = 'in'
     and (r.last_read_at is null or m.created_at > r.last_read_at)
   group by m.conversation_id;
$$;

-- ---------------------------------------------------------------------------
-- RPCs for Edge Functions only (service_role)
-- ---------------------------------------------------------------------------

create or replace function public.message_preview(p_type text, p_body text, p_filename text)
returns text
language sql immutable set search_path = ''
as $$
  select left(case p_type
    when 'image'    then 'Photo'    || coalesce(': ' || nullif(p_body, ''), '')
    when 'document' then 'Document' || coalesce(': ' || nullif(p_filename, ''), '')
    when 'template' then 'Template' || coalesce(': ' || nullif(p_body, ''), '')
    else coalesce(p_body, '')
  end, 120);
$$;

-- Store one incoming WhatsApp message. Creates the conversation when needed.
-- Returns the new message id, or null when wa_message_id was already stored (Meta retry).
create or replace function public.ingest_incoming_message(
  p_wa_id          text,
  p_customer_name  text,
  p_wa_message_id  text,
  p_type           text,
  p_body           text,
  p_media_mime     text,
  p_media_filename text,
  p_wa_timestamp   timestamptz
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_conversation uuid;
  v_message      uuid;
  v_sent_at      timestamptz := least(coalesce(p_wa_timestamp, now()), now());
begin
  insert into public.conversations as c (wa_id, customer_name)
  values (p_wa_id, nullif(p_customer_name, ''))
  on conflict (wa_id) do update
    set customer_name = coalesce(nullif(excluded.customer_name, ''), c.customer_name)
  returning c.id into v_conversation;

  insert into public.wa_messages
    (conversation_id, wa_message_id, direction, type, body, media_mime, media_filename, status, wa_timestamp)
  values
    (v_conversation, p_wa_message_id, 'in', p_type, p_body, p_media_mime, p_media_filename, 'received', v_sent_at)
  on conflict (wa_message_id) do nothing
  returning id into v_message;

  if v_message is null then
    return null;
  end if;

  update public.conversations
     set last_message_at      = now(),
         last_inbound_at      = greatest(coalesce(last_inbound_at, v_sent_at), v_sent_at),
         last_message_preview = public.message_preview(p_type, p_body, p_media_filename)
   where id = v_conversation;

  return v_message;
end $$;

-- Store an outgoing message in state "sending" before the Graph API call.
create or replace function public.create_outgoing_message(
  p_conversation_id uuid,
  p_sent_by         uuid,
  p_type            text,
  p_body            text,
  p_media_path      text,
  p_media_mime      text,
  p_media_filename  text
)
returns public.wa_messages
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.wa_messages;
begin
  insert into public.wa_messages
    (conversation_id, direction, type, body, media_path, media_mime, media_filename, status, sent_by, sent_by_staff_id)
  values
    (p_conversation_id, 'out', p_type, p_body, p_media_path, p_media_mime, p_media_filename, 'sending', p_sent_by,
     (select s.staff_id from public.staff s where s.user_id = p_sent_by))
  returning * into v_row;

  update public.conversations
     set last_message_at      = now(),
         last_message_preview = public.message_preview(p_type, p_body, p_media_filename)
   where id = p_conversation_id;

  return v_row;
end $$;

-- Apply a WhatsApp delivery status. Statuses can arrive out of order, so a
-- message never moves backwards (read -> delivered is ignored).
-- Returns true when a row changed.
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
           when 'failed'    then status in ('sending', 'sent')
           else false
         end;
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges (Supabase grants execute to anon/authenticated by default)
-- ---------------------------------------------------------------------------

revoke all on function
  public.is_active_staff(),
  public.is_admin(),
  public.take_conversation(uuid),
  public.release_conversation(uuid),
  public.mark_conversation_read(uuid),
  public.unread_counts(),
  public.message_preview(text, text, text),
  public.ingest_incoming_message(text, text, text, text, text, text, text, timestamptz),
  public.create_outgoing_message(uuid, uuid, text, text, text, text, text),
  public.apply_message_status(text, text, text)
from public, anon, authenticated;

grant execute on function
  public.is_active_staff(),
  public.is_admin(),
  public.take_conversation(uuid),
  public.release_conversation(uuid),
  public.mark_conversation_read(uuid),
  public.unread_counts()
to authenticated;

grant execute on function
  public.is_active_staff(),
  public.is_admin(),
  public.message_preview(text, text, text),
  public.ingest_incoming_message(text, text, text, text, text, text, text, timestamptz),
  public.create_outgoing_message(uuid, uuid, text, text, text, text, text),
  public.apply_message_status(text, text, text)
to service_role;

-- >>> supabase/migrations/20261115000000_whatsapp_features.sql

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

-- >>> supabase/migrations/20261116000000_contacts.sql

-- Part 3: WhatsApp-style contacts. Idempotent.
--
-- * conversations.contact_name: the name the user saved for a number. It is never overwritten by
--   the WhatsApp profile name, which keeps arriving in conversations.customer_name.
-- * start_conversation(): add a phone number and open a chat with it (the chat exists before the first message).
-- * rename_contact(): change the saved name.

alter table public.conversations add column if not exists contact_name text;

-- Start (or find) the chat for a phone number. Digits only, with country code, 7-15 digits.
create or replace function public.start_conversation(p_phone text, p_name text default null)
returns public.conversations
language plpgsql security definer set search_path = ''
as $$
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
end $$;

create or replace function public.rename_contact(p_conversation_id uuid, p_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.conversations
     set contact_name = nullif(left(trim(coalesce(p_name, '')), 80), '')
   where id = p_conversation_id;
end $$;

revoke all on function public.start_conversation(text, text), public.rename_contact(uuid, text)
  from public, anon, authenticated;
grant execute on function public.start_conversation(text, text), public.rename_contact(uuid, text)
  to authenticated;

-- >>> supabase/migrations/20261117000000_message_delete.sql

-- Part 5: "Delete for me" done properly. Idempotent.
--
-- Soft delete only: a deleted message stays in wa_messages (statuses, webhooks and media are untouched).
-- It is hidden for the user who deleted it, through that user's own row in message_flags.
--
-- * message_flags.hidden_at         when the message was deleted for this user (audit)
-- * delete_message_for_me()         checks the caller and the message, hides it for the caller only
-- * restore_message_for_me()        Undo / "show again"
-- * visible_last_messages()         the newest message per chat that the CALLER has not deleted.
--                                   Computed per user, so a deleted message never shows up as a chat preview
--                                   for someone else (a shared "last message id" column would leak).
-- * set_message_flags()             kept for the APK (stars); now keeps hidden_at consistent

alter table public.message_flags add column if not exists hidden_at timestamptz;

update public.message_flags set hidden_at = coalesce(hidden_at, updated_at) where hidden and hidden_at is null;

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

-- Hide one message for the calling user. Changes nothing else: not the message, its status, its media,
-- other users' views, or the chat.
create or replace function public.delete_message_for_me(p_message_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
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
end $$;

-- Undo. A star set before the deletion is kept; an otherwise empty flag row is removed.
create or replace function public.restore_message_for_me(p_message_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_active_staff() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.message_flags
     set hidden = false, hidden_at = null, updated_at = now()
   where user_id = (select auth.uid()) and message_id = p_message_id;
  delete from public.message_flags
   where user_id = (select auth.uid()) and message_id = p_message_id and not starred and not hidden;
end $$;

-- The newest message of every chat that the caller has not deleted (security invoker: row level security applies).
-- Only the columns needed to draw a chat-list preview are returned.
create or replace function public.visible_last_messages()
returns table (
  conversation_id uuid,
  message_id      uuid,
  direction       text,
  type            text,
  body            text,
  media_filename  text,
  media_voice     boolean,
  created_at      timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  select c.id, m.id, m.direction, m.type, m.body, m.media_filename, m.media_voice, m.created_at
    from public.conversations c
   cross join lateral (
     select x.*
       from public.wa_messages x
      where x.conversation_id = c.id
        and not exists (
          select 1 from public.message_flags f
           where f.message_id = x.id and f.user_id = (select auth.uid()) and f.hidden)
      order by x.created_at desc, x.id desc
      limit 1
   ) m;
$$;

revoke all on function
  public.delete_message_for_me(uuid),
  public.restore_message_for_me(uuid),
  public.visible_last_messages()
from public, anon, authenticated;

grant execute on function
  public.delete_message_for_me(uuid),
  public.restore_message_for_me(uuid),
  public.visible_last_messages()
to authenticated;

-- >>> supabase/migrations/20261118000000_tenants_core.sql

-- Multi-tenant foundation, part 1 of 4: tenants, memberships, WhatsApp connections, audit log,
-- webhook ledger, push devices, and the "Owner (test)" tenant that adopts all existing data.
--
-- Additive and idempotent: it only creates objects and fills NEW columns. No existing row is
-- changed or deleted, no existing column is altered. Enforcement (NOT NULL, new RLS policies,
-- tenant-aware functions) comes in 20261118000200_tenant_isolation.sql.
--
-- Model:
--   * tenant          one client of the platform (one business).
--   * membership      a staff login belongs to exactly one tenant (UNIQUE user_id) in this version.
--                     role owner/agent leaves room for several logins per client later.
--   * platform admin  staff.role = 'admin'. Sees tenants, connections, usage and the audit log, but
--                     reads message CONTENT only of the tenant it is a member of.
--   * connection      one WhatsApp Business number of a tenant (WABA id + phone number id). Tokens are
--                     never in this table: only a reference to a Vault secret (see part 2).

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        text not null check (char_length(name) between 1 and 120),
  status      text not null default 'active' check (status in ('active', 'suspended')),
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.tenant_memberships (
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  user_id     uuid not null references public.staff (user_id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner', 'agent')),
  disabled    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id),
  -- One tenant per login. Drop this constraint (and update current_tenant_id) to allow several.
  constraint tenant_memberships_one_tenant_per_user unique (user_id)
);

create table if not exists public.whatsapp_connections (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete restrict,
  label                 text not null default '',
  display_phone_number  text,
  waba_id               text,
  phone_number_id       text,
  -- 'vault'        the token lives in a Vault secret referenced by vault_secret_id (all new connections).
  -- 'platform_env' the single legacy connection that still uses the global WA_TOKEN secret (test number).
  credential_source     text not null default 'vault' check (credential_source in ('vault', 'platform_env')),
  vault_secret_id       uuid,
  status                text not null default 'pending'
                          check (status in ('pending', 'connected', 'disconnected', 'revoked', 'error')),
  onboarding_method     text not null default 'manual' check (onboarding_method in ('manual', 'embedded_signup', 'legacy')),
  coexistence           text not null default 'unknown' check (coexistence in ('unknown', 'eligible', 'active', 'not_eligible')),
  token_expires_at      timestamptz,
  token_rotated_at      timestamptz,
  last_webhook_at       timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Lets other tables reference (connection, tenant) together, so a row can never name a
  -- connection that belongs to another tenant.
  constraint whatsapp_connections_id_tenant_key unique (id, tenant_id)
);
-- A phone number id can belong to exactly one connection on the whole platform.
create unique index if not exists whatsapp_connections_phone_number_id_key
  on public.whatsapp_connections (phone_number_id) where phone_number_id is not null;
-- Only one connection may use the global WA_TOKEN secret.
create unique index if not exists whatsapp_connections_single_platform_env
  on public.whatsapp_connections (credential_source) where credential_source = 'platform_env';
create index if not exists whatsapp_connections_tenant_idx on public.whatsapp_connections (tenant_id);

-- Insert-only record of administrative operations. Never contains secrets.
create table if not exists public.audit_logs (
  id              bigint generated always as identity primary key,
  tenant_id       uuid references public.tenants (id) on delete set null,
  actor_user_id   uuid,
  actor_staff_id  text,
  action          text not null check (char_length(action) between 1 and 80),
  target          text,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_tenant_idx on public.audit_logs (tenant_id, created_at desc);

-- One row per webhook change set that reached us: routing outcome only, never message content.
create table if not exists public.webhook_events (
  id               bigint generated always as identity primary key,
  received_at      timestamptz not null default now(),
  phone_number_id  text,
  waba_id          text,
  field            text,
  connection_id    uuid references public.whatsapp_connections (id) on delete set null,
  outcome          text not null check (outcome in ('routed', 'unrouted', 'inactive', 'mismatch', 'error')),
  detail           text
);
create index if not exists webhook_events_received_idx on public.webhook_events (received_at desc);
create index if not exists webhook_events_connection_idx on public.webhook_events (connection_id, received_at desc);

-- FCM registration tokens (the push sender is added with the notification phase).
create table if not exists public.push_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.staff (user_id) on delete cascade,
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  fcm_token     text not null unique check (char_length(fcm_token) between 20 and 4096),
  platform      text not null default 'android' check (platform in ('android', 'ios', 'web')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index if not exists push_devices_user_idx on public.push_devices (user_id);

-- ---------------------------------------------------------------------------------------------
-- Tenant helpers (single source of truth for "which tenant is this login in?")
-- ---------------------------------------------------------------------------------------------

-- The tenant(s) of the logged-in user. Empty when the login is disabled, has no membership, or its
-- tenant is suspended. Always derived from the database, never from anything the client sends.
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

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t from public.current_tenant_ids() as t limit 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- New columns on the existing tables (nullable here; made NOT NULL after the backfill below)
-- ---------------------------------------------------------------------------------------------

alter table public.conversations add column if not exists tenant_id uuid;
alter table public.conversations add column if not exists connection_id uuid;
alter table public.wa_messages   add column if not exists tenant_id uuid;
alter table public.quick_replies add column if not exists tenant_id uuid;

-- ---------------------------------------------------------------------------------------------
-- "Owner (test)" tenant: adopts everything that exists today
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_tenant uuid;
  v_conn   uuid;
begin
  select id into v_tenant from public.tenants where slug = 'owner-test';
  if v_tenant is null then
    insert into public.tenants (slug, name) values ('owner-test', 'Owner (test)') returning id into v_tenant;
  end if;

  -- Every existing login joins the tenant (the platform admin as owner).
  insert into public.tenant_memberships (tenant_id, user_id, role)
  select v_tenant, s.user_id, case when s.role = 'admin' then 'owner' else 'agent' end
    from public.staff s
   where not exists (select 1 from public.tenant_memberships m where m.user_id = s.user_id);

  -- The current test number keeps using the global WA_TOKEN / WA_PHONE_ID secrets. Its phone number
  -- id is learned by the first webhook or send that carries it (bind_legacy_connection, part 4), so
  -- no secret has to be read or copied here.
  select id into v_conn from public.whatsapp_connections where credential_source = 'platform_env';
  if v_conn is null then
    insert into public.whatsapp_connections
      (tenant_id, label, credential_source, status, onboarding_method, coexistence)
    values
      (v_tenant, 'Meta test number', 'platform_env', 'connected', 'legacy', 'unknown')
    returning id into v_conn;
  end if;

  update public.conversations set tenant_id = v_tenant, connection_id = v_conn where tenant_id is null;
  update public.wa_messages   set tenant_id = v_tenant where tenant_id is null;
  update public.quick_replies set tenant_id = v_tenant where tenant_id is null;
end $$;

-- >>> supabase/migrations/20261118000100_vault_tokens.sql

-- Multi-tenant foundation, part 2 of 4: per-connection WhatsApp access tokens in Supabase Vault.
--
-- One Vault secret per connection, named wa_conn_<connection id>. The connection row keeps only the
-- secret's id (vault_secret_id). Tokens are encrypted at rest by Vault and can be decrypted ONLY by
-- the three SECURITY DEFINER functions below, which are executable by the service role (Edge
-- Functions) and nobody else. The browser/APK can neither call them nor read the column
-- (see the column grants in part 3).
--
-- Requires the supabase_vault extension (enabled by default on Supabase projects and in the local stack).

create extension if not exists supabase_vault with schema vault;

-- Stores or replaces (rotates) the token of a connection.
create or replace function public.store_connection_token(
  p_connection_id uuid,
  p_token         text,
  p_expires_at    timestamptz default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
  v_source text;
begin
  if p_token is null or char_length(p_token) not between 20 and 2048 then
    raise exception 'token has an invalid length' using errcode = '22023';
  end if;

  select c.vault_secret_id, c.credential_source into v_secret, v_source
    from public.whatsapp_connections c
   where c.id = p_connection_id
     for update;
  if not found then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;
  if v_source <> 'vault' then
    raise exception 'this connection does not use Vault' using errcode = '22023';
  end if;

  if v_secret is null then
    v_secret := vault.create_secret(p_token, 'wa_conn_' || p_connection_id::text, 'WhatsApp access token');
  else
    perform vault.update_secret(v_secret, p_token);
  end if;

  update public.whatsapp_connections
     set vault_secret_id  = v_secret,
         token_expires_at = p_expires_at,
         token_rotated_at = now(),
         last_error       = null,
         updated_at       = now()
   where id = p_connection_id;
end $$;

-- Returns the decrypted token, or null when the connection has none (or is not a Vault connection).
create or replace function public.get_connection_token(p_connection_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select s.decrypted_secret into v_token
    from public.whatsapp_connections c
    join vault.decrypted_secrets s on s.id = c.vault_secret_id
   where c.id = p_connection_id
     and c.credential_source = 'vault'
     and c.status not in ('revoked');
  return v_token;
end $$;

-- Deletes the secret (revocation / disconnection). The connection stays, without a token.
create or replace function public.revoke_connection_token(p_connection_id uuid, p_status text default 'revoked')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  if p_status not in ('disconnected', 'revoked') then
    raise exception 'status must be disconnected or revoked' using errcode = '22023';
  end if;
  select c.vault_secret_id into v_secret from public.whatsapp_connections c where c.id = p_connection_id for update;
  if not found then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
  update public.whatsapp_connections
     set vault_secret_id = null, status = p_status, token_expires_at = null, updated_at = now()
   where id = p_connection_id;
end $$;

revoke all on function public.store_connection_token(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.get_connection_token(uuid)                      from public, anon, authenticated;
revoke all on function public.revoke_connection_token(uuid, text)              from public, anon, authenticated;
grant execute on function public.store_connection_token(uuid, text, timestamptz) to service_role;
grant execute on function public.get_connection_token(uuid)                      to service_role;
grant execute on function public.revoke_connection_token(uuid, text)              to service_role;

-- Direct access to the Vault tables. The platform itself grants service_role SELECT on
-- vault.decrypted_secrets, and only the platform role supabase_admin (not available to migrations)
-- could change that, so this migration does NOT pretend to restrict it. The protections that do hold:
--   * the vault schema is not exposed through the REST API (config.toml [api] schemas = ["public"]),
--   * anon and authenticated have no privilege on it,
--   * the application only reaches tokens through the three functions above,
--   * the service-role key exists only inside Edge Functions and the platform, never in a browser or APK.
-- Anyone holding the service-role key is therefore inside the trust boundary (documented in
-- docs/MULTI_TENANT_SECURITY.md).

-- >>> supabase/migrations/20261118000200_tenant_isolation.sql

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

-- >>> supabase/migrations/20261118000300_routing_admin.sql

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

-- >>> supabase/migrations/20261119000000_password_change_enforcement.sql

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

-- >>> supabase/migrations/20261119000100_webhook_quarantine.sql

-- Phase 2.1, part 2 of 2: webhook routing without silent loss (review finding F8, plus F3 retention).
--
-- Problem: an event whose Phone Number ID matched no connection (or whose WABA id did not match, or whose connection
-- was disconnected or suspended) was acknowledged with 200 and discarded, leaving only a ledger row. With a wrong or
-- missing WA_PHONE_ID the legacy test number would have lost every message that way, invisibly.
--
-- Fix: such events are QUARANTINED, not dropped:
--   * the single change set is kept in public.webhook_quarantine, readable ONLY by the service role (it contains
--     customer data); neither clients nor the platform admin can select it,
--   * every event gets an event_id that is also in the routing ledger together with a machine-readable reason,
--   * after the routing problem is fixed an admin can replay the quarantined events through the normal path
--     (webhook-replay function); the stored payload is erased as soon as the replay succeeds,
--   * quarantined payloads expire after 7 days and ledger rows after 30 days (purge_expired_webhook_data),
--   * admin_routing_diagnostics() shows counts, reasons, unknown Phone Number IDs and connection health:
--     metadata only, never message text, customer numbers or payloads.
-- If the quarantine itself cannot be written the webhook answers 500, so Meta retries instead of the event being lost.
--
-- Additive and idempotent.

-- ---------------------------------------------------------------------------------------------
-- Quarantine table (service role only)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.webhook_quarantine (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null,
  received_at       timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '7 days'),
  phone_number_id   text,
  waba_id           text,
  field             text not null,
  reason            text not null check (reason in (
                      'no_phone_number_id', 'unknown_phone_number_id', 'waba_mismatch',
                      'connection_inactive', 'tenant_suspended', 'legacy_bind_failed')),
  -- The change set exactly as Meta sent it (customer data). Erased after a successful replay.
  payload           jsonb,
  replay_attempts   integer not null default 0,
  replayed_at       timestamptz,
  last_replay_error text
);
create index if not exists webhook_quarantine_pending_idx
  on public.webhook_quarantine (phone_number_id, received_at) where replayed_at is null;
create index if not exists webhook_quarantine_expires_idx on public.webhook_quarantine (expires_at);

alter table public.webhook_quarantine enable row level security;      -- and no policy at all
revoke all on public.webhook_quarantine from anon, authenticated;
grant all on public.webhook_quarantine to service_role;

-- ---------------------------------------------------------------------------------------------
-- Ledger: correlate with the event, say why
-- ---------------------------------------------------------------------------------------------

alter table public.webhook_events add column if not exists event_id uuid;
alter table public.webhook_events add column if not exists reason text;
alter table public.webhook_events add column if not exists quarantine_id uuid;
create index if not exists webhook_events_reason_idx on public.webhook_events (reason, received_at desc);

drop function if exists public.record_webhook_event(text, text, text, uuid, text, text);

create or replace function public.record_webhook_event(
  p_phone_number_id text, p_waba_id text, p_field text, p_connection_id uuid, p_outcome text, p_detail text default null,
  p_event_id uuid default null, p_reason text default null, p_quarantine_id uuid default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.webhook_events (phone_number_id, waba_id, field, connection_id, outcome, detail, event_id, reason, quarantine_id)
  values (left(p_phone_number_id, 64), left(p_waba_id, 64), left(p_field, 64), p_connection_id, p_outcome, left(p_detail, 200),
          p_event_id, left(p_reason, 64), p_quarantine_id);
  if p_connection_id is not null and p_outcome = 'routed' then
    update public.whatsapp_connections set last_webhook_at = now() where id = p_connection_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Quarantine operations (service role only)
-- ---------------------------------------------------------------------------------------------

create or replace function public.quarantine_webhook_change(
  p_event_id uuid, p_phone_number_id text, p_waba_id text, p_field text, p_reason text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  -- A flood of unroutable events must not grow the table without limit: refuse (the webhook then answers 500 and
  -- Meta retries) rather than drop.
  if (select count(*) from public.webhook_quarantine where replayed_at is null) >= 20000 then
    raise exception 'webhook quarantine is full' using errcode = '53400';
  end if;
  insert into public.webhook_quarantine (event_id, phone_number_id, waba_id, field, reason, payload)
  values (p_event_id, left(p_phone_number_id, 64), left(p_waba_id, 64), left(coalesce(p_field, 'unknown'), 64), p_reason, p_payload)
  returning id into v_id;
  return v_id;
end $$;

-- Picks up pending events of one Phone Number ID for a replay and counts the attempt.
create or replace function public.claim_quarantine(p_phone_number_id text, p_limit integer default 100)
returns table (id uuid, event_id uuid, waba_id text, field text, payload jsonb, replay_attempts integer)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with picked as (
    select q.id from public.webhook_quarantine q
     where q.phone_number_id = p_phone_number_id and q.replayed_at is null and q.payload is not null and q.expires_at > now()
     order by q.received_at
     limit least(greatest(coalesce(p_limit, 100), 1), 500)
       for update skip locked
  )
  update public.webhook_quarantine q
     set replay_attempts = q.replay_attempts + 1
    from picked
   where q.id = picked.id
  returning q.id, q.event_id, q.waba_id, q.field, q.payload, q.replay_attempts;
end $$;

create or replace function public.finish_quarantine_replay(p_id uuid, p_success boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_success then
    -- the customer data is erased as soon as it has been processed
    update public.webhook_quarantine set replayed_at = now(), payload = null, last_replay_error = null where id = p_id;
  else
    update public.webhook_quarantine set last_replay_error = left(p_error, 200) where id = p_id;
  end if;
end $$;

create or replace function public.purge_expired_webhook_data(
  p_quarantine_older_than interval default interval '7 days',
  p_events_older_than interval default interval '30 days'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_q bigint; v_e bigint;
begin
  delete from public.webhook_quarantine
   where expires_at < now() or received_at < now() - p_quarantine_older_than;
  get diagnostics v_q = row_count;
  delete from public.webhook_events where received_at < now() - p_events_older_than;
  get diagnostics v_e = row_count;
  return jsonb_build_object('quarantine_deleted', v_q, 'events_deleted', v_e);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Diagnostics for the platform admin: metadata only
-- ---------------------------------------------------------------------------------------------

create or replace function public.admin_routing_diagnostics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select jsonb_build_object(
    'generated_at', now(),
    'window_hours', 24,
    'outcomes_24h', (select coalesce(jsonb_object_agg(outcome, n), '{}'::jsonb)
                       from (select outcome, count(*) as n from public.webhook_events
                              where received_at > now() - interval '24 hours' group by outcome) o),
    'reasons_24h', (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb)
                      from (select reason, count(*) as n from public.webhook_events
                             where reason is not null and received_at > now() - interval '24 hours' group by reason) r),
    'unrouted_phone_numbers', (select coalesce(jsonb_agg(u order by u.last_seen desc), '[]'::jsonb) from (
                                 select q.phone_number_id,
                                        count(*) as events,
                                        min(q.received_at) as first_seen,
                                        max(q.received_at) as last_seen,
                                        count(*) filter (where q.replayed_at is null and q.payload is not null) as pending,
                                        array_agg(distinct q.reason) as reasons
                                   from public.webhook_quarantine q
                                  where q.received_at > now() - interval '7 days'
                                  group by q.phone_number_id
                                  order by max(q.received_at) desc
                                  limit 20) u),
    'quarantine', jsonb_build_object(
        'pending', (select count(*) from public.webhook_quarantine where replayed_at is null and payload is not null),
        'oldest_pending_seconds', (select extract(epoch from now() - min(received_at))::bigint
                                     from public.webhook_quarantine where replayed_at is null and payload is not null),
        'replayed_24h', (select count(*) from public.webhook_quarantine where replayed_at > now() - interval '24 hours'),
        'expiring_within_24h', (select count(*) from public.webhook_quarantine
                                  where replayed_at is null and payload is not null and expires_at < now() + interval '24 hours')),
    'connections', jsonb_build_object(
        'legacy_unbound', exists (select 1 from public.whatsapp_connections c
                                   where c.credential_source = 'platform_env' and c.phone_number_id is null),
        'without_phone_number_id', (select count(*) from public.whatsapp_connections c where c.phone_number_id is null),
        'connected_without_webhook_7d', (select count(*) from public.whatsapp_connections c
                                          where c.status = 'connected'
                                            and (c.last_webhook_at is null or c.last_webhook_at < now() - interval '7 days'))),
    'retention', jsonb_build_object('quarantine_days', 7, 'ledger_days', 30)
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function public.record_webhook_event(text, text, text, uuid, text, text, uuid, text, uuid),
                       public.quarantine_webhook_change(uuid, text, text, text, text, jsonb),
                       public.claim_quarantine(text, integer),
                       public.finish_quarantine_replay(uuid, boolean, text),
                       public.purge_expired_webhook_data(interval, interval)
  from public, anon, authenticated;
grant execute on function public.record_webhook_event(text, text, text, uuid, text, text, uuid, text, uuid),
                          public.quarantine_webhook_change(uuid, text, text, text, text, jsonb),
                          public.claim_quarantine(text, integer),
                          public.finish_quarantine_replay(uuid, boolean, text),
                          public.purge_expired_webhook_data(interval, interval)
  to service_role;

revoke all on function public.admin_routing_diagnostics() from public, anon;
grant execute on function public.admin_routing_diagnostics() to authenticated;

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

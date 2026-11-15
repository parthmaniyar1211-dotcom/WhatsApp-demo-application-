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

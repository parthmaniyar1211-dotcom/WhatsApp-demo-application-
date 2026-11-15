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

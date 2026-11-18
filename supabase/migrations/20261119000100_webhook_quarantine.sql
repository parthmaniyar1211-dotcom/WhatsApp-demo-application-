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

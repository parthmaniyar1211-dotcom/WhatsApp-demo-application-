-- Phase 2.1 security regression tests (F1: mandatory password change enforced by the database;
-- F8: webhook quarantine, ledger and diagnostics). Run against the LOCAL database only:
--   psql ... -f supabase/tests/phase21_security.sql
-- One transaction, rolled back at the end: no data is left behind.

\set ON_ERROR_STOP on
\o /dev/null
begin;

create temp table results (name text, ok boolean) on commit drop;
grant all on results to public;

create or replace function pg_temp.pass(p_name text, p_ok boolean) returns void language plpgsql as $$
begin insert into results values (p_name, coalesce(p_ok, false)); end $$;
create or replace function pg_temp.raises(p_sql text, p_code text default null) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return p_code is null or sqlstate = p_code;
end $$;
create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  set local role authenticated;
end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
end $$;
grant execute on function pg_temp.pass(text, boolean), pg_temp.raises(text, text), pg_temp.as_user(uuid),
                          pg_temp.as_anon(), pg_temp.as_service() to public;

-- ---------------------------------------------------------------------------------------------
-- Fixtures: tenant A (login still on a temporary password), tenant B (normal login), a normal platform admin,
-- a platform admin who still has a temporary password.
-- ---------------------------------------------------------------------------------------------
create temp table ids as
  select gen_random_uuid() as ua, gen_random_uuid() as ub, gen_random_uuid() as uadm, gen_random_uuid() as uadmtmp,
         gen_random_uuid() as ta, gen_random_uuid() as tb, gen_random_uuid() as ca, gen_random_uuid() as cb,
         gen_random_uuid() as conv_a, gen_random_uuid() as m_a, gen_random_uuid() as conv_b, gen_random_uuid() as unew;
grant all on ids to public;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'p21_' || left(u::text, 8) || '@test.invalid', now(), now()
    from ids, unnest(array[ua, ub, uadm, uadmtmp, unew]) as u;
insert into public.staff (user_id, staff_id, display_name, role, must_change_password)
  select ua, 'P21A1', 'A temp', 'staff', true from ids union all
  select ub, 'P21B1', 'B', 'staff', false from ids union all
  select uadm, 'P21ADM', 'Admin', 'admin', false from ids union all
  select uadmtmp, 'P21ADT', 'Admin temp', 'admin', true from ids;
insert into public.tenants (id, slug, name) select ta, 'p21-a', 'P21 A' from ids union all select tb, 'p21-b', 'P21 B' from ids;
insert into public.tenant_memberships (tenant_id, user_id, role) select ta, ua, 'owner' from ids union all select tb, ub, 'owner' from ids;
insert into public.whatsapp_connections (id, tenant_id, label, phone_number_id, waba_id, status)
  select ca, ta, 'A', 'P21_PHONE_A', 'P21_WABA_A', 'connected' from ids union all
  select cb, tb, 'B', 'P21_PHONE_B', 'P21_WABA_B', 'connected' from ids;
insert into public.conversations (id, tenant_id, connection_id, wa_id, contact_name, last_inbound_at)
  select conv_a, ta, ca, '19990000021', 'A customer', now() from ids union all
  select conv_b, tb, cb, '19990000022', 'B customer', now() from ids;
insert into public.wa_messages (id, tenant_id, conversation_id, wa_message_id, direction, type, body, status, media_path)
  select m_a, ta, conv_a, 'wamid.P21.A', 'in', 'document', 'a body', 'received', 'incoming/19990000021/p21-a.pdf' from ids;
insert into public.quick_replies (tenant_id, shortcut, body) select ta, 'p21', 'A snippet' from ids;
insert into storage.objects (bucket_id, name) values ('files', 'incoming/19990000021/p21-a.pdf');

-- ---------------------------------------------------------------------------------------------
-- F1. A login on a temporary password sees and does nothing
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user(ua) from ids;
select pg_temp.pass('F1: temporary-password login reads no conversations, messages, quick replies, connections, tenants or memberships',
  (select count(*) = 0 from public.conversations) and (select count(*) = 0 from public.wa_messages)
  and (select count(*) = 0 from public.quick_replies) and (select count(*) = 0 from public.whatsapp_connections)
  and (select count(*) = 0 from public.tenants) and (select count(*) = 0 from public.tenant_memberships));
select pg_temp.pass('F1: it can still read its OWN staff row, including the flag (the app needs it to show the change screen)',
  (select count(*) = 1 and bool_and(must_change_password) from public.staff));
select pg_temp.pass('F1: it cannot read other staff',
  (select count(*) = 0 from public.staff where staff_id <> 'P21A1'));
select pg_temp.pass('F1: unread_counts, search and last-message previews return nothing',
  (select count(*) = 0 from public.unread_counts()) and (select count(*) = 0 from public.search_messages('body'))
  and (select count(*) = 0 from public.visible_last_messages()));
select pg_temp.pass('F1: every client RPC is refused (42501)',
  pg_temp.raises('select public.start_conversation(''19990000555'', null)', '42501')
  and pg_temp.raises(format('select public.mark_conversation_read(%L)', (select conv_a from ids)), '42501')
  and pg_temp.raises(format('select public.delete_message_for_me(%L)', (select m_a from ids)), '42501')
  and pg_temp.raises(format('select public.set_message_flags(%L, true, false)', (select m_a from ids)), '42501')
  and pg_temp.raises(format('select public.rename_contact(%L, ''x'')', (select conv_a from ids)), '42501')
  and pg_temp.raises('select public.save_quick_reply(null, ''x'', ''y'')', '42501')
  and pg_temp.raises('select public.register_push_device(repeat(''t'', 40), ''android'')', '42501')
  and pg_temp.raises('select public.unregister_push_device(repeat(''t'', 40))', '42501'));
select pg_temp.pass('F1: storage is closed (no objects visible, upload into its own folder refused)',
  (select count(*) = 0 from storage.objects where bucket_id = 'files')
  and pg_temp.raises(format('insert into storage.objects (bucket_id, name) values (''files'', %L)', 'outgoing/' || (select ua from ids) || '/x.pdf'), '42501'));
select pg_temp.pass('F1: it cannot clear the flag itself (no UPDATE privilege) nor call the service-only functions',
  pg_temp.raises('update public.staff set must_change_password = false', '42501')
  and pg_temp.raises(format('select public.set_must_change_password(%L, false)', (select ua from ids)), '42501')
  and pg_temp.raises('select public.create_client_account(gen_random_uuid(), ''ZZZ'', '''', ''admin'', null, null, ''owner'', false)', '42501'));
select pg_temp.pass('F1: it cannot insert or delete staff rows either',
  pg_temp.raises('insert into public.staff (user_id, staff_id, role) values (gen_random_uuid(), ''HAX1'', ''admin'')', '42501')
  and pg_temp.raises('delete from public.staff', '42501'));

-- the platform admin who still has a temporary password loses the admin powers too
select pg_temp.as_user(uadmtmp) from ids;
select pg_temp.pass('F1: an admin on a temporary password has no admin powers (reports, tenant list, audit, routing diagnostics)',
  pg_temp.raises('select public.admin_overview()', '42501')
  and pg_temp.raises('select * from public.admin_tenant_summary()', '42501')
  and pg_temp.raises('select public.admin_routing_diagnostics()', '42501')
  and pg_temp.raises(format('select public.admin_set_tenant_status(%L, ''suspended'')', (select ta from ids)), '42501')
  and (select count(*) = 0 from public.tenants) and (select count(*) = 0 from public.audit_logs)
  and (select count(*) = 0 from public.webhook_events) and (select count(*) = 0 from public.whatsapp_connections));
select pg_temp.pass('F1: is_admin() and is_active_staff() are false while the flag is set',
  (select not public.is_admin()) and (select not public.is_active_staff()));

-- ---------------------------------------------------------------------------------------------
-- F1. The requirement is live: clearing it opens access at once, setting it closes access at once
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_service();
select public.set_must_change_password((select ua from ids), false);
select pg_temp.as_user(ua) from ids;
select pg_temp.pass('F1: once the server clears the flag the SAME login reads its own tenant (and only its own)',
  (select count(*) = 1 and bool_and(tenant_id = (select ta from ids)) from public.conversations)
  and (select count(*) = 1 from public.wa_messages) and (select count(*) = 1 from storage.objects where bucket_id = 'files')
  and (select count(*) = 0 from public.conversations where id = (select conv_b from ids)));
select pg_temp.pass('F1: and its RPCs work again', not pg_temp.raises(format('select public.mark_conversation_read(%L)', (select conv_a from ids))));
select pg_temp.as_service();
select public.set_must_change_password((select ua from ids), true);   -- an admin resets the password
select pg_temp.as_user(ua) from ids;
select pg_temp.pass('F1: when the flag is set again (admin reset) an EXISTING session is locked out immediately',
  (select count(*) = 0 from public.conversations) and (select count(*) = 0 from public.wa_messages)
  and pg_temp.raises(format('select public.mark_conversation_read(%L)', (select conv_a from ids)), '42501'));

-- ---------------------------------------------------------------------------------------------
-- F1. Unaffected: normal logins, the platform admin, and Owner (test)
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user(ub) from ids;
select pg_temp.pass('F1: a normal login (flag false) is unaffected', (select count(*) = 1 from public.conversations) and not (select must_change_password from public.staff where user_id = (select ub from ids)));
select pg_temp.as_user(uadm) from ids;
select pg_temp.pass('F1: a normal platform admin is unaffected', not pg_temp.raises('select public.admin_overview()') and (select count(*) >= 3 from public.tenants));
reset role;
select pg_temp.pass('Owner (test) preserved: the tenant, its legacy connection and every existing login (flag false) are intact',
  exists (select 1 from public.tenants where slug = 'owner-test')
  and exists (select 1 from public.whatsapp_connections c join public.tenants t on t.id = c.tenant_id
               where t.slug = 'owner-test' and c.credential_source = 'platform_env')
  and (select count(*) = 0 from public.staff s join public.tenant_memberships m on m.user_id = s.user_id join public.tenants t on t.id = m.tenant_id
        where t.slug = 'owner-test' and s.must_change_password)
  and (select count(*) > 0 from public.conversations c join public.tenants t on t.id = c.tenant_id where t.slug = 'owner-test'));
select pg_temp.as_service();
create temp table created as select public.create_client_account((select unew from ids), 'P21NEW', 'New admin', 'admin') as j;
grant all on created to public;
select pg_temp.pass('create_client_account sets the requirement to TRUE by default and records it',
  (select (j ->> 'must_change_password')::boolean from created)
  and (select must_change_password from public.staff where staff_id = 'P21NEW'));
reset role;

-- ---------------------------------------------------------------------------------------------
-- F8. Quarantine: access control
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_service();
create temp table q as select public.quarantine_webhook_change(gen_random_uuid(), 'P21_UNKNOWN_PHONE', 'P21_WABA_X', 'messages', 'unknown_phone_number_id',
    jsonb_build_object('messages', jsonb_build_array(jsonb_build_object('from', '919800000099', 'text', jsonb_build_object('body', 'SECRET-CUSTOMER-TEXT')))))::uuid as id;
grant all on q to public;
select pg_temp.as_user(ub) from ids;
select pg_temp.pass('F8: a client cannot read the quarantine (it holds customer data)', pg_temp.raises('select count(*) from public.webhook_quarantine', '42501'));
select pg_temp.as_user(uadm) from ids;
select pg_temp.pass('F8: even the platform admin cannot read quarantined payloads', pg_temp.raises('select payload from public.webhook_quarantine', '42501')
  and pg_temp.raises('select count(*) from public.webhook_quarantine', '42501'));
select pg_temp.as_anon();
select pg_temp.pass('F8: anonymous cannot touch it', pg_temp.raises('select count(*) from public.webhook_quarantine', '42501'));
select pg_temp.as_user(uadm) from ids;
select pg_temp.pass('F8: no client or admin can call the quarantine functions',
  pg_temp.raises('select public.quarantine_webhook_change(gen_random_uuid(), ''x'', null, ''messages'', ''unknown_phone_number_id'', ''{}''::jsonb)', '42501')
  and pg_temp.raises('select * from public.claim_quarantine(''P21_UNKNOWN_PHONE'', 10)', '42501')
  and pg_temp.raises(format('select public.finish_quarantine_replay(%L, true, null)', (select id from q)), '42501')
  and pg_temp.raises('select public.purge_expired_webhook_data()', '42501'));

-- ---------------------------------------------------------------------------------------------
-- F8. Quarantine: lifecycle
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_service();
create temp table c1 as select * from public.claim_quarantine('P21_UNKNOWN_PHONE', 10);
grant all on c1 to public;
select pg_temp.pass('F8: claim returns the pending event of that Phone Number ID and counts the attempt',
  (select count(*) = 1 and bool_and(replay_attempts = 1) and bool_and(payload::text like '%SECRET-CUSTOMER-TEXT%') from c1));
select pg_temp.pass('F8: a different Phone Number ID claims nothing', (select count(*) = 0 from public.claim_quarantine('P21_OTHER_PHONE', 10)));
select public.finish_quarantine_replay((select id from q), false, 'still no connection');
select pg_temp.pass('F8: a failed replay keeps the payload and records why', (select payload is not null and last_replay_error = 'still no connection' and replayed_at is null from public.webhook_quarantine where id = (select id from q)));
select public.finish_quarantine_replay((select id from q), true, null);
select pg_temp.pass('F8: a successful replay ERASES the customer data and marks the event replayed',
  (select payload is null and replayed_at is not null from public.webhook_quarantine where id = (select id from q))
  and (select count(*) = 0 from public.claim_quarantine('P21_UNKNOWN_PHONE', 10)));
-- an expired pending event is never claimed, and is removed by the purge
reset role;
insert into public.webhook_quarantine (event_id, phone_number_id, field, reason, payload, received_at, expires_at)
  values (gen_random_uuid(), 'P21_EXPIRED', 'messages', 'unknown_phone_number_id', '{"x":1}'::jsonb, now() - interval '9 days', now() - interval '2 days');
select pg_temp.as_service();
select pg_temp.pass('F8: an expired event is not claimed', (select count(*) = 0 from public.claim_quarantine('P21_EXPIRED', 10)));

-- the quarantine refuses to grow without limit (the webhook then answers 500 and Meta retries)
reset role;
insert into public.webhook_quarantine (event_id, phone_number_id, field, reason, payload)
  select gen_random_uuid(), 'P21_FLOOD', 'messages', 'unknown_phone_number_id', '{"x":1}'::jsonb from generate_series(1, 20000);
select pg_temp.as_service();
select pg_temp.pass('F8: when the quarantine is full a new event is REFUSED (53400), not dropped',
  pg_temp.raises('select public.quarantine_webhook_change(gen_random_uuid(), ''P21_FLOOD2'', null, ''messages'', ''unknown_phone_number_id'', ''{}''::jsonb)', '53400'));
reset role;
delete from public.webhook_quarantine where phone_number_id = 'P21_FLOOD';

-- ---------------------------------------------------------------------------------------------
-- F8. Ledger and retention
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_service();
select public.record_webhook_event('P21_PHONE_A', 'P21_WABA_A', 'messages', (select ca from ids), 'routed', 'ok', gen_random_uuid(), null, null);
select public.record_webhook_event('P21_UNKNOWN2', null, 'messages', null, 'unrouted', 'no connection', '11111111-1111-4111-8111-111111111111', 'unknown_phone_number_id', (select id from q));
select public.record_webhook_event('P21_PHONE_A', 'P21_WABA_A', 'messages', (select ca from ids), 'routed', 'old style call without the new arguments');
select pg_temp.pass('F8: the ledger stores event id, reason and quarantine id; the old six-argument call still works',
  (select event_id = '11111111-1111-4111-8111-111111111111' and reason = 'unknown_phone_number_id' and quarantine_id = (select id from q)
     from public.webhook_events where phone_number_id = 'P21_UNKNOWN2')
  and (select count(*) = 2 from public.webhook_events where phone_number_id = 'P21_PHONE_A' and outcome = 'routed')
  and (select last_webhook_at is not null from public.whatsapp_connections where id = (select ca from ids)));
reset role;
insert into public.webhook_events (phone_number_id, field, outcome, received_at) values ('P21_OLD_EVENT', 'messages', 'routed', now() - interval '45 days');
insert into public.webhook_quarantine (event_id, phone_number_id, field, reason, payload, received_at, expires_at)
  values (gen_random_uuid(), 'P21_OLD_Q', 'messages', 'unknown_phone_number_id', '{"x":1}'::jsonb, now() - interval '8 days', now() + interval '1 day');
select pg_temp.as_service();
create temp table purged as select public.purge_expired_webhook_data() as j;
grant all on purged to public;
select pg_temp.pass('F8: retention purge removes quarantined payloads older than 7 days and ledger rows older than 30 days, keeps fresh ones',
  (select (j ->> 'quarantine_deleted')::int >= 2 and (j ->> 'events_deleted')::int >= 1 from purged)
  and (select count(*) = 0 from public.webhook_quarantine where phone_number_id in ('P21_OLD_Q', 'P21_EXPIRED'))
  and (select count(*) = 0 from public.webhook_events where phone_number_id = 'P21_OLD_EVENT')
  and (select count(*) = 2 from public.webhook_events where phone_number_id = 'P21_PHONE_A'));

-- ---------------------------------------------------------------------------------------------
-- F8. Diagnostics: metadata only
-- ---------------------------------------------------------------------------------------------
reset role;
insert into public.webhook_quarantine (event_id, phone_number_id, field, reason, payload)
  values (gen_random_uuid(), 'P21_UNKNOWN2', 'messages', 'unknown_phone_number_id',
          jsonb_build_object('messages', jsonb_build_array(jsonb_build_object('from', '919800000099', 'text', jsonb_build_object('body', 'SECRET-CUSTOMER-TEXT')))));
update public.whatsapp_connections set phone_number_id = null where credential_source = 'platform_env';
select pg_temp.as_user(uadm) from ids;
create temp table diag as select public.admin_routing_diagnostics() as j;
grant all on diag to public;
select pg_temp.pass('F8: diagnostics list the unknown Phone Number ID with its pending event count and reason',
  (select exists (select 1 from jsonb_array_elements(j -> 'unrouted_phone_numbers') e
                   where e ->> 'phone_number_id' = 'P21_UNKNOWN2' and (e ->> 'pending')::int >= 1
                     and e -> 'reasons' @> '"unknown_phone_number_id"') from diag));
select pg_temp.pass('F8: diagnostics NEVER contain message text, customer numbers or payloads',
  (select j::text not like '%SECRET-CUSTOMER-TEXT%' and j::text not like '%919800000099%' and j::text not like '%"payload"%' from diag));
select pg_temp.pass('F8: diagnostics report an unbound legacy connection (the exact F8 failure) and the retention windows',
  (select (j -> 'connections' ->> 'legacy_unbound')::boolean and (j -> 'retention' ->> 'quarantine_days')::int = 7
          and (j -> 'quarantine' ->> 'pending')::int >= 1 and (j -> 'outcomes_24h' ->> 'routed')::int >= 2 from diag));
select pg_temp.as_service();
select public.bind_legacy_connection('P21_LEGACY_PHONE', 'P21_LEGACY_WABA');
select pg_temp.as_user(uadm) from ids;
select pg_temp.pass('F8: once the legacy connection is bound the warning clears',
  (select not (public.admin_routing_diagnostics() -> 'connections' ->> 'legacy_unbound')::boolean));
select pg_temp.as_user(ub) from ids;
select pg_temp.pass('F8: clients cannot read the routing diagnostics', pg_temp.raises('select public.admin_routing_diagnostics()', '42501'));
select pg_temp.as_anon();
select pg_temp.pass('F8: anonymous cannot read the routing diagnostics', pg_temp.raises('select public.admin_routing_diagnostics()', '42501'));

-- ---------------------------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------------------------
reset role;
select pg_temp.pass('every public table still has row level security (including the new quarantine table)',
  (select count(*) = 0 from pg_tables t where t.schemaname = 'public' and not t.rowsecurity));
select pg_temp.pass('the new Phase 2.1 functions are not executable by anon, and the service-only ones not by authenticated',
  not has_function_privilege('anon', 'public.set_must_change_password(uuid, boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.set_must_change_password(uuid, boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_quarantine(text, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.quarantine_webhook_change(uuid, text, text, text, text, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_routing_diagnostics()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.admin_routing_diagnostics()', 'EXECUTE'));
select pg_temp.pass('no new SECURITY DEFINER function lacks a pinned search_path',
  (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')));

-- ---------------------------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------------------------
reset role;
\o
select case when ok then 'PASS' else 'FAIL' end as result, name from results order by 1 desc, 2;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from results;
do $$
begin
  if exists (select 1 from results where not ok) then
    raise exception 'SQL tests FAILED';
  end if;
end $$;
rollback;

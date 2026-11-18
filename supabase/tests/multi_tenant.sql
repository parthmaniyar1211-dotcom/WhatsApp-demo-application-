-- Multi-tenant isolation tests. Run against the LOCAL database only:
--   npm run test:sql
-- Everything happens inside one transaction that is rolled back at the end: no data is left behind.
-- Logins are simulated the way PostgREST does it (role + request.jwt.claims), so row level security,
-- column grants and function privileges are exercised exactly as an app user or the Edge Functions see them.
--
-- Cast: tenant A and tenant B (each with a staff login and a WhatsApp connection), a staff login whose
-- account is disabled, one whose membership is disabled, one in a suspended tenant, one in a tenant
-- without a connection, one without any tenant (outsider), and a platform admin with no tenant.

\set ON_ERROR_STOP on
\o /dev/null
begin;

create temp table results (name text, ok boolean) on commit drop;
grant all on results to public;

create or replace function pg_temp.pass(p_name text, p_ok boolean) returns void language plpgsql as $$
begin insert into results values (p_name, coalesce(p_ok, false)); end $$;

-- True when the statement raises an error with this SQLSTATE (or any error when p_code is null).
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
-- Fixtures
-- ---------------------------------------------------------------------------------------------
create temp table ids as
  select gen_random_uuid() as ua, gen_random_uuid() as ub, gen_random_uuid() as ud, gen_random_uuid() as um,
         gen_random_uuid() as us, gen_random_uuid() as ue, gen_random_uuid() as uo, gen_random_uuid() as uadm,
         gen_random_uuid() as ta, gen_random_uuid() as tb, gen_random_uuid() as ts, gen_random_uuid() as te,
         gen_random_uuid() as ca, gen_random_uuid() as cb, gen_random_uuid() as cs,
         gen_random_uuid() as conv_a, gen_random_uuid() as conv_b,
         gen_random_uuid() as m_a_in, gen_random_uuid() as m_a_out, gen_random_uuid() as m_b_in,
         gen_random_uuid() as qr_a, gen_random_uuid() as qr_b;
grant all on ids to public;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sqlt_' || left(u::text, 8) || '@test.invalid', now(), now()
    from ids, unnest(array[ua, ub, ud, um, us, ue, uo, uadm]) as u;

insert into public.staff (user_id, staff_id, display_name, role, disabled)
  select ua, 'SQLTA1', 'A', 'staff', false from ids union all
  select ub, 'SQLTB1', 'B', 'staff', false from ids union all
  select ud, 'SQLTD1', 'D', 'staff', true  from ids union all
  select um, 'SQLTM1', 'M', 'staff', false from ids union all
  select us, 'SQLTS1', 'S', 'staff', false from ids union all
  select ue, 'SQLTE1', 'E', 'staff', false from ids union all
  select uo, 'SQLTO1', 'O', 'staff', false from ids union all
  select uadm, 'SQLTADM', 'Admin', 'admin', false from ids;

insert into public.tenants (id, slug, name, status)
  select ta, 'sqlt-a', 'Tenant A', 'active' from ids union all
  select tb, 'sqlt-b', 'Tenant B', 'active' from ids union all
  select ts, 'sqlt-s', 'Tenant S (suspended)', 'suspended' from ids union all
  select te, 'sqlt-e', 'Tenant E (no connection)', 'active' from ids;

insert into public.tenant_memberships (tenant_id, user_id, role, disabled)
  select ta, ua, 'owner', false from ids union all
  select ta, ud, 'agent', false from ids union all       -- same tenant as A, but the account is disabled
  select tb, ub, 'owner', false from ids union all
  select tb, um, 'agent', true from ids union all        -- membership disabled
  select ts, us, 'owner', false from ids union all
  select te, ue, 'owner', false from ids;                -- uo and uadm: no tenant

insert into public.whatsapp_connections (id, tenant_id, label, phone_number_id, waba_id, status)
  select ca, ta, 'A number', 'SQLT_PHONE_A', 'SQLT_WABA_A', 'connected' from ids union all
  select cb, tb, 'B number', 'SQLT_PHONE_B', 'SQLT_WABA_B', 'connected' from ids union all
  select cs, ts, 'S number', 'SQLT_PHONE_S', 'SQLT_WABA_S', 'connected' from ids;

-- The SAME customer phone number exists under tenant A and under tenant B.
insert into public.conversations (id, tenant_id, connection_id, wa_id, contact_name, last_message_at, last_message_preview, last_inbound_at)
  select conv_a, ta, ca, '19990000001', 'Customer of A', now(), 'a-secret-text', now() from ids union all
  select conv_b, tb, cb, '19990000001', 'Customer of B', now(), 'b-secret-text', now() from ids;
insert into public.wa_messages (id, tenant_id, conversation_id, wa_message_id, direction, type, body, status, created_at, media_path, media_mime, media_filename)
  select m_a_in,  ta, conv_a, 'wamid.SQLT.A.IN',  'in',  'text',     'a-secret-text', 'received', now() - interval '3 min', null, null, null from ids union all
  select m_a_out, ta, conv_a, 'wamid.SQLT.A.OUT', 'out', 'document', 'a-doc',         'sent',     now() - interval '2 min', 'incoming/19990000001/sqlt-a.pdf', 'application/pdf', 'a.pdf' from ids union all
  select m_b_in,  tb, conv_b, 'wamid.SQLT.B.IN',  'in',  'document', 'b-secret-text', 'received', now() - interval '1 min', 'incoming/19990000001/sqlt-b.pdf', 'application/pdf', 'b.pdf' from ids;
insert into public.quick_replies (id, tenant_id, shortcut, body)
  select qr_a, ta, 'hello', 'Hello from A' from ids union all
  select qr_b, tb, 'hello', 'Hello from B' from ids;   -- same shortcut under two tenants is allowed
insert into storage.objects (bucket_id, name)
  values ('files', 'incoming/19990000001/sqlt-a.pdf'), ('files', 'incoming/19990000001/sqlt-b.pdf');
insert into public.audit_logs (tenant_id, action, target) select ta, 'sqlt.seed', 'x' from ids;
insert into public.webhook_events (phone_number_id, field, outcome) values ('SQLT_UNKNOWN', 'messages', 'unrouted');

-- Snapshot of tenant B's data, to prove nothing of it changes during the attacks below.
create temp table b_before as
  select 'conv' as k, md5(c::text) as h from public.conversations c where c.id = (select conv_b from ids)
  union all select 'msg', md5(m::text) from public.wa_messages m where m.id = (select m_b_in from ids)
  union all select 'qr', md5(q::text) from public.quick_replies q where q.id = (select qr_b from ids);
grant all on b_before to public;

-- ---------------------------------------------------------------------------------------------
-- 1. Reads: each login sees only its own tenant
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user(ua) from ids;
select pg_temp.pass('A reads only tenant A conversations',
  (select count(*) = 1 and bool_and(tenant_id = (select ta from ids)) from public.conversations where wa_id = '19990000001'));
select pg_temp.pass('A cannot read tenant B conversation by id', (select count(*) = 0 from public.conversations c where c.id = (select conv_b from ids)));
select pg_temp.pass('A reads only tenant A messages', (select count(*) = 2 from public.wa_messages where tenant_id = (select ta from ids)) and (select count(*) = 0 from public.wa_messages where tenant_id = (select tb from ids)));
select pg_temp.pass('A cannot read tenant B message by id', (select count(*) = 0 from public.wa_messages where id = (select m_b_in from ids)));
select pg_temp.pass('A sees only its own quick reply (same shortcut exists in B)', (select count(*) = 1 and bool_and(body = 'Hello from A') from public.quick_replies where shortcut = 'hello'));
select pg_temp.pass('A sees only its own tenant row', (select count(*) = 1 and bool_and(id = (select ta from ids)) from public.tenants));
select pg_temp.pass('A sees only its own connection', (select count(*) = 1 and bool_and(id = (select ca from ids)) from public.whatsapp_connections));
select pg_temp.pass('A sees only members of its own tenant', (select bool_and(tenant_id = (select ta from ids)) from public.tenant_memberships));
select pg_temp.pass('A sees only staff of its own tenant', (select not bool_or(staff_id in ('SQLTB1', 'SQLTM1', 'SQLTS1', 'SQLTADM')) from public.staff));
select pg_temp.pass('A cannot read the Vault reference column', pg_temp.raises('select vault_secret_id from public.whatsapp_connections', '42501'));
select pg_temp.pass('A cannot read the token rotation column', pg_temp.raises('select token_rotated_at from public.whatsapp_connections', '42501'));
select pg_temp.pass('A cannot use select * on connections (restricted columns)', pg_temp.raises('select * from public.whatsapp_connections', '42501'));
select pg_temp.pass('A cannot read the audit log', (select count(*) = 0 from public.audit_logs));
select pg_temp.pass('A cannot read the webhook ledger', (select count(*) = 0 from public.webhook_events));
select pg_temp.pass('unread_counts shows only tenant A', (select coalesce(bool_and(conversation_id = (select conv_a from ids)), true) from public.unread_counts()));
select pg_temp.pass('search cannot find text that only tenant B has', (select count(*) = 0 from public.search_messages('b-secret-text')));
select pg_temp.pass('search finds own text', (select count(*) = 1 from public.search_messages('a-secret-text')));
select pg_temp.pass('visible_last_messages only returns tenant A chats', (select count(*) = 1 and bool_and(conversation_id = (select conv_a from ids)) from public.visible_last_messages()));
select pg_temp.pass('A sees its own file and not the file of tenant B',
  (select count(*) filter (where name like '%sqlt-a.pdf') = 1 and count(*) filter (where name like '%sqlt-b.pdf') = 0 from storage.objects where bucket_id = 'files'));

-- ---------------------------------------------------------------------------------------------
-- 2. Writes and IDOR attempts by A against tenant B's resources
-- ---------------------------------------------------------------------------------------------
select pg_temp.pass('A: mark_conversation_read on a B conversation is "not found"',
  pg_temp.raises(format('select public.mark_conversation_read(%L)', (select conv_b from ids)), 'P0002'));
select pg_temp.pass('A: delete_message_for_me on a B message is "not found"',
  pg_temp.raises(format('select public.delete_message_for_me(%L)', (select m_b_in from ids)), 'P0002'));
select pg_temp.pass('A: set_message_flags (star) on a B message is "not found"',
  pg_temp.raises(format('select public.set_message_flags(%L, true, false)', (select m_b_in from ids)), 'P0002'));
select public.rename_contact((select conv_b from ids), 'HACKED');
select public.update_conversation_info((select conv_b from ids), 'HACKED NOTE', array['hacked']);
select public.take_conversation((select conv_b from ids));
select public.save_quick_reply((select qr_b from ids), 'hacked', 'HACKED');
select public.delete_quick_reply((select qr_b from ids));
select pg_temp.pass('A: cannot insert into tables directly',
  pg_temp.raises('insert into public.conversations (tenant_id, connection_id, wa_id) select ta, ca, ''1'' from ids', '42501')
  and pg_temp.raises('insert into public.wa_messages (tenant_id, conversation_id, direction, type, status) select ta, conv_a, ''out'', ''text'', ''sent'' from ids', '42501')
  and pg_temp.raises('update public.wa_messages set body = ''x''', '42501')
  and pg_temp.raises('delete from public.conversations', '42501')
  and pg_temp.raises('insert into public.tenant_memberships (tenant_id, user_id) select tb, ua from ids', '42501')
  and pg_temp.raises('update public.tenants set name = ''x''', '42501')
  and pg_temp.raises('update public.whatsapp_connections set status = ''connected''', '42501')
  and pg_temp.raises('insert into public.audit_logs (action) values (''x'')', '42501'));
select pg_temp.pass('A: same shortcut allowed in a different tenant (saved /hello-two and it exists in B too)',
  (select (public.save_quick_reply(null, 'shared', 'A shared')).tenant_id = (select ta from ids)));
select pg_temp.pass('A: start_conversation with the number tenant B also has returns A''s own chat',
  (select (public.start_conversation('19990000001', null)).id = (select conv_a from ids)));
select pg_temp.pass('A: start_conversation creates new chats in tenant A on A''s connection',
  (select (c).tenant_id = (select ta from ids) and (c).connection_id = (select ca from ids)
     from (select public.start_conversation('19990000777', 'New one') as c) x));
select pg_temp.pass('A: service-only functions are not callable',
  pg_temp.raises('select public.get_connection_token(gen_random_uuid())', '42501')
  and pg_temp.raises('select public.store_connection_token(gen_random_uuid(), repeat(''x'', 30), null)', '42501')
  and pg_temp.raises('select public.revoke_connection_token(gen_random_uuid())', '42501')
  and pg_temp.raises('select public.ingest_incoming(''{}''::jsonb)', '42501')
  and pg_temp.raises('select public.create_outgoing(''{}''::jsonb)', '42501')
  and pg_temp.raises('select public.apply_message_status(''x'', ''read'', null, gen_random_uuid())', '42501')
  and pg_temp.raises('select public.apply_customer_reaction(''x'', ''x'', gen_random_uuid())', '42501')
  and pg_temp.raises('select public.resolve_connection(''SQLT_PHONE_B'')', '42501')
  and pg_temp.raises('select public.bind_legacy_connection(''12345678'', null)', '42501')
  and pg_temp.raises('select public.record_webhook_event(null, null, null, null, ''routed'', null)', '42501')
  and pg_temp.raises('select public.write_audit(null, null, ''x'', null, ''{}''::jsonb)', '42501')
  and pg_temp.raises('select public.create_client_account(gen_random_uuid(), ''ZZZ'', '''', ''admin'', null, null, ''owner'')', '42501'));
select pg_temp.pass('A: admin functions are refused',
  pg_temp.raises('select public.admin_overview()', '42501')
  and pg_temp.raises('select * from public.admin_tenant_summary()', '42501')
  and pg_temp.raises(format('select public.admin_set_tenant_status(%L, ''suspended'')', (select tb from ids)), '42501'));
-- A device token registered by A
select public.register_push_device(repeat('a', 40), 'android');
select pg_temp.pass('A: registered a push device in tenant A', (select count(*) = 1 and bool_and(tenant_id = (select ta from ids)) from public.push_devices));
select pg_temp.pass('A: storage upload outside the own folder is refused',
  pg_temp.raises(format('insert into storage.objects (bucket_id, name) values (''files'', %L)', 'outgoing/' || (select ub from ids) || '/evil.pdf'), '42501'));
select pg_temp.pass('A: storage upload into the own folder is allowed',
  not pg_temp.raises(format('insert into storage.objects (bucket_id, name) values (''files'', %L)', 'outgoing/' || (select ua from ids) || '/mine.pdf')));

-- ---------------------------------------------------------------------------------------------
-- 3. Tenant B's data was untouched; B sees its own and not A's
-- ---------------------------------------------------------------------------------------------
reset role;
select pg_temp.pass('tenant B conversation, message and quick reply unchanged after A''s attacks',
  (select count(*) = 0 from (
     select 'conv', md5(c::text) from public.conversations c where c.id = (select conv_b from ids)
     union all select 'msg', md5(m::text) from public.wa_messages m where m.id = (select m_b_in from ids)
     union all select 'qr', md5(q::text) from public.quick_replies q where q.id = (select qr_b from ids)
     except select k, h from b_before) x));
select pg_temp.pass('no flag rows or read rows were created on B''s data by A',
  (select count(*) = 0 from public.message_flags where message_id = (select m_b_in from ids))
  and (select count(*) = 0 from public.conversation_reads where conversation_id = (select conv_b from ids)));

select pg_temp.as_user(ub) from ids;
select pg_temp.pass('B reads only tenant B data', (select count(*) = 1 and bool_and(tenant_id = (select tb from ids)) from public.conversations where wa_id = '19990000001'));
select pg_temp.pass('B sees its own file only', (select count(*) filter (where name like '%sqlt-b.pdf') = 1 and count(*) filter (where name like '%sqlt-a.pdf') = 0 from storage.objects where bucket_id = 'files'));
select pg_temp.pass('B does not see A''s push device', (select count(*) = 0 from public.push_devices));
select pg_temp.pass('B''s start_conversation with the shared number returns B''s own chat',
  (select (public.start_conversation('19990000001', null)).id = (select conv_b from ids)));
select pg_temp.pass('B''s quick reply list does not include A''s snippets', (select not bool_or(shortcut = 'shared') from public.quick_replies));
-- B signs in on A's phone: the push token moves to B
select public.register_push_device(repeat('a', 40), 'android');
select pg_temp.pass('B: a device token re-registered by B moves to B', (select count(*) = 1 and bool_and(tenant_id = (select tb from ids)) from public.push_devices));
reset role;
select pg_temp.as_user(ua) from ids;
select pg_temp.pass('A no longer sees the moved device token', (select count(*) = 0 from public.push_devices));

-- ---------------------------------------------------------------------------------------------
-- 4. Accounts that must be locked out
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user(ud) from ids;
select pg_temp.pass('disabled staff account sees nothing',
  (select count(*) = 0 from public.conversations) and (select count(*) = 0 from public.wa_messages) and (select count(*) = 0 from storage.objects where bucket_id = 'files'));
select pg_temp.pass('disabled staff account cannot call RPCs',
  pg_temp.raises(format('select public.mark_conversation_read(%L)', (select conv_a from ids)), '42501')
  and pg_temp.raises('select public.start_conversation(''19990000555'', null)', '42501')
  and pg_temp.raises('select public.register_push_device(repeat(''d'', 40), ''android'')', '42501'));
select pg_temp.as_user(um) from ids;
select pg_temp.pass('disabled membership sees nothing and cannot act',
  (select count(*) = 0 from public.conversations)
  and pg_temp.raises('select public.start_conversation(''19990000555'', null)', '42501'));
select pg_temp.as_user(us) from ids;
select pg_temp.pass('user of a suspended tenant sees nothing and cannot act',
  (select count(*) = 0 from public.conversations) and (select count(*) = 0 from public.tenants)
  and pg_temp.raises('select public.start_conversation(''19990000555'', null)', '42501'));
select pg_temp.as_user(uo) from ids;
select pg_temp.pass('login without a tenant sees nothing and cannot act',
  (select count(*) = 0 from public.conversations) and (select count(*) = 0 from public.wa_messages)
  and pg_temp.raises('select public.start_conversation(''19990000555'', null)', '42501')
  and pg_temp.raises(format('select public.delete_message_for_me(%L)', (select m_a_in from ids)), '42501'));
select pg_temp.as_user(ue) from ids;
select pg_temp.pass('tenant without a WhatsApp connection cannot start a chat (clear error)',
  pg_temp.raises('select public.start_conversation(''19990000555'', null)', 'P0002'));
select pg_temp.as_anon();
select pg_temp.pass('anonymous sees and calls nothing',
  pg_temp.raises('select count(*) from public.conversations', '42501')
  and pg_temp.raises('select count(*) from public.tenants', '42501')
  and pg_temp.raises('select count(*) from public.whatsapp_connections', '42501')
  and pg_temp.raises('select public.start_conversation(''19990000555'', null)', '42501')
  and pg_temp.raises('select public.get_connection_token(gen_random_uuid())', '42501')
  and pg_temp.raises('select public.admin_overview()', '42501'));

-- ---------------------------------------------------------------------------------------------
-- 5. Platform admin: oversight without content
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_user(uadm) from ids;
select pg_temp.pass('admin sees every tenant and connection', (select count(*) >= 4 from public.tenants) and (select count(*) >= 3 from public.whatsapp_connections));
select pg_temp.pass('admin sees audit log and webhook ledger', (select count(*) >= 1 from public.audit_logs) and (select count(*) >= 1 from public.webhook_events));
select pg_temp.pass('admin does NOT read message content of tenants it does not belong to',
  (select count(*) = 0 from public.wa_messages where tenant_id in ((select ta from ids), (select tb from ids)))
  and (select count(*) = 0 from public.conversations where tenant_id in ((select ta from ids), (select tb from ids))));
select pg_temp.pass('admin overview and tenant summary return counts only',
  (select (public.admin_overview()) ? 'tenants')
  and (select count(*) >= 3 from public.admin_tenant_summary())
  and (select bool_and(messages_24h_in is not null) from public.admin_tenant_summary()));
select pg_temp.pass('admin cannot read the Vault reference either', pg_temp.raises('select vault_secret_id from public.whatsapp_connections', '42501'));
select pg_temp.pass('admin still cannot call token functions', pg_temp.raises('select public.get_connection_token(gen_random_uuid())', '42501'));
select public.admin_set_tenant_status((select tb from ids), 'suspended');
select pg_temp.pass('admin suspended tenant B and the audit log recorded it',
  (select count(*) = 1 from public.audit_logs where action = 'tenant.set_status' and tenant_id = (select tb from ids)));
select pg_temp.as_user(ub) from ids;
select pg_temp.pass('tenant B is locked out the moment it is suspended', (select count(*) = 0 from public.conversations) and (select count(*) = 0 from public.wa_messages));
select pg_temp.as_user(uadm) from ids;
select public.admin_set_tenant_status((select tb from ids), 'active');
select pg_temp.as_user(ub) from ids;
select pg_temp.pass('and has access again after reactivation', (select count(*) = 1 from public.conversations));

-- ---------------------------------------------------------------------------------------------
-- 6. Routing by phone number id, as the Edge Functions (service role) use it
-- ---------------------------------------------------------------------------------------------
select pg_temp.as_service();
select pg_temp.pass('resolve_connection maps SQLT_PHONE_A to tenant A and B to tenant B',
  (select tenant_id = (select ta from ids) from public.resolve_connection('SQLT_PHONE_A'))
  and (select tenant_id = (select tb from ids) from public.resolve_connection('SQLT_PHONE_B')));
select pg_temp.pass('unknown phone number id resolves to nothing', (select count(*) = 0 from public.resolve_connection('SQLT_NOPE')) and (select count(*) = 0 from public.resolve_connection(null)));
select pg_temp.pass('resolve_connection reports the suspended tenant', (select not tenant_active from public.resolve_connection('SQLT_PHONE_S')));

select pg_temp.pass('incoming message on connection A creates a chat in tenant A',
  (select public.ingest_incoming(jsonb_build_object('connection_id', (select ca from ids), 'wa_id', '19990000002', 'customer_name', 'New cust',
     'wa_message_id', 'wamid.SQLT.NEW1', 'type', 'text', 'body', 'hi')) is not null));
create temp table steps (k text, v boolean);
grant all on steps to public;
insert into steps select 'ingest_b', public.ingest_incoming(jsonb_build_object('connection_id', (select cb from ids), 'wa_id', '19990000002', 'wa_message_id', 'wamid.SQLT.NEW2', 'type', 'text', 'body', 'hi B')) is not null;
select pg_temp.pass('the same customer number on connection B is a different chat in tenant B',
  (select v from steps where k = 'ingest_b')
  and (select count(distinct tenant_id) = 2 and count(distinct id) = 2 from public.conversations where wa_id = '19990000002'));
select pg_temp.pass('every stored message carries the tenant of its connection',
  (select count(*) = 0 from public.wa_messages m join public.conversations c on c.id = m.conversation_id where m.tenant_id <> c.tenant_id));
select pg_temp.pass('duplicate wamid is ignored (idempotent)',
  (select public.ingest_incoming(jsonb_build_object('connection_id', (select ca from ids), 'wa_id', '19990000002', 'wa_message_id', 'wamid.SQLT.NEW1', 'type', 'text', 'body', 'again')) is null));
select pg_temp.pass('the same wamid replayed on ANOTHER connection does not copy or overwrite the message',
  (select public.ingest_incoming(jsonb_build_object('connection_id', (select cb from ids), 'wa_id', '19990000009', 'wa_message_id', 'wamid.SQLT.NEW1', 'type', 'text', 'body', 'replay')) is null)
  and (select tenant_id = (select ta from ids) and body = 'hi' from public.wa_messages where wa_message_id = 'wamid.SQLT.NEW1'));
select pg_temp.pass('ingest for an unknown connection is refused',
  pg_temp.raises('select public.ingest_incoming(jsonb_build_object(''connection_id'', gen_random_uuid(), ''wa_id'', ''1999000099900'', ''wa_message_id'', ''wamid.X'', ''type'', ''text''))'));

select pg_temp.pass('status from the WRONG connection does not change the message',
  (select not public.apply_message_status('wamid.SQLT.A.OUT', 'read', null, (select cb from ids)))
  and (select status = 'sent' from public.wa_messages where wa_message_id = 'wamid.SQLT.A.OUT'));
insert into steps select 'status_read', public.apply_message_status('wamid.SQLT.A.OUT', 'read', null, (select ca from ids));
insert into steps select 'status_back', public.apply_message_status('wamid.SQLT.A.OUT', 'delivered', null, (select ca from ids));
select pg_temp.pass('status from the right connection applies, and never goes backwards',
  (select v from steps where k = 'status_read') and not (select v from steps where k = 'status_back')
  and (select status = 'read' from public.wa_messages where wa_message_id = 'wamid.SQLT.A.OUT'));
insert into steps select 'react_wrong', public.apply_customer_reaction('wamid.SQLT.A.IN', 'x', (select cb from ids));
select pg_temp.pass('reaction from the wrong connection is ignored',
  not (select v from steps where k = 'react_wrong')
  and (select reaction_customer is null from public.wa_messages where wa_message_id = 'wamid.SQLT.A.IN'));
insert into steps select 'react_right', public.apply_customer_reaction('wamid.SQLT.A.IN', '👍', (select ca from ids));
select pg_temp.pass('reaction from the right connection is applied',
  (select v from steps where k = 'react_right')
  and (select reaction_customer = '👍' from public.wa_messages where wa_message_id = 'wamid.SQLT.A.IN'));

select pg_temp.pass('create_outgoing refuses a sender from another tenant',
  pg_temp.raises(format('select public.create_outgoing(%L::jsonb)', jsonb_build_object('conversation_id', (select conv_a from ids), 'sent_by', (select ub from ids), 'type', 'text', 'body', 'x')), '42501'));
select pg_temp.pass('create_outgoing refuses a disabled sender',
  pg_temp.raises(format('select public.create_outgoing(%L::jsonb)', jsonb_build_object('conversation_id', (select conv_a from ids), 'sent_by', (select ud from ids), 'type', 'text', 'body', 'x')), '42501'));
select pg_temp.pass('create_outgoing for the right tenant works and takes the tenant from the conversation',
  (select (public.create_outgoing(jsonb_build_object('conversation_id', (select conv_a from ids), 'sent_by', (select ua from ids), 'type', 'text', 'body', 'reply'))).tenant_id = (select ta from ids)));

select public.record_webhook_event('SQLT_PHONE_A', 'SQLT_WABA_A', 'messages', (select ca from ids), 'routed', 'ok');
select public.record_webhook_event('SQLT_UNKNOWN2', null, 'messages', null, 'unrouted', 'no connection');
select pg_temp.pass('ledger records routing outcomes and stamps last_webhook_at on the routed connection',
  (select count(*) = 2 from public.webhook_events where phone_number_id in ('SQLT_PHONE_A', 'SQLT_UNKNOWN2'))
  and (select last_webhook_at is not null from public.whatsapp_connections where id = (select ca from ids)));

reset role;
-- legacy connection binding: bind once, never twice, never to a taken id
update public.whatsapp_connections set phone_number_id = null where credential_source = 'platform_env';
select pg_temp.as_service();
select pg_temp.pass('bind_legacy_connection refuses a phone number id that belongs to another connection', (select public.bind_legacy_connection('SQLT_PHONE_A', null) is null));
select pg_temp.pass('bind_legacy_connection binds the legacy connection once', (select public.bind_legacy_connection('SQLT_LEGACY_PHONE', 'SQLT_LEGACY_WABA') is not null));
select pg_temp.pass('and not a second time', (select public.bind_legacy_connection('SQLT_LEGACY_PHONE_2', null) is null)
  and (select phone_number_id = 'SQLT_LEGACY_PHONE' from public.whatsapp_connections where credential_source = 'platform_env'));

-- ---------------------------------------------------------------------------------------------
-- 7. Per-connection tokens in Vault
-- ---------------------------------------------------------------------------------------------
select public.store_connection_token((select ca from ids), 'SQLT_FAKE_TOKEN_FOR_A_aaaaaaaaaaaaaaaa', now() + interval '60 days');
select public.store_connection_token((select cb from ids), 'SQLT_FAKE_TOKEN_FOR_B_bbbbbbbbbbbbbbbb', null);
select pg_temp.pass('each connection decrypts to its own token',
  (select public.get_connection_token((select ca from ids)) = 'SQLT_FAKE_TOKEN_FOR_A_aaaaaaaaaaaaaaaa')
  and (select public.get_connection_token((select cb from ids)) = 'SQLT_FAKE_TOKEN_FOR_B_bbbbbbbbbbbbbbbb'));
select pg_temp.pass('two separate Vault secrets exist, only references are stored on the connections',
  (select count(*) = 2 from vault.secrets where name in ('wa_conn_' || (select ca from ids), 'wa_conn_' || (select cb from ids)))
  and (select count(*) = 2 from public.whatsapp_connections where vault_secret_id is not null and id in ((select ca from ids), (select cb from ids))));
select pg_temp.pass('no table row contains token text',
  (select count(*) = 0 from public.whatsapp_connections c where to_jsonb(c)::text like '%SQLT_FAKE_TOKEN%')
  and (select count(*) = 0 from public.audit_logs a where to_jsonb(a)::text like '%SQLT_FAKE_TOKEN%')
  and (select count(*) = 0 from vault.secrets s where s.secret like '%SQLT_FAKE_TOKEN%'));
select public.store_connection_token((select ca from ids), 'SQLT_ROTATED_TOKEN_A_aaaaaaaaaaaaaaaaaa', null);
select pg_temp.pass('rotation replaces the token in place and leaves B alone',
  (select public.get_connection_token((select ca from ids)) = 'SQLT_ROTATED_TOKEN_A_aaaaaaaaaaaaaaaaaa')
  and (select count(*) = 1 from vault.secrets where name = 'wa_conn_' || (select ca from ids))
  and (select public.get_connection_token((select cb from ids)) = 'SQLT_FAKE_TOKEN_FOR_B_bbbbbbbbbbbbbbbb'));
select pg_temp.pass('the legacy platform_env connection cannot store a Vault token',
  pg_temp.raises('select public.store_connection_token((select id from public.whatsapp_connections where credential_source = ''platform_env''), repeat(''z'', 30), null)', '22023'));
select public.revoke_connection_token((select ca from ids), 'revoked');
select pg_temp.pass('revoking A deletes its secret and status, and B keeps working',
  (select public.get_connection_token((select ca from ids)) is null)
  and (select status = 'revoked' and vault_secret_id is null from public.whatsapp_connections where id = (select ca from ids))
  and (select public.get_connection_token((select cb from ids)) = 'SQLT_FAKE_TOKEN_FOR_B_bbbbbbbbbbbbbbbb')
  and (select count(*) = 0 from vault.secrets where name = 'wa_conn_' || (select ca from ids)));
select public.revoke_connection_token((select cb from ids), 'disconnected');
select pg_temp.pass('disconnecting B removes its token too',
  (select public.get_connection_token((select cb from ids)) is null)
  and (select status = 'disconnected' from public.whatsapp_connections where id = (select cb from ids)));

-- ---------------------------------------------------------------------------------------------
-- 8. Constraints inside the database itself
-- ---------------------------------------------------------------------------------------------
select pg_temp.pass('audit log rows cannot be altered, even by the service role',
  pg_temp.raises('update public.audit_logs set action = ''x''', '42501') and pg_temp.raises('delete from public.audit_logs', '42501'));
reset role;
select pg_temp.pass('a conversation cannot name a connection of another tenant (composite FK)',
  pg_temp.raises(format('insert into public.conversations (tenant_id, connection_id, wa_id) values (%L, %L, ''19990000888'')', (select ta from ids), (select cb from ids)), '23503'));
select pg_temp.pass('a message cannot carry a tenant different from its conversation (composite FK)',
  pg_temp.raises(format('insert into public.wa_messages (tenant_id, conversation_id, direction, type, status) values (%L, %L, ''in'', ''text'', ''received'')', (select tb from ids), (select conv_a from ids)), '23503'));
select pg_temp.pass('a phone number id can belong to only one connection',
  pg_temp.raises(format('insert into public.whatsapp_connections (tenant_id, phone_number_id) values (%L, ''SQLT_PHONE_B'')', (select ta from ids)), '23505'));
select pg_temp.pass('the same customer number twice on one connection is refused',
  pg_temp.raises(format('insert into public.conversations (tenant_id, connection_id, wa_id) values (%L, %L, ''19990000001'')', (select ta from ids), (select ca from ids)), '23505'));
select pg_temp.pass('a login can belong to one tenant only',
  pg_temp.raises(format('insert into public.tenant_memberships (tenant_id, user_id) values (%L, %L)', (select tb from ids), (select ua from ids)), '23505'));
select pg_temp.pass('only one connection may use the global WA_TOKEN',
  pg_temp.raises(format('insert into public.whatsapp_connections (tenant_id, credential_source) values (%L, ''platform_env'')', (select ta from ids)), '23505'));
select pg_temp.pass('the vault schema is not granted to anon or authenticated',
  not has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT') and not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT')
  and not has_table_privilege('authenticated', 'vault.secrets', 'SELECT'));
select pg_temp.pass('every public table has row level security enabled',
  (select count(*) = 0 from pg_tables t where t.schemaname = 'public' and not t.rowsecurity));

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

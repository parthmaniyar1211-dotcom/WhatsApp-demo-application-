-- Database tests for "Delete for me" (soft delete). Run against the LOCAL database only:
--   npm run test:sql
-- Everything happens inside one transaction that is rolled back at the end: no data is left behind.
-- Roles and logins are simulated the way PostgREST does it (role + request.jwt.claims).

\set ON_ERROR_STOP on
\o /dev/null
begin;

create temp table results (name text, ok boolean) on commit drop;
grant all on results to public;

-- Two real staff members (users A and B) and an outsider (a login without a staff row).
create temp table ids as
  select (select user_id from public.staff where role = 'admin' and not disabled limit 1) as a,
         (select user_id from public.staff where role = 'staff' and not disabled limit 1) as b,
         gen_random_uuid() as outsider,
         gen_random_uuid() as conv,
         gen_random_uuid() as m_in, gen_random_uuid() as m_out, gen_random_uuid() as m_doc;
grant all on ids to public;

-- Both test users belong to the "Owner (test)" tenant (created by the multi-tenant migration).
insert into public.conversations (id, tenant_id, connection_id, wa_id, contact_name, last_message_at, last_message_preview)
  select conv, (select id from public.tenants where slug = 'owner-test'),
         (select id from public.whatsapp_connections where credential_source = 'platform_env'),
         '19990000001', 'SQL test', now(), 'doc' from ids;
insert into public.wa_messages (id, tenant_id, conversation_id, wa_message_id, direction, type, body, status, created_at)
  select m_in, (select id from public.tenants where slug = 'owner-test'), conv, 'wamid.SQLTEST.IN', 'in', 'text', 'incoming hello', 'received', now() - interval '3 min' from ids;
insert into public.wa_messages (id, tenant_id, conversation_id, wa_message_id, direction, type, body, status, created_at)
  select m_out, (select id from public.tenants where slug = 'owner-test'), conv, 'wamid.SQLTEST.OUT', 'out', 'text', 'outgoing hello', 'sent', now() - interval '2 min' from ids;
insert into public.wa_messages (id, tenant_id, conversation_id, wa_message_id, direction, type, media_path, media_mime, media_filename, status, created_at)
  select m_doc, (select id from public.tenants where slug = 'owner-test'), conv, 'wamid.SQLTEST.DOC', 'in', 'document', 'incoming/19990000001/sqltest.pdf', 'application/pdf', 'a.pdf', 'received', now() - interval '1 min' from ids;

create temp table before_snapshot as
  select id, md5(m::text) as h from public.wa_messages m where conversation_id = (select conv from ids);
grant all on before_snapshot to public;

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  set local role authenticated;
end $$;

create or replace function pg_temp.pass(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
  insert into results values (p_name, coalesce(p_ok, false));
end $$;
grant execute on function pg_temp.pass(text, boolean) to public;
grant execute on function pg_temp.as_user(uuid) to public;

-- 1-2. A deletes the incoming text and the document for themself.
select pg_temp.as_user(a) from ids;
select public.delete_message_for_me(m_in) from ids;
select public.delete_message_for_me(m_doc) from ids;
select pg_temp.pass('A: flag rows created with hidden_at',
  (select count(*) = 2 and bool_and(hidden and hidden_at is not null) from public.message_flags f, ids where f.user_id = ids.a and f.message_id in (ids.m_in, ids.m_doc)));
create temp table first_deleted as select hidden_at from public.message_flags f, ids where f.user_id = ids.a and f.message_id = ids.m_in;
grant all on first_deleted to public;
select public.delete_message_for_me(m_in) from ids;
select pg_temp.pass('A: deleting twice is harmless (one row, original deletion time kept)',
  (select count(*) = 1 and bool_and(f.hidden and f.hidden_at = (select hidden_at from first_deleted))
     from public.message_flags f, ids where f.user_id = ids.a and f.message_id = ids.m_in));

-- 3. The messages themselves are untouched (hash of every column).
reset role;
select pg_temp.pass('wa_messages rows unchanged (all columns incl. status, media_path)',
  (select count(*) = 0 from before_snapshot b join public.wa_messages m on m.id = b.id where md5(m::text) <> b.h));

-- 4. A's chat preview skips the deleted messages; B (who deleted nothing) still sees the newest one.
select pg_temp.as_user(a) from ids;
select pg_temp.pass('A: newest visible message is the outgoing one',
  (select message_id = ids.m_out from public.visible_last_messages() v, ids where v.conversation_id = ids.conv));
select pg_temp.as_user(b) from ids;
select pg_temp.pass('B: preview unaffected by A''s deletion (still the document)',
  (select message_id = ids.m_doc from public.visible_last_messages() v, ids where v.conversation_id = ids.conv));
select pg_temp.pass('B: cannot see A''s flag rows',
  (select count(*) = 0 from public.message_flags f, ids where f.message_id in (ids.m_in, ids.m_doc)));

-- 5. B cannot undo or change A's deletion, and B deleting for B does not touch A.
select public.restore_message_for_me(m_in) from ids;
reset role;
select pg_temp.pass('B restoring does not change A''s deletion',
  (select count(*) = 1 from public.message_flags f, ids where f.user_id = ids.a and f.message_id = ids.m_in and f.hidden));
select pg_temp.as_user(b) from ids;
select public.delete_message_for_me(m_out) from ids;
reset role;
select pg_temp.pass('B deleting for B leaves A''s view alone',
  (select count(*) = 0 from public.message_flags f, ids where f.user_id = ids.a and f.message_id = ids.m_out));

-- 6. Search respects each user's deletions.
select pg_temp.as_user(a) from ids;
select pg_temp.pass('A: search does not return the deleted incoming message',
  (select count(*) = 0 from public.search_messages('incoming hello'))) ;
select pg_temp.as_user(b) from ids;
select pg_temp.pass('B: search still returns it',
  (select count(*) = 1 from public.search_messages('incoming hello')));
select pg_temp.pass('B: deleted outgoing message is not searchable for B',
  (select count(*) = 0 from public.search_messages('outgoing hello')));

-- 7. All messages deleted: no preview row at all.
select pg_temp.as_user(a) from ids;
select public.delete_message_for_me(m_out) from ids;
select pg_temp.pass('A: with everything deleted there is no visible preview',
  (select count(*) = 0 from public.visible_last_messages() v, ids where v.conversation_id = ids.conv));

-- 8. Delivery receipts keep working on a deleted message (the webhook uses the service role).
reset role;
set local role service_role;
select pg_temp.pass('webhook status update still applies to a message A deleted',
  (select public.apply_message_status('wamid.SQLTEST.OUT', 'delivered', null, (select id from public.whatsapp_connections where credential_source = 'platform_env'))));
select pg_temp.pass('status is now delivered',
  (select status = 'delivered' from public.wa_messages, ids where id = ids.m_out));
select pg_temp.pass('webhook still ingests a new incoming message',
  (select public.ingest_incoming(jsonb_build_object('connection_id', (select id from public.whatsapp_connections where credential_source = 'platform_env'), 'wa_id','19990000001','wa_message_id','wamid.SQLTEST.NEW','type','text','body','new one')) is not null));
reset role;
select pg_temp.as_user(a) from ids;
select pg_temp.pass('A: the new incoming message is visible',
  (select count(*) = 1 from public.visible_last_messages() v, ids where v.conversation_id = ids.conv and v.body = 'new one'));

-- 9. Undo restores; a star set before deleting is kept.
select public.set_message_flags(m_in, true, false) from ids;
select public.delete_message_for_me(m_in) from ids;
select public.restore_message_for_me(m_in) from ids;
select pg_temp.pass('undo: message visible again and star kept',
  (select starred and not hidden and hidden_at is null from public.message_flags f, ids where f.user_id = ids.a and f.message_id = ids.m_in));
select public.restore_message_for_me(m_doc) from ids;
reset role;
select pg_temp.pass('undo of an unstarred deletion leaves no empty flag row',
  (select count(*) = 0 from public.message_flags f, ids where f.user_id = ids.a and f.message_id = ids.m_doc));

-- 10. Unauthorized attempts.
do $$
declare caught text;
begin
  -- anonymous
  begin
    set local role anon;
    perform public.delete_message_for_me((select m_in from ids));
    caught := 'no error';
  exception when insufficient_privilege then caught := 'denied';
  end;
  reset role;
  perform pg_temp.pass('anonymous caller is denied', caught = 'denied');

  -- signed in but not staff
  caught := null;
  begin
    perform pg_temp.as_user((select outsider from ids));
    perform public.delete_message_for_me((select m_in from ids));
    caught := 'no error';
  exception when insufficient_privilege then caught := 'denied';
  end;
  reset role;
  perform pg_temp.pass('login without a staff row is denied', caught = 'denied');

  -- disabled staff
  update public.staff set disabled = true where user_id = (select b from ids);
  caught := null;
  begin
    perform pg_temp.as_user((select b from ids));
    perform public.delete_message_for_me((select m_in from ids));
    caught := 'no error';
  exception when insufficient_privilege then caught := 'denied';
  end;
  reset role;
  update public.staff set disabled = false where user_id = (select b from ids);
  perform pg_temp.pass('disabled staff member is denied', caught = 'denied');

  -- message that does not exist
  caught := null;
  begin
    perform pg_temp.as_user((select a from ids));
    perform public.delete_message_for_me(gen_random_uuid());
    caught := 'no error';
  exception when no_data_found then caught := 'not found';
  end;
  reset role;
  perform pg_temp.pass('unknown message id is refused', caught = 'not found');

  -- direct table writes by a client
  caught := null;
  begin
    perform pg_temp.as_user((select a from ids));
    delete from public.wa_messages where id = (select m_in from ids);
    caught := 'no error';
  exception when insufficient_privilege then caught := 'denied';
  end;
  reset role;
  perform pg_temp.pass('client cannot delete rows of wa_messages', caught = 'denied');

  caught := null;
  begin
    perform pg_temp.as_user((select a from ids));
    insert into public.message_flags (user_id, message_id, hidden) select b, m_in, true from ids;
    caught := 'no error';
  exception when insufficient_privilege then caught := 'denied';
  end;
  reset role;
  perform pg_temp.pass('client cannot write flags (not even for itself) except through the functions', caught = 'denied');
end $$;

-- Final: no message row was removed by any of the above (3 seeded + 1 ingested).
reset role;
select pg_temp.pass('no message row was removed',
  (select count(*) = 4 from public.wa_messages, ids where conversation_id = ids.conv));

-- Report
reset role;
\o
select case when ok then 'PASS' else 'FAIL' end as result, name from results order by 1 desc, 2;
do $$
begin
  if exists (select 1 from results where not ok) then
    raise exception 'SQL tests FAILED';
  end if;
end $$;
rollback;

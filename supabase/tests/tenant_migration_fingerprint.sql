-- Fingerprint of all pre-tenant data: one md5 per table over every ORIGINAL column.
-- Run it before and after the multi-tenant migrations (LOCAL database only) and compare:
--   psql ... -X -q -t -A -f supabase/tests/tenant_migration_fingerprint.sql > before.txt
--   (apply migrations)
--   psql ... -X -q -t -A -f supabase/tests/tenant_migration_fingerprint.sql > after.txt ; diff before.txt after.txt
-- The columns added by later migrations (tenant_id, connection_id, staff.must_change_password) are removed from the hash, so
-- identical output proves that every pre-existing value, id, status and media path is unchanged.
select 'wa_messages|' || count(*) || '|' || coalesce(md5(string_agg((to_jsonb(t) - array['tenant_id'])::text, E'\n' order by t.id)), '')
  from public.wa_messages t
union all
select 'conversations|' || count(*) || '|' || coalesce(md5(string_agg((to_jsonb(t) - array['tenant_id', 'connection_id'])::text, E'\n' order by t.id)), '')
  from public.conversations t
union all
select 'message_flags|' || count(*) || '|' || coalesce(md5(string_agg(to_jsonb(t)::text, E'\n' order by t.user_id, t.message_id)), '')
  from public.message_flags t
union all
select 'conversation_reads|' || count(*) || '|' || coalesce(md5(string_agg(to_jsonb(t)::text, E'\n' order by t.user_id, t.conversation_id)), '')
  from public.conversation_reads t
union all
select 'quick_replies|' || count(*) || '|' || coalesce(md5(string_agg((to_jsonb(t) - array['tenant_id'])::text, E'\n' order by t.id)), '')
  from public.quick_replies t
union all
select 'staff|' || count(*) || '|' || coalesce(md5(string_agg((to_jsonb(t) - array['must_change_password'])::text, E'\n' order by t.user_id)), '')
  from public.staff t
union all
select 'storage_objects|' || count(*) || '|' || coalesce(md5(string_agg((o.id::text || o.bucket_id || o.name || coalesce(o.metadata->>'size', '')), E'\n' order by o.id)), '')
  from storage.objects o
union all
-- every media path points at an existing storage object (media relationships)
select 'media_links_ok|' || count(*) filter (where exists (select 1 from storage.objects o where o.bucket_id = 'files' and o.name = m.media_path)) || '|' || count(*)
  from public.wa_messages m where m.media_path is not null
order by 1;

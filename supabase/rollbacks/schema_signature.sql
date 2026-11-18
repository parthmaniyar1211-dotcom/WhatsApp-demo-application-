-- A complete, diffable signature of everything the application owns in the database:
-- columns, constraints, indexes, function bodies, privileges and policies in schema public,
-- plus the policies on storage.objects. Used to PROVE that a rollback restores the previous schema:
--   psql ... -X -q -t -A -f supabase/rollbacks/schema_signature.sql > signature.txt
-- Run it on a database restored from the pre-migration backup and on the rolled-back database, then diff.
select 'COLUMN|' || c.table_name || '|' || c.column_name || '|' || c.data_type || '|' || coalesce(c.column_default, '') || '|' || c.is_nullable
  from information_schema.columns c where c.table_schema = 'public' order by 1;
select 'CONSTRAINT|' || cl.relname || '|' || co.conname || '|' || pg_get_constraintdef(co.oid)
  from pg_constraint co join pg_class cl on cl.oid = co.conrelid join pg_namespace n on n.oid = cl.relnamespace
 where n.nspname = 'public' order by 1;
select 'INDEX|' || indexname || '|' || indexdef from pg_indexes where schemaname = 'public' order by 1;
select 'FUNCTION|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || md5(pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1;
select 'FUNCPRIV|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
       || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
       || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1;
select 'TABLEPRIV|' || table_name || '|' || grantee || '|' || privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role') order by 1;
select 'COLPRIV|' || table_name || '|' || column_name || '|' || grantee || '|' || privilege_type
  from information_schema.column_privileges
 where table_schema = 'public' and grantee in ('anon', 'authenticated') order by 1;
select 'RLS|' || tablename || '|' || rowsecurity from pg_tables where schemaname = 'public' order by 1;
select 'POLICY|' || schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|'
       || coalesce(qual, '') || '|' || coalesce(with_check, '')
  from pg_policies where schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects') order by 1;
select 'TRIGGER|' || event_object_table || '|' || trigger_name from information_schema.triggers where trigger_schema = 'public' order by 1;

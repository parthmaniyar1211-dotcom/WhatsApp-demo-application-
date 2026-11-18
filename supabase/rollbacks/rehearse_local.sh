#!/usr/bin/env bash
# Rehearses the multi-tenant rollback on the LOCAL Supabase database (never on hosted):
#   supabase/rollbacks/rehearse_local.sh /path/to/pre-migration.dump
# The dump must be a pg_dump -Fc of schemas public, auth, storage taken BEFORE the 20261118 migrations.
# Proves: refusal guard, rollback, schema identical to the pre-migration schema, data identical,
# the original (git HEAD) delete-for-me suite passes on the rolled-back schema, roll-forward restores everything.
set -uo pipefail
DUMP="${1:?path to the pre-migration dump}"
HOST=127.0.0.1; PORT=54322; DBC=supabase_db_whatsapp-shared-inbox
export PGPASSWORD=postgres
P="psql -h $HOST -p $PORT -U postgres -X -q"
cd "$(dirname "$0")/../.."
W=$(mktemp -d)
ok() { echo "PASS  $1"; }; bad() { echo "FAIL  $1"; FAILED=1; }; FAILED=0
step() { echo; echo "=== $1"; }

step "0. local only: connected to $HOST:$PORT, database $($P -t -A -c 'select current_database()')"
$P -t -A -c "select 'tenants before='||count(*) from tenants"

step "1. schema signature of the PRE-migration database (restored from the backup into a scratch database)"
docker cp "$DUMP" $DBC:/tmp/pre.dump
docker exec $DBC bash -c "psql -U postgres -q -c 'drop database if exists pre_tenancy' -c 'create database pre_tenancy' && psql -U postgres -d pre_tenancy -q -c 'create extension if not exists \"uuid-ossp\"' -c 'create extension if not exists pgcrypto' && pg_restore -U postgres -d pre_tenancy --no-owner /tmp/pre.dump >/dev/null 2>&1; true"
docker cp supabase/rollbacks/schema_signature.sql $DBC:/tmp/sig.sql
docker exec $DBC psql -U postgres -d pre_tenancy -X -q -t -A -f /tmp/sig.sql > $W/sig_pre.txt
echo "signature lines: $(wc -l < $W/sig_pre.txt)"
$P -t -A -f supabase/rollbacks/schema_signature.sql > $W/sig_forward.txt
$P -t -A -f supabase/tests/tenant_migration_fingerprint.sql > $W/fp_before.txt; cat $W/fp_before.txt

step "2. GUARD: with a second tenant present the rollback must refuse and change nothing"
$P -c "insert into tenants (slug,name) values ('guard-test','Guard test')" >/dev/null
OUT=$($P -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261118_multi_tenant_down.sql 2>&1 | grep -E "refused" | head -1); echo "$OUT"
[[ "$OUT" == *"Rollback refused"* ]] && ok "rollback refused" || bad "rollback did NOT refuse"
$P -t -A -f supabase/rollbacks/schema_signature.sql | diff -q $W/sig_forward.txt - >/dev/null && ok "schema unchanged after the refused attempt" || bad "schema changed"
$P -c "delete from tenants where slug='guard-test'" >/dev/null

step "3. ROLLBACK"
$P -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261118_multi_tenant_down.sql >/dev/null 2>$W/err.txt && ok "down script completed in one transaction" || { bad "down script failed"; cat $W/err.txt; }
$P -t -A -f supabase/rollbacks/schema_signature.sql > $W/sig_rolled.txt
if diff $W/sig_pre.txt $W/sig_rolled.txt > $W/sigdiff.txt; then ok "rolled-back schema IDENTICAL to the pre-migration schema ($(wc -l < $W/sig_pre.txt) signature lines)"; else bad "schema differs"; head -20 $W/sigdiff.txt; fi
$P -t -A -f supabase/tests/tenant_migration_fingerprint.sql > $W/fp_after.txt
diff $W/fp_before.txt $W/fp_after.txt >/dev/null && ok "data IDENTICAL before and after the rollback (md5 of every pre-existing table + file list)" || bad "data differs"
$P -t -A -c "select 'snapshot: tenants='||(select count(*) from rollback_snapshot.tenants)||' connections='||(select count(*) from rollback_snapshot.whatsapp_connections)||' audit_rows='||(select count(*) from rollback_snapshot.audit_logs)||' conversation_map='||(select count(*) from rollback_snapshot.conversation_tenants)||' message_map='||(select count(*) from rollback_snapshot.message_tenants)"
$P -t -A -c "select 'snapshot copies the Vault reference column: '||exists(select 1 from information_schema.columns where table_schema='rollback_snapshot' and column_name='vault_secret_id')"

step "4. The ORIGINAL delete-for-me suite from git HEAD, run on the rolled-back schema"
git show HEAD:supabase/tests/message_delete.sql > $W/old_delete.sql
R=$($P -f $W/old_delete.sql 2>&1); echo "$R" | tail -2; echo "$R" | grep -q "FAIL" && bad "old suite has failures" || ok "old suite: no failures"
$P -t -A <<'SQL'
begin;
select 'old ingest_incoming(single-tenant payload) works: ' || (public.ingest_incoming(jsonb_build_object('wa_id','19990009999','customer_name','rollback probe','wa_message_id','wamid.RB.REHEARSAL','type','text','body','hello')) is not null);
select 'old apply_message_status(3 args) exists: ' || exists(select 1 from pg_proc where proname='apply_message_status' and pronargs=3);
select 'tenant tables gone: ' || (not exists(select 1 from pg_tables where schemaname='public' and tablename in ('tenants','whatsapp_connections')));
rollback;
SQL

step "5. ROLL FORWARD (apply the four migrations again)"
for f in supabase/migrations/20261118*.sql; do $P -v ON_ERROR_STOP=1 --single-transaction -f "$f" >/dev/null 2>$W/err.txt && ok "applied $(basename "$f")" || { bad "failed $(basename "$f")"; tail -3 $W/err.txt; }; done
$P -t -A -f supabase/rollbacks/schema_signature.sql | diff -q $W/sig_forward.txt - >/dev/null && ok "forward schema IDENTICAL to the schema before the rollback" || bad "forward schema differs"
$P -t -A -f supabase/tests/tenant_migration_fingerprint.sql | diff -q $W/fp_before.txt - >/dev/null && ok "data IDENTICAL after roll-forward" || bad "data differs after roll-forward"
$P -t -A -c "select 'legacy connection: '||credential_source||'/'||status||', phone number id bound='||(phone_number_id is not null)||' (re-learned from the next webhook)' from whatsapp_connections"
for s in message_delete multi_tenant; do $P -f supabase/tests/$s.sql 2>&1 | grep -qE "FAIL" && bad "$s suite" || ok "$s suite passes after roll-forward"; done

step "6. clean up scratch objects"
$P -c "drop schema if exists rollback_snapshot cascade" >/dev/null 2>&1; docker exec $DBC psql -U postgres -q -c "drop database if exists pre_tenancy" >/dev/null 2>&1; echo "scratch database and snapshot schema removed"
rm -rf "$W"; echo; [[ $FAILED == 0 ]] && echo "RESULT: ALL REHEARSAL CHECKS PASSED" || echo "RESULT: FAILURES"; exit $FAILED

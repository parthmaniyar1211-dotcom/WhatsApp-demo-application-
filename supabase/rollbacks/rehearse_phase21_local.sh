#!/usr/bin/env bash
# Rehearses the Phase 2.1 rollback on the LOCAL Supabase database only:
#   supabase/rollbacks/rehearse_phase21_local.sh <phase2-schema-signature.txt> <phase2-data-fingerprint.txt>
# The two files are produced from the database in its Phase 2 state (before the 20261119 migrations):
#   psql ... -t -A -f supabase/rollbacks/schema_signature.sql            > sig_phase2_baseline.txt
#   psql ... -t -A -f supabase/tests/tenant_migration_fingerprint.sql    > fp_phase2_baseline.txt
# Proves: both safety guards refuse and change nothing, the rollback restores the exact Phase 2 schema and data,
# the Phase 2 test suites pass on the rolled-back schema, the roll-forward restores Phase 2.1 exactly, and
# the rollback is idempotent.
set -uo pipefail
SIG_BASE="${1:?phase 2 schema signature}"; FP_BASE="${2:?phase 2 data fingerprint}"
HOST=127.0.0.1; PORT=54322
export PGPASSWORD=postgres
P="psql -h $HOST -p $PORT -U postgres -X -q"
cd "$(dirname "$0")/../.."
W=$(mktemp -d); FAILED=0
ok() { echo "PASS  $1"; }; bad() { echo "FAIL  $1"; FAILED=1; }
step() { echo; echo "=== $1"; }
same() { if diff -q "$1" "$2" >/dev/null; then ok "$3"; else bad "$3"; diff "$1" "$2" | head -10; fi; }

step "0. local only: $HOST:$PORT database $($P -t -A -c 'select current_database()')"
case "$HOST" in 127.0.0.1|localhost) ok "target is local";; *) echo "refusing"; exit 2;; esac

sig()  { $P -t -A -f supabase/rollbacks/schema_signature.sql; }
fp()   { $P -t -A -f supabase/tests/tenant_migration_fingerprint.sql; }
count(){ $P -t -A -c "$1"; }

step "1. Phase 2.1 state (forward)"
LEFT=$(count "select count(*) from public.webhook_quarantine where replayed_at is null")
$P -c "delete from public.webhook_quarantine" >/dev/null && echo "(local only: removed $LEFT quarantined test events left by earlier test runs; the rollback guard would otherwise correctly refuse)"
sig > $W/sig_forward.txt; fp > $W/fp_forward.txt
[ "$(count "select count(*) from information_schema.columns where table_name='staff' and column_name='must_change_password'")" = 1 ] && ok "Phase 2.1 schema present" || bad "Phase 2.1 schema missing"
diff -q $FP_BASE $W/fp_forward.txt >/dev/null && ok "data fingerprint equals the Phase 2 baseline (the migrations changed no data)" || echo "NOTE  the local test data grew since the baseline was taken (test runs add chats); the proof below compares before/after on the SAME state instead"

step "2. GUARD 1: a pending quarantined event blocks the rollback and nothing changes"
$P -c "insert into public.webhook_quarantine (event_id, phone_number_id, field, reason, payload) values (gen_random_uuid(), 'ROLLBACK_GUARD', 'messages', 'unknown_phone_number_id', '{\"x\":1}')" >/dev/null
OUT=$($P -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261119_phase21_down.sql 2>&1); RC=$?
{ [ $RC -ne 0 ] && echo "$OUT" | grep -q "quarantined webhook events are still waiting"; } && ok "refused: $(echo "$OUT" | grep -o 'Rollback refused[^.]*' | head -1)" || bad "guard 1 did not refuse"
sig > $W/sig_g1.txt; same $W/sig_forward.txt $W/sig_g1.txt "schema untouched after the refusal"
[ "$(count "select count(*) from public.webhook_quarantine where phone_number_id='ROLLBACK_GUARD'")" = 1 ] && ok "quarantined event still there" || bad "quarantined event lost"
$P -c "delete from public.webhook_quarantine where phone_number_id='ROLLBACK_GUARD'" >/dev/null

step "3. GUARD 2: a login with a temporary password blocks the rollback and nothing changes"
UID_=$(count "select user_id from public.staff where role='admin' order by created_at limit 1")
$P -c "update public.staff set must_change_password = true where user_id='$UID_'" >/dev/null
OUT=$($P -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261119_phase21_down.sql 2>&1); RC=$?
{ [ $RC -ne 0 ] && echo "$OUT" | grep -q "temporary password"; } && ok "refused: $(echo "$OUT" | grep -o 'Rollback refused[^.]*' | head -1)" || bad "guard 2 did not refuse"
sig > $W/sig_g2.txt; same $W/sig_forward.txt $W/sig_g2.txt "schema untouched after the refusal"
$P -c "update public.staff set must_change_password = false where user_id='$UID_'" >/dev/null

step "4. ROLLBACK"
OUT=$($P -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261119_phase21_down.sql 2>&1); RC=$?
[ $RC -eq 0 ] && ok "rollback ran" || { bad "rollback failed"; echo "$OUT" | head; }
sig > $W/sig_rolled.txt; fp > $W/fp_rolled.txt
same $SIG_BASE $W/sig_rolled.txt "schema signature IDENTICAL to the Phase 2 baseline ($(wc -l < $W/sig_rolled.txt) lines compared)"
same $W/fp_forward.txt $W/fp_rolled.txt "data fingerprint IDENTICAL before and after the rollback"
[ "$(count "select count(*) from information_schema.columns where table_name='staff' and column_name='must_change_password'")" = 0 ] && ok "must_change_password column removed" || bad "column still there"
[ "$(count "select to_regclass('public.webhook_quarantine') is null")" = t ] && ok "webhook_quarantine removed" || bad "quarantine table still there"
R=$($P -t -A -f supabase/tests/multi_tenant.sql 2>&1); echo "$R" | grep -q '^FAIL' && bad "Phase 2 suite failed on the rolled-back schema" || ok "Phase 2 tenant suite on rolled-back schema: $(echo "$R" | grep -c '^PASS') PASS, 0 FAIL"
R=$($P -t -A -f supabase/tests/message_delete.sql 2>&1); echo "$R" | grep -q '^FAIL' && bad "delete suite failed" || ok "delete-for-me suite on rolled-back schema: $(echo "$R" | grep -c '^PASS') PASS, 0 FAIL"

step "5. IDEMPOTENT: running the rollback again changes nothing"
$P -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261119_phase21_down.sql >/dev/null 2>&1 && ok "second rollback ran" || bad "second rollback failed"
sig > $W/sig_rolled2.txt; same $W/sig_rolled.txt $W/sig_rolled2.txt "signature unchanged"

step "6. ROLL FORWARD: apply both Phase 2.1 migrations again"
for m in supabase/migrations/20261119000000_password_change_enforcement.sql supabase/migrations/20261119000100_webhook_quarantine.sql; do
  $P -v ON_ERROR_STOP=1 -f $m >/dev/null 2>&1 && ok "applied $(basename $m)" || bad "failed $(basename $m)"
done
sig > $W/sig_reforward.txt; fp > $W/fp_reforward.txt
same $W/sig_forward.txt $W/sig_reforward.txt "schema signature IDENTICAL to the Phase 2.1 state before the rollback"
same $W/fp_forward.txt $W/fp_reforward.txt "data fingerprint identical after the roll-forward"
R=$($P -t -A -f supabase/tests/phase21_security.sql 2>&1); echo "$R" | grep -q '^FAIL' && bad "Phase 2.1 suite failed after roll-forward" || ok "Phase 2.1 suite after roll-forward: $(echo "$R" | grep -c '^PASS') PASS, 0 FAIL"
R=$($P -t -A -f supabase/tests/multi_tenant.sql 2>&1); echo "$R" | grep -q '^FAIL' && bad "Phase 2 suite failed after roll-forward" || ok "Phase 2 suite after roll-forward: $(echo "$R" | grep -c '^PASS') PASS, 0 FAIL"

echo; [ $FAILED -eq 0 ] && echo "ROLLBACK REHEARSAL: ALL CHECKS PASSED" || echo "ROLLBACK REHEARSAL: FAILURES"
exit $FAILED

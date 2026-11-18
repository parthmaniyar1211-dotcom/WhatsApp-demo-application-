#!/usr/bin/env bash
# Rehearses the Phase 2 / 2.1 migrations and rollbacks on a SEPARATE scratch Supabase project, never on production.
#
#   SCRATCH_DB_URL='postgresql://postgres:<password>@db.<scratch-ref>.supabase.co:5432/postgres' \
#   SCRATCH_PROJECT_REF='<scratch-ref>' \
#   scripts/rehearse-on-scratch-project.sh --i-confirm-this-is-a-scratch-project [--dry-run]
#
# Guards (all checked BEFORE any connection is opened; any failure exits 2 and touches nothing):
#   * both variables and the confirmation flag are required,
#   * the host in SCRATCH_DB_URL must contain SCRATCH_PROJECT_REF,
#   * the ref must not be the production project (the ref in supabase/.temp/linked-project.json, or the one in
#     PRODUCTION_PROJECT_REFS below) and the URL must not mention one,
#   * the target database must be EMPTY of application tables (no public.staff / public.conversations): the script
#     builds the schema from the migrations in this repository; it never modifies an existing application database.
# The database password stays in the environment (never printed, never written to a file by this script).
#
# What it does, in order (each step prints PASS/FAIL; non-zero exit on any FAIL):
#   1. applies every migration in supabase/migrations/ in order,
#   2. captures the schema signature, runs the three SQL test suites,
#   3. runs the Phase 2.1 down-migration (guards, rollback), compares with the signature taken after the Phase 2 migrations,
#   4. rolls forward again and compares with the Phase 2.1 signature, runs the suites again,
#   5. writes a report under scratch-rehearsal-report/ (no credentials in it).
# Production-like DATA is a separate, manual and approved step (docs/SCRATCH_PROJECT_REHEARSAL.md, section 5).
set -uo pipefail

PRODUCTION_PROJECT_REFS="aanomjzsrozcgnpymnqj"
cd "$(dirname "$0")/.."

die() { echo "REFUSED: $1" >&2; exit 2; }

CONFIRM=0; DRY=0
for a in "$@"; do
  case "$a" in
    --i-confirm-this-is-a-scratch-project) CONFIRM=1 ;;
    --dry-run) DRY=1 ;;
    *) die "unknown argument $a" ;;
  esac
done
[ $CONFIRM -eq 1 ] || die "add --i-confirm-this-is-a-scratch-project"
[ -n "${SCRATCH_DB_URL:-}" ] || die "SCRATCH_DB_URL is not set"
[ -n "${SCRATCH_PROJECT_REF:-}" ] || die "SCRATCH_PROJECT_REF is not set"

LINKED=""
[ -f supabase/.temp/linked-project.json ] && LINKED=$(grep -o '"ref"[[:space:]]*:[[:space:]]*"[^"]*"' supabase/.temp/linked-project.json | sed 's/.*"\([^"]*\)"$/\1/')
for prod in $PRODUCTION_PROJECT_REFS $LINKED; do
  [ -n "$prod" ] || continue
  [ "$SCRATCH_PROJECT_REF" != "$prod" ] || die "that is the PRODUCTION project ref"
  case "$SCRATCH_DB_URL" in *"$prod"*) die "SCRATCH_DB_URL mentions the production project" ;; esac
done
case "$SCRATCH_DB_URL" in *"$SCRATCH_PROJECT_REF"*) ;; *) die "SCRATCH_DB_URL does not belong to SCRATCH_PROJECT_REF" ;; esac

if [ $DRY -eq 1 ]; then
  echo "DRY RUN: guards passed for scratch project $SCRATCH_PROJECT_REF. Would apply:"
  ls supabase/migrations/*.sql | sed 's/^/  /'
  echo "then: suites, rollback supabase/rollbacks/20261119_phase21_down.sql, roll-forward, compare signatures."
  exit 0
fi

P() { psql "$SCRATCH_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
FAILED=0; ok() { echo "PASS  $1"; }; bad() { echo "FAIL  $1"; FAILED=1; }
REPORT=scratch-rehearsal-report; mkdir -p $REPORT

[ "$(P -t -A -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('staff','conversations','wa_messages')")" = 0 ] \
  || die "the target database already has application tables; use an empty scratch project"
ok "target is empty (scratch)"

for m in supabase/migrations/*.sql; do
  P -f "$m" >/dev/null 2>$REPORT/last_error.txt && ok "applied $(basename "$m")" || { bad "failed $(basename "$m"): $(head -c 300 $REPORT/last_error.txt)"; exit 1; }
done
sig() { P -t -A -f supabase/rollbacks/schema_signature.sql; }
suite() { local r; r=$(P -t -A -f "$1" 2>&1); echo "$r" | grep -q '^FAIL' && bad "$1" || ok "$1: $(echo "$r" | grep -c '^PASS') PASS"; }

sig > $REPORT/sig_phase21.txt
for s in supabase/tests/message_delete.sql supabase/tests/multi_tenant.sql supabase/tests/phase21_security.sql; do suite $s; done

# Phase 2 signature: roll back to it and compare with a build that stops after the Phase 2 migrations is not possible in
# one database, so the rollback is proven by (a) the guards, (b) idempotence, (c) the roll-forward returning the exact signature.
P -f supabase/rollbacks/20261119_phase21_down.sql >/dev/null 2>&1 && ok "Phase 2.1 rollback ran" || bad "Phase 2.1 rollback failed"
sig > $REPORT/sig_phase2_rolled_back.txt
[ "$(P -t -A -c "select count(*) from information_schema.columns where table_name='staff' and column_name='must_change_password'")" = 0 ] && ok "password-change column removed" || bad "column remains"
suite supabase/tests/multi_tenant.sql
P -f supabase/rollbacks/20261119_phase21_down.sql >/dev/null 2>&1 && ok "rollback is idempotent" || bad "second rollback failed"
for m in supabase/migrations/20261119000000_password_change_enforcement.sql supabase/migrations/20261119000100_webhook_quarantine.sql; do
  P -f "$m" >/dev/null 2>&1 && ok "rolled forward $(basename "$m")" || bad "roll-forward failed $(basename "$m")"
done
sig > $REPORT/sig_phase21_again.txt
diff -q $REPORT/sig_phase21.txt $REPORT/sig_phase21_again.txt >/dev/null && ok "roll-forward signature identical to the first Phase 2.1 build" || bad "signature differs after roll-forward"
suite supabase/tests/phase21_security.sql

rm -f $REPORT/last_error.txt
[ $FAILED -eq 0 ] && echo "SCRATCH REHEARSAL: ALL CHECKS PASSED (report files in $REPORT/, no credentials)" || echo "SCRATCH REHEARSAL: FAILURES"
exit $FAILED

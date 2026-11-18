# Phase 2.1 security report

Date: 2026-11-18. Scope: your 8 decisions and execution rules for Phase 2.1.
**Everything below was done and tested on the LOCAL stack only.** Not done, by your rules: no migration applied to hosted Supabase, no production secret changed, no Meta setting touched, nothing committed, pushed or deployed, Phase 3 not started. Evidence files are in `docs/evidence/phase21/`.

## 1. Summary

| # | Your decision | Result |
| --- | --- | --- |
| 1 | Fix F1: server-side mandatory password change | **Done locally.** A temporary-password login reads nothing and cannot unlock itself; only a server function can. 23/23 live probe checks, 38 SQL checks, mutation-tested. |
| 2 | Fix F8: webhook routing by Phone Number ID, never silently discard, secure logging, diagnostics | **Done locally.** Unroutable events are quarantined (kept 7 days, service role only), tagged with a reason and event id, replayable by an admin; logs carry no customer data. |
| 3 | Scratch Supabase project for rehearsals | **Prepared, not run.** Guarded script and runbook exist; creating the project needs you (section 7). Local rollback rehearsal done instead (22/22). |
| 4 | Prepare Meta verification / Tech Provider / App Review | **Prepared, nothing submitted or changed.** `META_VERIFICATION_PREPARATION.md`. |
| 5 | Own HTTPS onboarding page launching Meta's Embedded Signup | **Designed** (`ONBOARDING_PAGE_DESIGN.md`); not built; feature flag stays off. |
| 6 | Explicit consent for history sync; retention, privacy, deletion | **Policy and enforcement design written** (`PRIVACY_RETENTION_AND_CONSENT_POLICY.md`); consent table and enforcement are Phase 3. Quarantine/ledger retention is implemented now. |
| 7 | Manual billing now, per-client/per-number later | **Architecture written** (`BILLING_ARCHITECTURE.md`); no billing code. |
| 8 | Preserve Owner (test) tenant and test connection | **Preserved.** Data fingerprint identical before/after the migrations, the rollback and the roll-forward (see 4.4). |

## 2. F1: forced password change is now enforced by the database

**Before (proved in Phase 2):** a login on a temporary password could call the data API (HTTP 200) and could clear its own flag in `user_metadata`.

**Now:**
* `staff.must_change_password` is a column no browser login can write (PATCH, RPC and `user_metadata` writes all fail).
* While true, `current_tenant_ids()` is empty and `is_admin()`/`is_active_staff()` are false, so every table policy, RPC, storage rule and Realtime event is closed. The check is a live lookup, so it also covers sessions that already exist (for example after an admin resets a password).
* `admin-staff`, `admin-connections`, `webhook-replay`, `send-whatsapp`, `mark-read` refuse or give no tenant to a locked login.
* The only exit is `complete-password-change`: valid JWT; session issued within 30 minutes; login exists, enabled and flagged; 8-72 characters; not equal to the temporary password (verified by a sign-in probe); 10 attempts per 15 minutes per login. It sets the password, clears the flag, ends the old sessions and writes an audit entry without the password. The page then signs in again with the new password (the server ends the old session, found by the browser test).
* New accounts and password resets always set the flag (`create_client_account` default true; `reset_password` sets it before changing the password, so the account is locked first).
* Existing logins (ADMIN1, the Owner (test) users) keep `false`.

**Evidence:** `01_f1_probe.txt` (23 checks against real Auth, PostgREST and Edge Functions: locked session reads 0 conversations/connections, cannot start a chat, cannot send, cannot clear the flag by metadata, PATCH or RPC, cannot unlock through Auth's own password endpoint, locked admin cannot use admin RPCs, functions or diagnostics; the unlock function refuses the temporary password, short passwords, anonymous callers and a second use; after the unlock the new password works and the old one does not). `03_sql_phase21_security.txt` (38). Playwright: the forced-change screen is checked with the session's own token (0 rows, flag unchanged) before the password is set.

## 3. F8: webhook routing without silent loss

**Before:** an event whose Phone Number ID matched no connection (or WABA mismatch, or inactive connection) was acknowledged and discarded. A wrong `WA_PHONE_ID` would have dropped every message of the test number invisibly.

**Now:**
* Routing key is the Phone Number ID in the payload; the connection (and so the tenant) is resolved in the database; the entry's WABA id must match.
* Six failure reasons (`no_phone_number_id`, `unknown_phone_number_id`, `waba_mismatch`, `connection_inactive`, `tenant_suspended`, `legacy_bind_failed`): the change set goes to `webhook_quarantine` (service role only, 7-day expiry, 20000 cap), the ledger row records outcome, reason, event id and quarantine id, and Meta gets 200.
* If the quarantine cannot be written the webhook answers **500**, so Meta retries; the event is never lost silently.
* `legacy_bind_failed` (an event for `WA_PHONE_ID` that cannot bind the legacy connection) logs an `ALERT` line.
* Admin **Webhooks** tab (`admin_routing_diagnostics()`): counts, reasons, unknown Phone Number IDs, quarantine age, connections without a Phone Number ID or silent for 7 days. Metadata only; verified not to contain message text or customer numbers.
* **Replay** (`webhook-replay`): after the number is attached to a client, quarantined events go through the same code path as live ones and are stored under the right tenant; the payload is erased after success; a second replay finds nothing.
* Logs: structured JSON with ids and reasons; a test searches the captured log output for the message text and the customer number and finds neither.
* Retention (F3): ledger 30 days, quarantine 7 days, best-effort hourly purge.
* F9 decision implemented: events for a suspended client are quarantined 7 days instead of dropped.

**Evidence:** Deno webhook tests (two Phone Number IDs into separate tenants, every reason, replay, 500 on quarantine failure, log content), `02_tenant_isolation_and_routing_integration.txt` (real HTTP: unknown number quarantined with its reason, diagnostics list it as pending, clients cannot read the quarantine or diagnostics or replay, replay while unroutable loses nothing, after attaching the number the message lands in the right tenant and connection, payload erased, second replay finds nothing, WABA mismatch quarantined).

## 4. Test results

### 4.1 All suites (local)

| Suite | Result | File |
| --- | --- | --- |
| Deno unit tests | **148 passed, 0 failed** (Phase 2.1 added tests for the password unlock, replay, locked-admin refusals, multi-Phone-Number-ID routing, quarantine reasons, 500 on quarantine failure and log content) | `06_deno_tests.txt` |
| SQL `phase21_security.sql` (new) | **38 PASS** | `03_...` |
| SQL `multi_tenant.sql` | **92 PASS** | `04_...` |
| SQL `message_delete.sql` | **25 PASS** | `05_...` |
| F1 live probe | **23/23** | `01_f1_probe.txt` |
| Tenant isolation + multi-Phone-Number-ID routing, real HTTP | **117/117** | `02_...` |
| Static: `deno check` all functions, `deno lint`, `tsc`, ESLint, web build, `check:sql` (10 migrations) | all clean | `10_static_checks.txt` |
| Playwright, full suite, desktop 43 + phone 43 | **86 passed, 0 failed, 0 skipped, 0 flaky** (8.1 min) | `11_playwright.txt` |
| Rollback rehearsal | **22 PASS, 0 FAIL** | `08_rollback_rehearsal.txt` |

### 4.2 Tenant isolation re-tested
The 117 real-HTTP checks and 92 SQL checks re-run on the Phase 2.1 schema: two clients cannot read, write, send into, mark read, search, subscribe to or download each other's data; the audit log is insert-only; tokens never reach a client.

### 4.3 Webhook routing for multiple Phone Number IDs
Deno and real HTTP: each Phone Number ID stores into its own connection and tenant; the same customer number on two numbers gives two separate chats; a replayed message id on another number does not copy or change the original; unknown, mismatched, inactive and suspended connections are quarantined and replayable.

### 4.4 Rollback rehearsal (local) - `08_rollback_rehearsal.txt`, 22/22
* Guard 1: a pending quarantined event makes the rollback refuse; schema unchanged; event kept.
* Guard 2: a login with a temporary password makes the rollback refuse (it would re-open F1); schema unchanged.
* Rollback: the schema signature (521 lines) is **identical to the Phase 2 baseline** taken before Phase 2.1; the data fingerprint is identical before and after; the Phase 2 suites (92 + 25) pass on the rolled-back schema.
* Second rollback is a no-op (idempotent; this found and fixed a real bug in the guard).
* Roll-forward restores the exact Phase 2.1 schema and data fingerprint; 38 + 92 checks pass again.
* The Owner (test) tenant and its legacy connection are in the fingerprint and unchanged throughout.
* Caveat: the fingerprint is compared on the same state before/after, because test runs add chats to the local database after my original baseline; the schema signature is compared to the original baseline.

### 4.5 Browser tests
First full run: 84 passed, 2 failed. The two failures were a real defect in my web change: after the unlock the app kept the "no client account" state loaded while locked, and the unlocked session had been ended by the server. Fixed (reload tenant context, sign in again with the new password); `tenancy.spec.ts` then passed 8/8. The final full run after the fix: **86 passed, 0 failed, 0 skipped** (43 desktop + 43 phone), `11_playwright.txt`.

### 4.6 Mutation tests - `09_mutation_tests.txt`
Seven deliberate regressions, each caught: `current_tenant_ids()` ignoring the flag (6 SQL failures), `is_admin()` ignoring it (2), unlock accepting the temporary password (2 Deno failures), unlock accepting a stale session, `admin-staff` and `webhook-replay` serving a locked admin, the webhook dropping instead of quarantining (4 failures). Every mutation was reverted and the suites re-run green.

### 4.7 Final consolidated run (2026-11-18 17:08 UTC) - `12_final_run.txt`
SQL 38 + 92 + 25 PASS, 0 FAIL; Deno 148 passed, 0 failed; F1 live probe 23 PASS, 0 FAIL; integration 117 passed, 0 failed; `check:sql` OK (10 migrations); `deno check` OK; `deno lint` clean (34 files); web `tsc`, ESLint and build OK; rollback rehearsal 22 PASS, 0 FAIL; Phase 2.1 SQL suite 38 PASS again after the rehearsal's roll-forward.

### 4.8 Failing, skipped and unverified
* **Failing:** none in the final runs. Earlier failures (all fixed and re-run): 2 Playwright tests (web defect, section 4.5), the rollback script's second run and fingerprint comparison (script/guard defects, section 4.4), a Deno fixture and one webhook test expectation. 
* **Skipped:** none (Playwright reports 0 skipped; no `ignore` in Deno tests).
* **Unverified (not run, by design or by limits):** anything on hosted Supabase; the scratch-project rehearsal end to end; real Meta traffic and a real token (expired); the Android APK; load/performance; the hosted Vault key behavior; the multi-instance rate limit of the unlock function; M1/M2 were SQL mutations proved by the SQL suite only (no browser run per mutation).
* **Note on M7 evidence:** the first M7 attempt mutated a comment and proved nothing; it was discarded and redone as a real mutation (quarantine write removed): 4 failures. `09_mutation_tests.txt` holds only the valid 7 results.

## 5. Files changed (summary)
Migrations `20261119000000_password_change_enforcement.sql`, `20261119000100_webhook_quarantine.sql`; `whatsapp_setup.sql` regenerated; down script `supabase/rollbacks/20261119_phase21_down.sql` and `rehearse_phase21_local.sh`; Edge Functions `whatsapp-webhook`, `complete-password-change` (new), `webhook-replay` (new), `admin-staff`, `admin-connections`, `send-whatsapp`, `mark-read`, shared store; web `App.tsx`, `ForcePasswordChange.tsx`, `api.ts`, `adminApi.ts`, admin Webhooks tab; scripts `probe-temp-password-local.mjs`, `verify-multi-tenant-local.mjs`, `rehearse-on-scratch-project.sh`; tests (Deno, SQL, Playwright); docs listed in `docs/README.md` (rows 30-35) plus updates to the review, webhook, security, migrations, backup, testing, readiness, Phase 3 plan, backend, database and known-issues documents.

## 6. What is NOT done or NOT proven

* **Hosted Supabase has neither the Phase 2 nor the Phase 2.1 migrations.** Nothing was deployed, so none of this protects the live project yet.
* **Scratch-project rehearsal has not run**: no hosted scratch project exists. The script's guards are tested (`07_scratch_script_guards.txt`); the full flow is the same SQL proven locally, but hosted behavior (managed Vault key, extension versions) is unproven.
* The real Meta path is untested: the test number's `WA_TOKEN` is expired, no real webhook from Meta was exercised against Phase 2.1.
* The unlock rate limit is per function instance (Auth rate-limits sign-ins too). A stolen temporary password inside its 30-minute window can still be used to choose a new password: reset it if exposure is suspected.
* Findings still open: F2 (require WABA id), F4, F5, F6, F7 (accepted), F12 (hosted `rls_auto_enable()`).
* Consent table, history-sync enforcement, onboarding page and billing tables are designs, not code.
* Policy periods (7/30 days, 2-year audit, 30-day grace) and all legal wording are proposals needing your decision and legal review.

## 7. What I need from you
1. **Approve Phase 2.1** (or tell me what to change).
2. A decision on **the scratch project**: create one yourself and give me its ref and connection string through the secure credential prompt, or tell me to wait.
3. For the hosted rollout (not started): approval of the sequence in `MULTI_TENANT_MIGRATIONS.md` section 6 plus Phase 2.1, after the scratch rehearsal.
4. Meta preparation inputs listed in `META_VERIFICATION_PREPARATION.md` (legal entity details, domain, privacy/terms pages).
5. Whether to **commit** this work (currently uncommitted, as instructed).

## 8. Final hygiene checks
* **Secret scan** of all 149 changed or new files (JWT-shaped strings, Meta `EAA` tokens, Supabase keys, private keys, cloud keys, URLs with passwords, plus exact-value searches for the ADMIN1 password, the `WA_TOKEN` and the local service key): **no secret found.** Only matches are the placeholder `postgresql://postgres:<password>@...` in the scratch script header and the pre-existing local default `postgres:postgres@127.0.0.1` in `package.json`. `.env` files are git-ignored and untracked.
* **git status:** branch `ccr-929f1931-uztnem`, **0 commits ahead of origin, nothing committed or pushed**: 29 modified files and 30 untracked paths, all Phase 2/2.1 work. Nothing deployed, no hosted migration, no Meta setting and no production secret touched.
* The local Supabase stack and the served functions are still running in this container (local only).

I am stopping here and waiting for your approval before anything else.

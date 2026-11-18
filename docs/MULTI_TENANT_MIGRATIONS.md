# Multi-tenant migrations: details, rehearsal and hosted plan

> **Applied to the LOCAL database only.** Nothing was applied to the hosted Supabase project; the hosted plan in section 6 needs the owner's explicit approval.
> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). Related: [MULTI_TENANT_ARCHITECTURE.md](MULTI_TENANT_ARCHITECTURE.md) ·
> [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md) (the older four migrations)

## 1. The four new migration files

All are idempotent (re-running changes nothing) and live in `supabase/migrations/`; `whatsapp_setup.sql` was regenerated and `npm run check:sql` confirms it matches all 8 migrations.

| # | File | What it does |
| --- | --- | --- |
| 5 | `20261118000000_tenants_core.sql` | Creates `tenants`, `tenant_memberships`, `whatsapp_connections`, `audit_logs`, `webhook_events`, `push_devices`; helpers `current_tenant_ids()` / `current_tenant_id()`; adds **nullable** `tenant_id` (+ `connection_id` on conversations) to `conversations`, `wa_messages`, `quick_replies`; creates the **Owner (test)** tenant, gives every existing login a membership, creates the legacy test-number connection, and **backfills** the new columns. Changes no existing value. |
| 6 | `20261118000100_vault_tokens.sql` | Enables `supabase_vault`; creates `store_connection_token`, `get_connection_token`, `revoke_connection_token` (service role only). |
| 7 | `20261118000200_tenant_isolation.sql` | Makes the new columns `NOT NULL`; adds composite foreign keys; per-connection / per-tenant uniqueness; **replaces every read policy** with tenant-scoped ones; column-level grants on `whatsapp_connections`; storage policies by message tenant; **rewrites 11 RPCs** to take the tenant from the login; new service-role versions of `ingest_incoming`, `create_outgoing`, `apply_message_status(+connection)`, `apply_customer_reaction(+connection)`. |
| 8 | `20261118000300_routing_admin.sql` | `resolve_connection`, `bind_legacy_connection`, `record_webhook_event`, `purge_webhook_events`, `set_connection_state`, `write_audit`, `create_client_account`, `admin_overview`, `admin_tenant_summary`, `admin_set_tenant_status`, `register_push_device`, `unregister_push_device`. |

### Objects changed or removed
| Kind | Change |
| --- | --- |
| Dropped constraint/index | `conversations_wa_id_key` (unique wa_id), `conversations_wa_user_id_key`, `quick_replies_shortcut_key` - replaced by per-connection / per-tenant versions |
| Dropped function signatures | `apply_message_status(text,text,text)` and `apply_customer_reaction(text,text)` - replaced by versions with a `connection_id` argument (**old Edge Functions can no longer call them**: see the deployment order) |
| Replaced functions (same signature) | `ingest_incoming(jsonb)` now requires `connection_id` in the payload; `create_outgoing(jsonb)`; `mark_conversation_read`, `take_conversation`, `release_conversation`, `rename_contact`, `update_conversation_info`, `delete_message_for_me`, `restore_message_for_me`, `set_message_flags`, `save_quick_reply`, `delete_quick_reply`, `start_conversation` |
| Unchanged | `search_messages`, `unread_counts`, `visible_last_messages` (they are `SECURITY INVOKER`, so the new tenant policies apply to them automatically), `message_preview`, `is_active_staff`, `is_admin`, all tables' existing columns and values |
| Policies replaced | `staff_select`, `conversations_select`, `wa_messages_select`, `quick_replies_select`, `conversation_reads_select`, `message_flags_select`, `files_staff_read`, `files_staff_upload` |

### Phase 2.1 migrations (added 2026-11-18, local only)

| # | File | What it does |
| --- | --- | --- |
| 9 | `20261119000000_password_change_enforcement.sql` | `staff.must_change_password` (no client write grant); `current_tenant_ids()`, `is_active_staff()`, `is_admin()` close when it is true; `create_client_account` gets `p_must_change_password` (default true); `set_must_change_password` (service role only). Existing logins keep `false`. |
| 10 | `20261119000100_webhook_quarantine.sql` | `webhook_quarantine` (service role only, 7-day expiry), ledger columns `event_id/reason/quarantine_id`, new `record_webhook_event`, `quarantine_webhook_change`, `claim_quarantine`, `finish_quarantine_replay`, `purge_expired_webhook_data`, `admin_routing_diagnostics`. |

Down script: `supabase/rollbacks/20261119_phase21_down.sql` (guards refuse if pending quarantined events exist or any login still has a temporary password). Rehearsal: `supabase/rollbacks/rehearse_phase21_local.sh`. Hosted rehearsal on a scratch project: [SCRATCH_PROJECT_REHEARSAL.md](SCRATCH_PROJECT_REHEARSAL.md). **Not applied to hosted.**

## 2. What happens to existing data
- **No row is deleted. No existing column value is modified.** The only writes to existing tables are filling the **new** columns (`tenant_id`, `connection_id`).
- Message ids, `wa_message_id`s, statuses, `media_path`s, flags, read positions and Storage objects are untouched. Storage objects are **not moved**: the new storage policy decides access from the message that references the file, so existing paths stay valid.
- Every existing login becomes a member of **Owner (test)** (the platform admin as `owner`, the others as `agent`). Everything the owner saw before, they still see.
- The legacy connection is created **without reading any secret**: its phone number id is learned from the first webhook carrying `WA_PHONE_ID`. `WA_TOKEN` / `WA_PHONE_ID` are not moved, copied or changed.

## 3. Local rehearsal and results (all run on the local stack)
Local data used (simulated test traffic from earlier work, so far larger than the hosted 4 chats): **5,394 messages, 634 conversations, 585 read markers, 96 message flags, 6 quick replies, 21 logins, 452 stored files**.

| Check | Command / file | Result |
| --- | --- | --- |
| Backup first | `pg_dump` of `public`, `auth`, `storage` before applying | Taken (771 KB; kept outside the repo) |
| Pre/post fingerprint of **every pre-existing table and file** (md5 over all original columns in id order, `tenant_id`/`connection_id` excluded; plus "every media path points at an existing Storage object") | `supabase/tests/tenant_migration_fingerprint.sql` | **Identical before and after**: `wa_messages|5394|…`, `conversations|634|…`, `message_flags|96|…`, `conversation_reads|585|…`, `quick_replies|6|…`, `staff|21|…`, `storage_objects|452|…`, `media_links_ok|452|452` |
| Every existing row got a tenant; messages agree with their conversation | SQL counts | 0 rows without tenant/connection; 0 mismatches; 1 tenant, 21 memberships, 1 connection |
| Idempotency: all four files run a second time | psql `--single-transaction` | All succeed; fingerprint still identical; no duplicate tenant, connection or membership |
| Old delete-for-me suite on the new schema | `supabase/tests/message_delete.sql` (fixtures updated for tenants) | 25/25 pass |
| New isolation suite | `supabase/tests/multi_tenant.sql` | **92/92 pass** |
| Does the suite actually detect breakage? (mutation test: policy opened to all staff; status function ignoring the connection) | manual, then restored from the migration | Both mutations made the suite fail; restoring from the migration made it pass again |
| A real bug found by re-running a migration | re-applying file 7 re-granted UPDATE/DELETE on `audit_logs` to the service role, undoing file 8's revoke | **Fixed**: file 7 now grants only SELECT/INSERT on `audit_logs`; verified |

## 4. How to run the checks yourself (local stack only)
```
supabase start                         # local Postgres 17, Auth, Storage, Realtime
psql ... -X -q -t -A -f supabase/tests/tenant_migration_fingerprint.sql > before.txt
# apply the four new migrations
psql ... -X -q -t -A -f supabase/tests/tenant_migration_fingerprint.sql > after.txt ; diff before.txt after.txt
npm run test:sql                       # delete-for-me suite + multi-tenant suite
```
The browser and API-level checks need `supabase functions serve` and a local `.env` pointing at `127.0.0.1`. **Never run the simulators or the end-to-end tests with the repository's `.env` / `web/.env`**: they point at the hosted project and would write to it. `scripts/verify-multi-tenant-local.mjs` and `web/e2e/tenancy.spec.ts` refuse to run unless the URL is `127.0.0.1` / `localhost`.

## 5. Differences between local and hosted that matter
| Item | Local | Hosted (as last observed) |
| --- | --- | --- |
| Data | 5,394 simulated messages | 4 real test chats, 2 logins, 2 storage objects |
| Migration history table | present (CLI applies) | **absent** (migrations were run as SQL); see [DEPLOYMENT_AND_OPERATIONS.md](DEPLOYMENT_AND_OPERATIONS.md) |
| `supabase_vault` extension | installed (0.3.1) | **Unverified**: the extension must be available/enabled on the hosted project; `create extension` in file 6 will fail loudly if it is not |
| `service_role` access to Vault tables | granted by the platform; cannot be revoked by a migration (owner is `supabase_admin`) | expected the same; **Unverified** |
| Realtime | local image | hosted Realtime must be tested after applying (the policies call `current_tenant_ids()`, which is `SECURITY DEFINER`; verified locally with signed-in clients) |

## 6. Hosted plan (NOT executed; needs explicit approval)
Because the migration drops two function signatures and `ingest_incoming` now requires a connection, **old Edge Functions and the new database cannot run together**. Order, in one short maintenance window:
1. Back up (database **and** Storage listing); record the counts and the fingerprint from section 3 against the hosted data.
2. Confirm `supabase_vault` is available on the project.
3. Apply files 5-8 in order, single transaction each; compare the fingerprint (must be identical) and run the isolation SQL suite **on a copy**, not on live data (the suite rolls back, but prefer a restored copy).
4. Immediately deploy the five Edge Functions (`whatsapp-webhook`, `send-whatsapp`, `mark-read`, `admin-staff`, `admin-connections`; `wa-diagnose` is unchanged) with the same `verify_jwt` settings as `supabase/config.toml`.
5. Deploy the web app (the login now asks for Staff ID and password).
6. Verify: `wa-diagnose`; a signed test webhook for the test number must bind the legacy connection and store (Meta retries failures with HTTP 500, so a short gap loses nothing in principle; **the retry schedule is unverified**); sign in as the admin; check the Owner (test) chats.
7. Do **not** set `ALLOW_MANUAL_TOKEN` or `FEATURE_EMBEDDED_SIGNUP` on the hosted project.

**Rollback:** the migrations are additive, but **no down-migration script was written or tested**. The tested way back is restoring the step-1 backup. A hand-written reverse (drop the new policies/functions, re-create the old ones from `20261114`-`20261117`, drop the composite foreign keys and new columns) is possible but untested; do not rely on it.

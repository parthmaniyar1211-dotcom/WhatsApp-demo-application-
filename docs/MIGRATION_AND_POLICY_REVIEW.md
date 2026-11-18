# Review of the four multi-tenant migrations and the security policies

> Review date 2026-11-16, on the **local** database. Method: read every migration, then interrogate the live catalog (RLS flags, function settings, privilege matrix, policy text, column grants), then probe suspected weaknesses with real API calls. **No code was changed as a result of this review**; the findings are proposals for your approval.
> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). Related: [MULTI_TENANT_MIGRATIONS.md](MULTI_TENANT_MIGRATIONS.md) · [MULTI_TENANT_SECURITY.md](MULTI_TENANT_SECURITY.md) · [BACKUP_AND_ROLLBACK_PLAN.md](BACKUP_AND_ROLLBACK_PLAN.md)

## 1. Catalog checks (all measured, local)

| Question | Answer |
| --- | --- |
| Public tables without row level security | **None** (12 of 12 have it on) |
| `SECURITY DEFINER` functions without a pinned `search_path` | **None** |
| Functions in `public` executable by `anon` | **None** |
| Table privileges of `authenticated` | `SELECT` only, on 11 tables; **no INSERT/UPDATE/DELETE anywhere**. `whatsapp_connections` has a **column-level** SELECT grant (15 columns; `vault_secret_id` and `token_rotated_at` excluded) |
| Table privileges of `anon` | **None** |
| `service_role` on `audit_logs` | `SELECT`, `INSERT` (plus the harmless `REFERENCES`/`TRIGGER`); **no UPDATE/DELETE/TRUNCATE** |
| Functions executable by `authenticated` | 23: the client RPCs, `search_messages`/`unread_counts`/`visible_last_messages` (invoker), the admin report RPCs (which check `is_admin()` inside) and the two push RPCs. **No token, ingest, routing, audit or account-creation function** |
| Vault secrets without a live connection (orphans) | 0 |
| Migrations idempotent (run twice) | Yes, verified, and re-verified after a rollback and roll-forward |

## 2. Migration by migration

### 5. `20261118000000_tenants_core.sql` (additive)
- Creates the six tables, the two helper functions and the Owner (test) backfill. Backfill touches only the **new** columns.
- Good: UNIQUE `user_id` on memberships (one tenant per login) makes `current_tenant_id()` unambiguous; partial unique indexes enforce one `platform_env` connection and one connection per phone number id; `ON DELETE RESTRICT` from connections/conversations to tenants prevents accidental cascades.
- Watch: the backfill relies on the fixed slug `owner-test`; the legacy connection is created without a phone number id (bound later). If the hosted `WA_PHONE_ID` is unset the test number would never bind (finding F8).

### 6. `20261118000100_vault_tokens.sql`
- Three functions, service-role only. `store_connection_token` locks the connection row (`FOR UPDATE`), validates length, creates or **updates in place**, clears `last_error`. `get_connection_token` refuses revoked connections. `revoke_connection_token` deletes the secret.
- Limit (documented): `service_role` retains the platform's direct grant on the Vault views; see [VAULT_BOUNDARY_AND_RECOVERY.md](VAULT_BOUNDARY_AND_RECOVERY.md).
- Watch: nothing deletes a Vault secret if someone deletes a connection row directly (F4).

### 7. `20261118000200_tenant_isolation.sql` (enforcement)
- Makes columns NOT NULL, adds composite foreign keys (a chat's connection must be of the chat's tenant; a message's tenant must equal its chat's), moves uniqueness to per-connection/per-tenant, replaces the 8 existing policies and adds 6 new ones (14 in total), rewrites 11 RPCs and 4 service functions.
- Reviewed each RPC for the same pattern: derive tenant from `current_tenant_id()`; "not allowed" (42501) with no tenant; "not found" (P0002) for a resource of another tenant; no tenant parameter. All 11 follow it. `search_messages`, `unread_counts` and `visible_last_messages` stay `SECURITY INVOKER` so the new policies apply to them without code changes (tested).
- Good: storage read policy decides by the message that references the file (existing paths stay valid; no object was moved), plus the user's own pending upload folder.
- Bug found while reviewing a re-run (fixed earlier): re-applying this file re-granted UPDATE/DELETE on `audit_logs` to the service role, undoing file 8. It now grants only SELECT/INSERT.
- Watch: dropping `apply_message_status(text,text,text)` and `apply_customer_reaction(text,text)` breaks the **old** Edge Functions the moment the migration is applied (deployment order, documented).

### 8. `20261118000300_routing_admin.sql`
- Routing (`resolve_connection`, `bind_legacy_connection`), the ledger, `write_audit`, `create_client_account` (staff + tenant + membership in one transaction), admin reports, push registration.
- Good: admin reports return counts only; `admin_set_tenant_status` writes its audit row in the same transaction; `register_push_device` re-assigns a token to the latest login.
- Watch: `record_webhook_event` has no retention (F3); `create_client_account` trusts its caller (service role only, granted to nobody else, verified).

## 3. The policies, in full

| Table | Policy | Rule |
| --- | --- | --- |
| `conversations`, `wa_messages`, `quick_replies` | `*_select` | `tenant_id in (select current_tenant_ids())` |
| `conversation_reads`, `message_flags` | `*_select` | own rows **and** the login has an active tenant |
| `staff` | `staff_select` | own row, or platform admin, or a member of the same tenant |
| `tenants`, `tenant_memberships`, `whatsapp_connections` | `*_select` | own tenant, or platform admin |
| `audit_logs`, `webhook_events` | `*_select` | platform admin only |
| `push_devices` | `push_devices_select` | own rows |
| `storage.objects` | `files_staff_read` | bucket `files`, active tenant, and (own pending upload folder **or** a file referenced by a message of the caller's tenant) |
| `storage.objects` | `files_staff_upload` | bucket `files`, active tenant, only into `outgoing/<own user id>/` |
`current_tenant_ids()` returns nothing for a disabled login, a disabled membership or a suspended tenant, so all of the above close at once. There is **no INSERT/UPDATE/DELETE policy and no write grant** on any table: all writes go through functions.

## 4. Findings (ranked) with proposed fixes

| # | Severity | Finding | Evidence | Proposed fix |
| --- | --- | --- | --- | --- |
| F1 | **Medium — FIXED in Phase 2.1 (local, not deployed)** | **The forced password change is enforced only by the UI**, and the flag lives in `user_metadata`, which a user can write. A client on a temporary password can already call the data API, and can clear its own flag without changing the password. | Probed live: HTTP 200 on data reads with a temporary-password session; `PUT /auth/v1/user {data:{must_change_password:false}}` returned 200 and cleared it; `app_metadata` writes were refused (403 `not_admin`). | Store the flag in `app_metadata` (server-only) and make `current_tenant_ids()` and the Edge Functions treat such a session as having no tenant; add a `complete-password-change` function that sets the password and clears the flag with the admin API. Add a test that a temporary session reads nothing. |
| F2 | Low-Medium | The WABA cross-check in the webhook is skipped when the connection has no `waba_id`, and an admin can create a connection with only a phone number id. | Code: `connection.wabaId && wabaId && ...`. | Require `waba_id` before a connection can become `connected` (database check + `admin-connections`). Embedded Signup always supplies both. |
| F3 | Low — **FIXED in Phase 2.1** (hourly best-effort purge: ledger 30 d, quarantine 7 d) | `webhook_events` grows without limit (one row per change set; 211 rows after local testing); `purge_webhook_events` exists but nothing schedules it. | Row count; `pg_cron` is available but not enabled. | Schedule the purge (30 days) with `pg_cron` or a scheduled function; alert on a rising `unrouted` count. |
| F4 | Low | Deleting a connection row by hand would leave its Vault secret behind (no foreign key or cleanup). No code path deletes connections today. | Review of the schema; orphan query returns 0. | Add `delete_connection` that revokes the secret first; add an orphan check to the health query. |
| F5 | Low | Audit rows for staff actions are written **after** the action (Auth API calls cannot share the database transaction). If the audit insert failed, the action stays applied but the request returns 500. | `admin-staff` handler order. | Log the audit failure loudly and return success, or write an "intent" row first. Decide the policy. |
| F6 | Low (cosmetic) | "No WhatsApp number is connected" is raised as `P0002`, which PostgREST reports as HTTP 500 (message still shown to the user). | Probed live. | Raise with a custom errcode that maps to a 4xx. |
| F7 | Medium (accepted, documented) | The service-role key can read decrypted tokens through the platform's direct Vault grant. | Catalog; revoke attempt was a no-op (owner is `supabase_admin`). | Keep the key only in Edge Functions; rotate if exposed; see the Vault document. |
| F8 | **Medium (operational) — FIXED in Phase 2.1 (local, not deployed)** | If the hosted `WA_PHONE_ID` secret is missing or different from the number Meta calls with, the legacy test connection never binds and its webhooks are **acknowledged (200) and dropped**, with only a ledger row. | Code path: `routeChange` returns null -> `ignored`. | Before deploying, confirm the secret. Add: when an event's phone number id equals `WA_PHONE_ID` but binding fails, answer 500 so Meta retries. Alert on `unrouted`. |
| F9 | Low (design choice) — **DECIDED in Phase 2.1**: events for a suspended client are quarantined for 7 days (service-role only), then erased | A suspended client's inbound messages are acknowledged and **not stored**. | Behaviour tested. | Decide: keep (privacy of a locked-out client) or buffer them. |
| F10 | Low | `unread_counts`, `visible_last_messages`, `admin_tenant_summary` do per-tenant sub-selects; fine now, but untested beyond local data size (about 6,000 messages). | Local data only. | Load-test with realistic volumes before many clients; add indexes if needed. |
| F11 | Info | Per-user rate limit (20/min) is per login, not per number; WhatsApp limits apply per number (and Coexistence caps throughput at 20 messages per second per Meta). | Code. | Add a per-connection guard in Phase 3. |
| F12 | Info | `rls_auto_enable()` (hosted only, executable by `anon`, origin unknown) from the earlier audit is still unresolved; it does not exist locally. | Earlier audit. | Investigate on the hosted project before production. |

**Not found:** no table without RLS, no unpinned definer function, no anon exposure, no write grants for clients, no cross-tenant read or write path in 92 SQL checks, 100 real-HTTP checks and the browser suites.

## 5. Recommended hardening before real clients (proposal, needs your approval)
Fix F1, F2, F3, F8 (and optionally F4-F6) as a small "Phase 2.1" with tests; nothing in Phase 3 depends on it, but F1 and F8 should be closed **before** any real client exists. Estimated size: small (about one working day), no schema redesign.

## 6. Phase 2.1 status of these findings (added 2026-11-18)

| # | Status | How it was closed | Evidence |
| --- | --- | --- | --- |
| F1 | **Closed locally** | `staff.must_change_password` (no client write privilege) is checked live by `current_tenant_ids()`, `is_active_staff()` and `is_admin()`; only the `complete-password-change` function can clear it; Edge Functions refuse locked logins. | `docs/evidence/phase21/01_f1_probe.txt` (23/23), `03_sql_phase21_security.txt` |
| F3 | **Closed locally** | `purge_expired_webhook_data` called best-effort hourly from the webhook (no pg_cron dependency). | `phase21_security.sql` |
| F8 | **Closed locally** | Unroutable events are quarantined (never dropped), ledger carries reason + event id, `legacy_bind_failed` is an ALERT log, quarantine failure answers 500 so Meta retries, admin diagnostics + replay. | `02_tenant_isolation_and_routing_integration.txt`, Deno webhook tests |
| F2, F4, F5, F6 | Open (not in the Phase 2.1 scope you approved) | - | - |
| F7, F12 | Open (accepted / hosted investigation) | - | - |

Nothing above is deployed. See `docs/PHASE2_1_SECURITY_REPORT.md`.

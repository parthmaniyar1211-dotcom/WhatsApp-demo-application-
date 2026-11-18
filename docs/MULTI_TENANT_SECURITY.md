# Multi-tenant security: model, tests and limits

> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). All results below come from the **local** stack (real Auth, PostgREST, Storage, Realtime, Vault and Edge Functions served locally with `WA_DRY_RUN=true`).
> **Nothing was tested against hosted Supabase or against Meta.** Related: [MULTI_TENANT_ARCHITECTURE.md](MULTI_TENANT_ARCHITECTURE.md) ·
> [SECURITY_DOCUMENTATION.md](SECURITY_DOCUMENTATION.md) (the single-tenant baseline) · [META_TECH_PROVIDER_REQUIREMENTS.md](META_TECH_PROVIDER_REQUIREMENTS.md)

## 1. Security rules and where each is enforced

| Rule (from the brief) | Enforced by | Verified by |
| --- | --- | --- |
| Admin has authorised administrative access | `is_admin()` inside `admin_*` RPCs; `admin-staff` / `admin-connections` check the role in code; **JWT verification on** | SQL suite, Deno tests, integration script, browser test |
| Staff accesses only their own tenant | RLS `tenant_id in (select current_tenant_ids())` on conversations, messages, quick replies, connections, memberships, staff; storage policy by message tenant | SQL (92 checks, of which most are read, write and IDOR checks), integration (24 REST/RPC attack checks), browser |
| One client's messages cannot reach another | same, plus composite foreign keys, plus Realtime RLS | SQL, integration (Realtime: nothing at all delivered to the other tenant) |
| A tenant cannot use another tenant's Phone Number ID / WABA ID | `whatsapp_connections.phone_number_id` unique platform-wide; WABA id cross-check in the webhook; admin-only creation | SQL, Deno, integration |
| API calls verify the logged-in user's tenant | tenant comes from `auth.uid()` in SQL (`current_tenant_id()`) and from the database in Edge Functions (never from the request) | SQL, Deno (`send`, `mark-read`) |
| Webhook routing uses trusted Meta identifiers | HMAC on the raw body with the platform app secret **before** any routing; routing by `metadata.phone_number_id` + `entry.id` | Deno (10 routing tests), integration |
| Prevent IDOR / cross-tenant leakage | other tenant's resource = "not found"; no function accepts a tenant id; DB-level composite FKs | SQL, integration |
| Never trust `tenant_id` from the frontend | `start_conversation(.., p_tenant_id)` with a forged id is rejected; there is no parameter to fill | integration |

## 2. Token and secret handling

| Property | State |
| --- | --- |
| One platform App ID/Secret and one webhook | Yes (`WA_APP_SECRET`, `WA_VERIFY_TOKEN` stay Supabase secrets) |
| Per-client access tokens in Vault, **one secret per connection**; only the reference in the connection row | Implemented, **Tested locally** (store, decrypt, rotate in place, revoke, disconnect, isolation between two connections) |
| Only trusted backend functions can retrieve a decrypted token | The three Vault functions are executable by `service_role` only; `anon`, `authenticated` **and the platform admin** are refused (tested) |
| Tokens never reach the APK, browser, staff, logs, audit log or any response | Verified: responses, audit rows, connection rows and logs searched for the token text; none contains it |
| The Vault reference column is unreadable to clients | Column-level grant; `select vault_secret_id` and `select *` on connections are refused |
| No global token for tenants | `WA_TOKEN` serves **only** the single legacy test-number connection (`credential_source = 'platform_env'`, unique) |
| Rotation, revocation, disconnection | Implemented: rotate = in-place secret update; revoke/disconnect = secret deleted; each audited |
| Token expiry monitoring | Columns and dashboard display exist (`token_expires_at`, "expiring within 7 days", per-connection "days left"); **automatic polling of Meta is not built (Phase 3)** |
| Keys in the APK / frontend / localStorage / git | None: the only bundled key is the public anon key; no signing key or Firebase file exists yet |

### What Vault does and does not give us (stated plainly)
Supabase Vault stores each token **encrypted at rest** and our functions decrypt it only inside the database function and the Edge Function for the length of a request. The workflow is supported: Edge Functions call a service-role RPC wrapper. **Limitations found while testing:**
1. The platform itself grants `service_role` direct `SELECT` on `vault.decrypted_secrets`; only `supabase_admin` (not available to migrations or to us on a hosted project) could revoke it. An attempt to revoke it from a migration silently did nothing, so the migration **does not claim** this protection. The service-role key is therefore inside the trust boundary: it exists only in Edge Functions and the platform, never in the browser or APK.
2. The `vault` schema is **not exposed through the REST API** (`[api] schemas = ["public"]`), so the key cannot be used over HTTP to list secrets; `anon` and `authenticated` have no privilege on it (tested).
3. Whether the hosted project has the Vault extension enabled is **unverified**.

## 3. Test results (local, this session)

| Suite | Result | What it proves |
| --- | --- | --- |
| `npm run test:sql`: `supabase/tests/message_delete.sql` | **25 / 25** pass | Delete-for-me still works inside tenants (per-user, soft, previews, search) |
| `supabase/tests/multi_tenant.sql` (one rolled-back transaction, 2 tenants + disabled/suspended/outsider/anonymous/admin) | **92 / 92** pass | reads, writes, IDOR on every RPC, storage, service-only functions, composite FKs, uniqueness, webhook routing, status/reaction ownership, Vault isolation, suspension, audit immutability |
| Mutation check of that suite | detects both injected faults | The tests can fail |
| `deno test` (all Edge Function tests) | **134 / 134** pass (was 90) | New: tenant checks and per-connection credentials in send/mark-read, 10 webhook routing tests, admin-staff (generated credentials, tenants, audit, no secrets in audit), admin-connections (14), push targeting (4) |
| `deno check` + `deno lint` on all functions | clean | |
| `npm run typecheck`, `npm run lint` (web) | clean | |
| `scripts/verify-multi-tenant-local.mjs` (real HTTP against the local stack; creates two clients, connections, tokens; attacks in every way; removes everything) | **100 / 100** pass | REST/RPC attacks, storage signed-URL and upload attacks, **Realtime isolation (no event, not even an empty one, reaches the other tenant)**, suspension, disabling, password reset, connection lifecycle, audit contents |
| Browser suites (Playwright, desktop + phone): see [PHASE2_IMPLEMENTATION_REPORT.md](PHASE2_IMPLEMENTATION_REPORT.md) | reported there | existing features unchanged; new branded login, forced password change, admin console, isolation seen through the UI |

Specific attacks that were executed and refused: reading another tenant's conversations/messages/connections/staff/memberships/audit/ledger by id and by tenant id; PATCH/DELETE/INSERT into another tenant's rows; `mark_conversation_read`, `delete_message_for_me`, `set_message_flags` on another tenant's message; searching for another tenant's text; calling service-only RPCs (`ingest_incoming`, `resolve_connection`, token functions); calling admin RPCs/functions as a client; signing or downloading another tenant's file; uploading into another login's folder; sending, templating or marking read in another tenant's chat; replaying another tenant's message id on a different number; a status/reaction for another connection's message; anonymous access to everything.

## 4. Realtime: one thing I got wrong and what it showed
My first Realtime tests subscribed with a user token that Realtime did not apply (the subscription ran as `anon`), producing `Error 401: Unauthorized` events and a false "failure". Inspecting `realtime.subscription` showed `claims_role = anon`. With a client that **signs in first** (what the web app does) the tenant policies work: the owner receives its own event with full data and the other tenant receives **nothing**. Lesson recorded in [AI_DEVELOPER_CONTEXT.md](AI_DEVELOPER_CONTEXT.md): Realtime clients must sign in through `supabase.auth`, not call `setAuth` by hand. The local Realtime image was used; the hosted one is **unverified**.

## 5. Threat table (changes from the single-tenant baseline)
| Threat | Before | Now |
| --- | --- | --- |
| Any staff reads every chat | by design (shared inbox) | **closed**: tenant scoped |
| Staff list shows all staff ids | any active staff | own tenant only |
| Quick replies, contacts shared across everyone | global | per tenant (same shortcut allowed in two tenants) |
| One WhatsApp number for everybody (`WA_TOKEN`) | yes | per-connection tokens in Vault (legacy number excepted) |
| Webhook trusts one phone id | env filter | trusted lookup by phone number id + WABA id; unknown/inactive recorded |
| Replay of a message id on another number | n/a | ignored; cannot overwrite |
| Admin could read everything | n/a | admin **cannot read message content** of other tenants |
| Suspension | none | tenant suspension locks all its logins out immediately (reads, sends, webhooks) |
| Audit | none | insert-only log of admin operations (even the service role cannot update/delete) |
| Disabled account | disabled flag | disabled flag + ban (cannot sign in; an existing token reads nothing and cannot send) |

## 6. Known weaknesses and open items (honest list)
1. **Vault/service-role boundary** (section 2): the service-role key can read decrypted tokens by design. Keep it out of everything but Edge Functions; rotate it if exposed.
2. **Platform admin sees counts but also staff ids, connection metadata and the audit log** of every tenant (needed to administer). It does not see message content.
3. **Realtime event metadata**: with correct authentication no event reaches the wrong tenant (tested), but this depends on the Realtime service evaluating RLS; re-test after any Supabase/Realtime upgrade.
4. **`rls_auto_enable()`** (executable by `anon`, origin unknown) from the earlier audit is **still unresolved**.
5. Hosted Auth settings (password length 6, `site_url` localhost), missing security headers on GitHub Pages, no monitoring and unverified backups (earlier audit) are **unchanged**.
6. A suspended tenant's **webhooks are acknowledged and discarded**: the customer's message is not stored while suspended (and Meta will not retry because we answer 200). Decide whether to buffer instead.
7. Token expiry is **displayed but not polled**; an expired client token will surface as failed sends (error 190) until Phase 3 adds checks.
8. `ALLOW_MANUAL_TOKEN` lets an admin store a token by hand for development. It is off by default; **do not enable it on a hosted project that serves real clients**.
9. Password policy: temporary passwords are random and the change is **enforced by the database since Phase 2.1** (`staff.must_change_password`, see section "Phase 2.1" below); the minimum for chosen passwords is 8 characters in the app and `admin-staff`; the hosted Auth minimum is still 6.
10. No automated test of the Embedded Signup flow exists (it is not implemented): **Unsupported until Phase 3 and Meta approval**.

## 7. Release-blocking checks before any real client
Rotate the admin password and the exposed Supabase token (see [SECURITY_DOCUMENTATION.md](SECURITY_DOCUMENTATION.md)); confirm Vault on the hosted project; re-run the SQL, Deno and integration suites against a **restored copy** of the hosted data; test Realtime on the hosted project with two real logins; keep both flags off until the Meta approvals in [META_TECH_PROVIDER_REQUIREMENTS.md](META_TECH_PROVIDER_REQUIREMENTS.md) are confirmed.

## 8. Vault key backup and recovery
Facts about Supabase Vault's key handling were **not** read from Supabase's documentation in this session; treat the points marked (U) as **Unverified** and confirm them in Supabase's Vault documentation before relying on them.
- **Where the key lives (U):** Vault encrypts with a key managed by the platform, not stored in your tables. A database backup therefore contains **ciphertext**.
- **Restoring into the same hosted project (U):** the key stays available, tokens decrypt. **Restoring into a different project or a self-hosted database (U):** the ciphertext will not decrypt; assume every stored token is lost.
- **Therefore never treat Vault as the only copy.** A client token is **re-obtainable**: the client re-authorises through Embedded Signup and we store a new token. For the owner's own (legacy) number keep the permanent token in a password manager; it lives in the `WA_TOKEN` Supabase secret, not in Vault.
- **Backups:** enable the project's backups/PITR (earlier audit: unverified), and **rehearse a restore into a scratch project** once. Record, outside the database, the list of connections (client, WABA id, phone number id, status). That list is not secret and is what you need to re-onboard.
- **Recovery runbook:** (1) restore the database; (2) for each connection run `get_connection_token` through an Edge Function health check (Phase 3) or watch for status `error`; (3) for any connection that no longer decrypts, set it to disconnected in the console and ask the client to reconnect; (4) rotate `WA_APP_SECRET`/tokens only if exposure is suspected.
- **Rotating a token** replaces the Vault secret in place, so an old token stops working at once on our side; revoke it in Meta as well when a leak is suspected.
- **Key rotation of Vault itself (U):** not tested; a platform-level operation.

## Phase 2.1 additions (2026-11-18; local only, not deployed)

* **Mandatory password change is server-side (F1).** `staff.must_change_password` cannot be written by any browser login (no grant; PATCH, RPC and `user_metadata` writes all fail). While true, `current_tenant_ids()` is empty and `is_admin()`/`is_active_staff()` are false, so every policy, RPC, storage rule and Realtime event is closed, even for sessions that already exist. The only exit is `complete-password-change`: valid JWT, session issued in the last 30 minutes, flagged and not disabled, 8-72 characters, not equal to the temporary password (checked by a sign-in probe), 10 attempts per 15 minutes per login; it sets the password, clears the flag, signs out the other sessions and audits without the password. Admin functions, send and mark-read refuse flagged logins.
* **No silent webhook loss (F8).** See `WEBHOOK_DOCUMENTATION.md` section 7. The quarantine holds customer data, so it is service-role only with a 7-day expiry.
* **New attack surface:** two Edge Functions (`complete-password-change`, `webhook-replay`; both `verify_jwt = true`) and one admin RPC (`admin_routing_diagnostics`). Each is covered by tests.
* **Residual risks:** the unlock function's rate limit is per function instance (Auth rate-limits sign-ins as well); a stolen temporary password inside its 30-minute window can still be used to choose a new password (the admin should reset after any suspicion); rolling back Phase 2.1 would unlock temporary-password logins (the rollback script refuses unless told otherwise).

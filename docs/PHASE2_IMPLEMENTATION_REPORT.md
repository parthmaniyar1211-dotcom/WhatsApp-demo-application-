# Phase 2 implementation report: multi-tenant foundation

> Date: 2026-11-16. **Everything was built and tested on a LOCAL stack. Nothing was committed, pushed, deployed or applied to hosted Supabase; no Meta setting, WhatsApp token or Supabase secret was changed; no APK was built or published.**
> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). Detail: [MULTI_TENANT_ARCHITECTURE.md](MULTI_TENANT_ARCHITECTURE.md) · [MULTI_TENANT_MIGRATIONS.md](MULTI_TENANT_MIGRATIONS.md) · [MULTI_TENANT_SECURITY.md](MULTI_TENANT_SECURITY.md)

## 1. Your decisions and what was done

| Decision | Done |
| --- | --- |
| 1. Tech Provider status NOT VERIFIED; check Meta's requirements; flag Embedded Signup; no real onboarding | Requirements **read from Meta's own pages** (see [META_TECH_PROVIDER_REQUIREMENTS.md](META_TECH_PROVIDER_REQUIREMENTS.md)); `start_onboarding` is refused by `FEATURE_EMBEDDED_SIGNUP` (off, tested) and the console button is disabled; no client onboarded |
| 2. Branding CosmiConnect / CosmiChameleon / charcoal + green / `io.cosmichameleon.cosmiconnect`, configurable, no final Firebase app or signed APK | `web/src/brand.ts` + `VITE_BRAND_*`; default dark theme moved to charcoal; no WhatsApp branding (two wording claims removed); no Firebase app registered, no APK built |
| 3. Firebase: architecture only, abstraction, no fake credentials, document what you need | `_shared/push.ts`, `web/src/native/pushService.ts`, `push_devices` + RPCs, [FIREBASE_AND_NOTIFICATIONS.md](FIREBASE_AND_NOTIFICATIONS.md) |
| 4. Vault, one secret per connection, reference only, backend-only decrypt, rotation/disconnect/revoke, isolation tests, key backup notes; stop if Vault cannot work | Vault **works** with the Edge Function workflow via service-role wrapper functions, so no custom encryption was written. **One limit reported**: the platform lets `service_role` read Vault tables directly and a migration cannot revoke that (details in the security doc) |
| 5. "Owner (test)" tenant; preserve ids, statuses, media; keep the test connection working | Done and proven (section 4) |
| 6. Local development; Meta docs and Postman | Local Docker/Supabase/Deno here. Meta pages read via shell; the Postman collection is not readable without a Postman key (stated) |
| 7. Real-device checklist | [ANDROID_DEVICE_TEST_CHECKLIST.md](ANDROID_DEVICE_TEST_CHECKLIST.md) (not run: no device here) |

## 2. The ten Phase 2 items

| # | Item | State |
| --- | --- | --- |
| 1 | Tenant database architecture | Implemented, Tested locally (4 migrations) |
| 2 | Admin and Staff role architecture | Implemented (platform admin vs client logins; owner/agent memberships) |
| 3 | Staff account creation and authentication | Implemented: Staff ID + password login; generated Staff ID; one-time temporary password; forced change at first login; disable/enable; reset |
| 4 | Tenant-level data isolation | Implemented, Tested locally (SQL, Deno, real HTTP, Realtime, storage, browser) |
| 5 | Per-client WhatsApp connection model | Implemented (`whatsapp_connections`, lifecycle, admin function and screens) |
| 6 | Secure token storage architecture | Implemented (Vault), Tested locally |
| 7 | Webhook routing by Phone Number ID | Implemented, Tested locally (WABA cross-check, ledger, inactive/suspended handling, ownership of statuses) |
| 8 | Owner (test) tenant migration | Implemented, data preserved (proof below) |
| 9 | Admin dashboard foundation | Implemented: Overview, Clients, WhatsApp numbers, Audit log |
| 10 | Staff dashboard foundation | Implemented: existing app scoped to the tenant, connection banner, forced password change |

## 3. Files (all uncommitted)
- **Migrations (new):** `supabase/migrations/20261118000000_tenants_core.sql`, `...000100_vault_tokens.sql`, `...000200_tenant_isolation.sql`, `...000300_routing_admin.sql`; `whatsapp_setup.sql` regenerated.
- **Edge Functions:** changed `whatsapp-webhook`, `send-whatsapp`, `mark-read`, `admin-staff`, `_shared/supabase_store.ts`; new `admin-connections`, `_shared/connections.ts`, `_shared/push.ts`; `supabase/config.toml`; `index.ts` of the four.
- **Web:** `brand.ts`, `LoginPage`, `ForcePasswordChange`, `ConnectionBanner`, `App.tsx`, `Workspace.tsx`, `hooks/useTenantContext.ts`, `lib/adminApi.ts`, `lib/api.ts`, `lib/types.ts`, `native/pushService.ts`, `admin/*` (7 files), styles, `.env.example`.
- **Tests:** `supabase/tests/multi_tenant.sql`, `tenant_migration_fingerprint.sql`, updated `message_delete.sql`; Deno tests (send, mark-read, webhook, admin-staff rewritten; new `admin_connections_test.ts`, `push_test.ts`); `scripts/verify-multi-tenant-local.mjs`; `web/e2e/tenancy.spec.ts` and login helper updates.
- **Docs:** this report and eleven others under `docs/`.

## 4. Data preservation (local, measured)
Immediately after applying the migrations the fingerprint of every pre-existing table and file was **byte-identical** to the one taken before: 5,394 messages, 634 conversations, 585 read markers, 96 flags, 6 quick replies, 21 logins, 452 storage objects, and all 452 media paths still pointing at existing files. A second run changed nothing. (Later test runs add rows, so the fingerprint naturally changes again afterwards.)

## 5. Test results (final run, local)

| Layer | Result |
| --- | --- |
| SQL: delete-for-me suite | 25 / 25 |
| SQL: multi-tenant suite | 92 / 92; detects two injected faults |
| Deno unit tests | 134 / 134 (was 90); `deno check` and `deno lint` clean |
| Real-HTTP integration script | 100 / 100 (REST/RPC attacks, storage, Realtime, lifecycle, audit) |
| Web `tsc` and `eslint` | clean |
| Playwright full suite, desktop + phone | 86 tests: first run **85 passed, 1 failed** (a transient "name resolution failed" from the local Edge runtime during one video send); that test then passed 3 of 3 reruns; after the last edits the tenancy and inbox specs passed 16 / 16 |
| `check:sql` | `whatsapp_setup.sql` matches the 8 migrations |

**Failures found and fixed on the way:** a re-applied migration re-granted UPDATE/DELETE on the audit log; a test-ordering mistake in my SQL; my own Realtime clients subscribing as `anon`; the empty-state text claiming an "official WhatsApp Business API"; a status-before-state ordering slip in `admin-connections` (code fixed).

## 6. Screenshots
Fourteen local captures (login, admin console tabs, one-time password dialog, client first login, client inbox, routed message, phone-size views) were produced from a local demo and sent in the chat; the demo clients were removed afterwards.

## 7. Limits and things not verified
1. **Not tested on hosted Supabase, real Meta, real Firebase or a real phone.** Hosted Vault availability and Realtime behaviour are unverified.
2. **Tech Provider, Business Verification, App Review and Access Verification: not verified**; Embedded Signup and Coexistence handlers are **not built** (Phase 3). The test number can never be onboarded through Embedded Signup (Meta: developer-app accounts cannot).
3. **Edit/revoke:** customer edits and revokes arrive as webhooks (Meta, Nov 2026) and the webhook currently stores them as an "unsupported" note; a proper sync is Phase 4. No business-side edit/delete operation exists on the pages read.
4. Graph API version: Meta's examples now use v27.0; we default to v26.0 (unchanged).
5. Vault: `service_role` can read decrypted tokens directly (platform grant); keep that key inside Edge Functions.
6. Token expiry is shown, not polled; suspended tenants' webhooks are acknowledged and discarded (no buffering).
7. No down-migration was written; the tested rollback is restoring a backup.
8. Unchanged from the earlier audit: hosted Auth password length 6 and localhost `site_url`, `rls_auto_enable()`, no security headers on GitHub Pages, no monitoring, unverified backups.

## 8. What needs your decision or approval before Phase 3
- Confirm the **branding** (name, package id, colours) before any Firebase app or signed APK.
- Confirm in Meta's dashboards whether WT is a **Tech Provider** and the state of Business Verification, App Review and Access Verification.
- Approve (or not) **applying the migrations and deploying the functions and web app to hosted Supabase**, following the order in [MULTI_TENANT_MIGRATIONS.md](MULTI_TENANT_MIGRATIONS.md) section 6. Until then the live site keeps the old single-login behaviour.
- Approve **committing** the work; nothing is committed, so the repository's stop-hook reminders about untracked files are expected.
- Phase 3 starts only after your separate approval.

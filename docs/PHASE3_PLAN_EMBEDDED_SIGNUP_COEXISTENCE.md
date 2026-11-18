# Phase 3 implementation plan: Meta Embedded Signup v5 and Coexistence

> **PLAN ONLY. Phase 3 has not been started.** It needs your separate approval, and it can only be *run for real* after Meta confirms Tech Provider status ([REAL_CLIENT_ONBOARDING_READINESS.md](REAL_CLIENT_ONBOARDING_READINESS.md)).
> Every Meta endpoint and payload below comes from Meta's own pages read on 2026-11-16 ([META_TECH_PROVIDER_REQUIREMENTS.md](META_TECH_PROVIDER_REQUIREMENTS.md)); anything not read is marked **Unverified** and must be re-read before it is coded. No endpoint is invented.
> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). Related: [MULTI_TENANT_ARCHITECTURE.md](MULTI_TENANT_ARCHITECTURE.md) · [MIGRATION_AND_POLICY_REVIEW.md](MIGRATION_AND_POLICY_REVIEW.md) · [VAULT_BOUNDARY_AND_RECOVERY.md](VAULT_BOUNDARY_AND_RECOVERY.md)

## 1. Goal and non-goals
**Goal:** an admin creates a client and sends a link; the client authorises their own WhatsApp Business account in Meta's Embedded Signup **v5**; if the number is on the WhatsApp Business app, **Coexistence** is offered automatically; our server obtains the client's **business token**, stores it in Vault, subscribes the client's Messaging account, synchronises contacts and history, and mirrors messages sent from the Business app, all under that client's tenant only.
**Non-goals:** groups, calls, broadcast lists, status, channels, catalog/orders, templates management UI, business-side edit/delete for everyone (not available), location sharing (excluded by you), the Android shell (Phases 4-7).

## 2. The key design choice to settle first: how the client launches Embedded Signup

| | **A. Our HTTPS onboarding page (Facebook JS SDK)** | **B. Hosted Embedded Signup (Meta-hosted link)** |
| --- | --- | --- |
| How | A page we host loads `connect.facebook.net/en_US/sdk.js`, calls `FB.login` with our `config_id`, listens for the `WA_EMBEDDED_SIGNUP` message event and the response `code` | A link from the App Dashboard (WhatsApp > Quickstart > "Zero integration onboarding"); Meta shows the steps and a button |
| Our code | A page + `onboarding-complete` function; code exchange `GET /oauth/access_token` | Detect completion by the `account_update` webhook with `event = PARTNER_ADDED` (gives `waba_id`, `owner_business_id`); fetch the business token with the **System User Access Tokens API** using **our** system token and `appsecret_proof`; list numbers with `GET /<WABA>/phone_numbers` |
| Customisation | Full (copy, branding, consent text, session logging) | "The flow cannot be customized"; only for onboarding to Cloud API |
| Needs | Domain on **Allowed domains and Valid OAuth redirect URIs**, HTTPS, client OAuth toggles on (Embedded Browser OAuth Login, Web OAuth login, JS SDK login, strict redirect URIs) | A system user token of ours and our app secret |
| Coexistence | Documented (`featureType` on v4; **on by default on v5**) | **Unverified**: the Hosted ES page read does not mention Coexistence |
| Android | Must run in a normal HTTPS browser tab, **not** inside the APK's WebView (the allowed-domain rule and popup flow do not suit `capacitor://` origins) | Link opens in the system browser: simple |
**Recommendation:** build **A** (it is the documented path for Coexistence and lets us show consent and instructions), served from an HTTPS domain you control; keep B as a fallback if A proves hard. Decide after reading Meta's current Hosted ES Coexistence statement.

## 3. The onboarding sequence we will implement (Option A, v5)

```mermaid
sequenceDiagram
  autonumber
  participant Ad as Admin console
  participant OS as onboarding-start (Edge)
  participant P as Onboarding page (HTTPS)
  participant C as Client
  participant FB as Meta Embedded Signup
  participant OC as onboarding-complete (Edge)
  participant G as Graph API
  participant DB as Postgres + Vault
  Ad->>OS: start for tenant (admin only, flag on)
  OS->>DB: onboarding_session (state nonce hash, expires, tenant, connection)
  OS-->>Ad: one-time link
  Ad-->>C: link (private channel)
  C->>P: open link (state in URL)
  P->>FB: FB.login(config_id, response_type=code, extras{version:"v5"})
  C->>FB: sign in, choose/verify number; Business-app number -> coexistence steps
  FB-->>P: message event WA_EMBEDDED_SIGNUP (phone_number_id, is_on_biz_app, messaging_account_ids, business_id) + code
  P->>OC: code + session info + state
  OC->>DB: validate state (single use, tenant, not expired)
  OC->>G: GET /oauth/access_token (app id, app secret, code) -> business token
  OC->>G: GET /<phone_number_id>?fields=is_on_biz_app,platform_type,display_phone_number,verified_name
  OC->>G: GET /debug_token (expiry, scopes)
  OC->>DB: store token in Vault; ids, coexistence flag, expiry on the connection
  OC->>G: POST /<WABA_ID>/subscribed_apps (business token)
  alt not coexistence
    OC->>G: POST /<phone_number_id>/register (6-digit PIN)
  else coexistence
    Note over OC,G: skip registration: the number is already registered
    OC->>G: POST /<phone_number_id>/smb_app_data {sync_type: smb_app_state_sync}
    OC->>G: POST /<phone_number_id>/smb_app_data {sync_type: history}
  end
  G-->>OC: webhooks arrive at whatsapp-webhook (routed by phone_number_id)
  OC->>DB: connection "connected", sync state "in progress"
```
Exact calls (all from Meta's pages): `GET /oauth/access_token?client_id&client_secret&code` (server side only); `POST /<WABA_ID>/subscribed_apps`; `POST /<PHONE_NUMBER_ID>/register {messaging_product, pin}` (only for non-coexistence); `POST /<PHONE_NUMBER_ID>/smb_app_data` with `sync_type` `smb_app_state_sync` then `history` (**each once; repeating needs offboarding**); `GET /<PHONE_NUMBER_ID>?fields=is_on_biz_app,platform_type` (expect `true` / `CLOUD_API`). The two sync calls must happen **within 24 hours** of onboarding or the client must offboard and redo the flow.

## 4. Data model additions (new migrations, each with a tested down script)

| Object | Purpose |
| --- | --- |
| `onboarding_sessions(id, tenant_id, connection_id, state_hash, status, expires_at, created_by, completed_at, error)` | Single-use, expiring link state; RLS: admin only |
| `connection_sync_state(connection_id, contacts_status, history_status, phase, progress, contacts_requested_at, history_requested_at, deadline_at, request_ids jsonb)` | Tracks the 24-hour window and history progress |
| `wa_messages.source` (`cloud_api` / `business_app_echo` / `history`), `edited_at`, `original_body`, `revoked_at` | Mirroring, edits and revocations; "Delete for me" stays untouched |
| `webhook_payloads` (private, short retention) | Raw `history` chunks stored first and processed asynchronously ("a single webhook could describe thousands of messages") |
| `whatsapp_connections`: PIN secret reference (second Vault secret) if registration is used, `onboarded_at`, `last_health_check_at`, `health` | Token and number health |
All new tables get tenant isolation tests like Phase 2; history rows go through the same `tenant_id`/`connection_id` constraints.

## 5. Webhook work (`whatsapp-webhook`), routed by phone number id as today

| Field / type | Behaviour |
| --- | --- |
| `account_update` | `PARTNER_ADDED` (Hosted ES completion), `PARTNER_REMOVED` (+ `disconnection_info.reason`: for example `PRIMARY_INACTIVITY` after about 14 days of an inactive primary device), `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`: update connection status, notify the admin and client |
| `smb_message_echoes` | A message the client sent from the WhatsApp Business app or a supported companion: stored as `out`, `source = business_app_echo`, idempotent by wamid, preview and unread logic unchanged |
| `smb_app_state_sync` | Contact add, edit, remove: map to `conversations.contact_name` for that connection only |
| `history` | Store the chunk, return 200 immediately, process asynchronously; order by `chunk_order`; track `phase` (0: day 0-1, 1: day 1-90, 2: day 90-180) and `progress` (100 = done); **no media ids except for the last 14 days**; groups are excluded by Meta; error **2593109** = client declined history; dedupe by wamid |
| `messages` with `type: "edit"` | Update the original message (text or media caption) and record `edited_at`/original; edits arrive for 15 minutes after sending |
| `messages` with `type: "revoke"` | Mark the original message revoked (`original_message_id`); revokes arrive for two days; the app shows "This message was deleted" without erasing our stored row (policy decision) |
| Unsupported-message errors **131060** | Expected right after onboarding or for unsupported companions; surface as an info note, not an error |
All of these identify users by business-scoped user id and may omit the phone number: the existing `wa_user_id` handling is reused and tested with Meta-shaped fixtures.

## 6. Edge Functions and screens

| Item | Notes |
| --- | --- |
| `onboarding-start` (admin) | Creates the session and link; refuses unless `FEATURE_EMBEDDED_SIGNUP` is on |
| Onboarding page | A small HTTPS page (our web app route or separate): consent and instructions (Business app 2.24.17+, keep the app open, what is shared), `FB.login`, message listener with origin check `endsWith('facebook.com')`, posts to `onboarding-complete` |
| `onboarding-complete` | The server steps in section 3; every Meta call server-to-server; token only in Vault; idempotent; errors mapped to clear admin messages |
| `connection-sync` (scheduled/triggered) | Issues the two `smb_app_data` calls once each, tracks the deadline, alerts before the 24 hours expire |
| `connection-health` (scheduled) | `debug_token` expiry/scopes, `is_on_biz_app`/`platform_type`, stale `last_webhook_at`; updates the connection, raises admin and push alerts |
| Admin console | "Connect with Meta" becomes live behind the flag; onboarding timeline per client; coexistence badge and sync progress; reconnect and offboard actions; health indicators |
| Client view | "Connecting your WhatsApp" progress; banner while syncing; clear disconnected state |

## 7. Tests (before anything touches real Meta)
1. **Fake Meta server** (Deno) for `oauth/access_token`, `debug_token`, `subscribed_apps`, `register`, `smb_app_data`, phone-number fields, with success, error, timeout and retry cases.
2. **Webhook fixtures shaped exactly like Meta's examples** for each field above; ordering and duplicate delivery of `history` chunks; very large chunks; users without phone numbers.
3. **Isolation tests** for every new table and function (two tenants, attacks, Realtime), added to the existing SQL, Deno and real-HTTP suites.
4. **Security tests**: onboarding state is single-use, expiring and tenant-bound; the code exchange never logs or returns the token; forged `WA_EMBEDDED_SIGNUP` events from another origin are ignored; replay of a completed session is refused.
5. **Browser tests** with a mocked FB SDK for the page and the admin screens.
6. **Real tests** (only after approval): a Meta test business and a consenting test client with a WhatsApp Business app on a physical phone.
Down-scripts and a hosted rehearsal for every migration, as in [BACKUP_AND_ROLLBACK_PLAN.md](BACKUP_AND_ROLLBACK_PLAN.md).

## 8. Sub-phases, size and dependencies

| Step | Content | Size | Depends on |
| --- | --- | --- | --- |
| 3.0 | **Phase 2.1 hardening** (review findings F1, F2, F3, F8) | S | your approval |
| 3.1 | Read the remaining Meta pages (Hosted ES + Coexistence, `webhooks/override`, `account_update`, `debug_token`); settle option A vs B; write the final interface spec | S | you |
| 3.2 | Migrations + down scripts for the new tables; isolation tests | M | 3.0 |
| 3.3 | Webhook handlers (`account_update`, echoes, `smb_app_state_sync`, `edit`, `revoke`) with fixtures | M | 3.2 |
| 3.4 | `history` ingestion: store-then-process, ordering, idempotency, progress | L | 3.3 |
| 3.5 | Fake Meta + `onboarding-start` / page / `onboarding-complete` (flag off) | L | 3.2 |
| 3.6 | `connection-sync` and `connection-health`, alerts | M | 3.5 |
| 3.7 | Admin and client screens | M | 3.5 |
| 3.8 | Full test run, security review, documentation, rollback rehearsal | M | all |
| 3.9 | **Real onboarding tests** with a consenting test client | S effort, long lead | Meta approval (A1-A4) |
Sizes are rough author estimates (S under 1 day, M 1-3 days, L 3-5 days of focused work); the real calendar is dominated by Meta approval, not code.

## 9. Risks
1. **The 24-hour sync window**: if it is missed the client must redo the flow; mitigations: start sync immediately, alert at 12 and 20 hours, clear client messaging.
2. **Volume and privacy** of imported history (up to 180 days of a client's chats): retention, consent, deletion on offboarding, and encryption expectations must be decided before enabling it (D2 in the readiness document).
3. **Token lifetime is not confirmed**: Meta's configuration template is named "...60 Expiration Token"; read the real lifetime from `debug_token` and build refresh/re-onboard around it.
4. **Unsupported companion devices** do not trigger webhooks: some client messages will never reach us (documented by Meta); the client must be told.
5. **Throughput cap** of 20 messages per second per Coexistence number; add the per-connection guard.
6. **Graph version** v27.0 vs our v26.0: upgrade deliberately, with tests.
7. **WhatsApp Business app version** 2.24.17+ and client behaviour (inactivity disconnects after about 14 days of an inactive primary device) will cause support load.
8. **Hosted ES and Coexistence compatibility** is unverified (Option B).

## 9b. Decisions recorded on 2026-11-18 (Phase 2.1)

* Onboarding uses **our own branded HTTPS page launching Meta's official Embedded Signup** (option A): [ONBOARDING_PAGE_DESIGN.md](ONBOARDING_PAGE_DESIGN.md).
* **Explicit client consent** is required before chat-history synchronization; default off, enforced in the webhook: [PRIVACY_RETENTION_AND_CONSENT_POLICY.md](PRIVACY_RETENTION_AND_CONSENT_POLICY.md).
* **Billing stays manual**; the data model leaves room for per-client or per-number billing: [BILLING_ARCHITECTURE.md](BILLING_ARCHITECTURE.md).
* Meta verification preparation (nothing submitted): [META_VERIFICATION_PREPARATION.md](META_VERIFICATION_PREPARATION.md).
* Phase 2.1 (F1, F8) is done locally and awaiting your approval; it is a prerequisite for any real client.
* The Owner (test) tenant and the legacy test connection are preserved (data fingerprint identical before and after Phase 2.1).

## 10. What I need from you to start Phase 3
1. Your approval to start, and whether to do **Phase 2.1** first (recommended).
2. The state of Tech Provider / App Review (so I know whether a real test is possible soon).
3. The **HTTPS domain** for the onboarding page and whether Option A is acceptable.
4. Your decisions on **history retention and consent** and on the **billing model**.
5. Permission to read further Meta pages and, later, to run the real tests with a consenting test client.

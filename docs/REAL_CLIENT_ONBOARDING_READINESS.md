# Readiness for real client onboarding: blockers and Meta approvals

> **Verdict today: not ready.** The multi-tenant foundation exists and is tested locally, but real clients cannot be onboarded until the **hard blockers** below are cleared. This document lists all of them, who owns each, and which features depend on which Meta approval.
> Meta facts were read from Meta's pages on 2026-11-16 (see [META_TECH_PROVIDER_REQUIREMENTS.md](META_TECH_PROVIDER_REQUIREMENTS.md)); anything not read is marked **Unverified**.
> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). Related: [PHASE3_PLAN_EMBEDDED_SIGNUP_COEXISTENCE.md](PHASE3_PLAN_EMBEDDED_SIGNUP_COEXISTENCE.md) · [MIGRATION_AND_POLICY_REVIEW.md](MIGRATION_AND_POLICY_REVIEW.md) · [BACKUP_AND_ROLLBACK_PLAN.md](BACKUP_AND_ROLLBACK_PLAN.md)

Legend: **HARD** = no real client until done · **SOFT** = should be done, can follow the pilot · Owner: **You** (dashboards, accounts, legal), **Me** (code, tests, docs), **Both**.

## 1. Blockers

### A. Meta and business (all outside the code)
| # | Blocker | Type | Owner | Status |
| --- | --- | --- | --- | --- |
| A1 | The Meta app "WT" must be a **Tech Provider**: business verified, app settings complete (icon, **privacy policy URL**, category), **App Review** passed with **Advanced access** to `whatsapp_business_messaging` and `whatsapp_business_management` (two videos: send a message, create a template) | HARD | You | **Not verified** |
| A2 | App in **live mode** (in development mode only users with a role on the app see the flow; after going live only Advanced-access permissions appear) | HARD | You | Not verified |
| A3 | **Embedded Signup configuration**: Facebook Login for Business configuration (WhatsApp Embedded Signup variation), allowed domains and OAuth redirect URIs on **HTTPS**, Embedded Signup version **v5** (or v4) | HARD | You (settings) + Me (code) | Not done |
| A4 | **Webhook fields** subscribed on the app: `messages` (exists) plus `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes` | HARD for Coexistence | You | Only `messages` is confirmed |
| A5 | **Production webhook endpoint** reachable and verified for the production app (the current callback is the hosted Supabase function) | HARD | You | Configured for the test number |
| A6 | **Clients' payment method**: Tech Providers have no credit line; each client must add a card to their Messaging account before messaging | HARD (per client) | Client | Process to document |
| A7 | **Onboarding limit**: default **10 new clients per rolling 7 days** until Business Verification, App Review and Access Verification are done (then 200). *Access Verification is not defined on the pages read.* | SOFT | You | Not verified |
| A8 | Message **templates** for clients (only `hello_world` exists in the app). Templates are approved per account by Meta | SOFT for a pilot | Both | Pending |
| A9 | Graph API version: Meta's examples use v27.0, the code defaults to v26.0 | SOFT | Me | Works; upgrade after tests |

### B. Platform engineering (my side)
| # | Blocker | Type | Owner | Status |
| --- | --- | --- | --- | --- |
| B1 | **Phase 2.1 hardening**: F1 (forced password change enforced server-side), F2 (require WABA id), F3 (ledger purge), F8 (legacy binding must never silently drop events) | HARD (F1, F8), SOFT (F2, F3) | Me, after your approval | **F1, F3, F8 done locally (Phase 2.1, not deployed, awaiting your approval)**; F2 open |
| B2 | **Embedded Signup flow** (onboarding link/page, code exchange, token to Vault, subscribe the client's Messaging account) | HARD | Me, Phase 3 | Not built; flag off |
| B3 | **Coexistence**: `smb_app_data` syncs inside the 24-hour window, handlers for `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes`, and customer `edit` / `revoke` | HARD for coexistence clients | Me, Phase 3 | Not built |
| B4 | **Token health and expiry** (poll `debug_token`, alerts, reconnect flow) | HARD | Me, Phase 3 | Columns and display only |
| B5 | **Per-connection send guard** (Coexistence numbers are capped at 20 messages per second; per-login limit only today) | SOFT | Me | Not built |
| B6 | **Android app** (Capacitor shell, camera, microphone, push, deep links, signed release APK) and your real-device tests | HARD for the APK promise | Me + You | Phases 4-7 |
| B7 | **Firebase project** and `google-services.json`; FCM service-account secret | HARD for push | You | Deferred by you |
| B8 | Automated tests for everything new, against a **fake Meta**; then a real test with a consenting test client | HARD | Me | Not started |

### C. Security and operations
| # | Blocker | Type | Owner | Status |
| --- | --- | --- | --- | --- |
| C1 | **Hosted rehearsal and migration** following the backup plan; verify Vault and Realtime on hosted; resolve `rls_auto_enable()` | HARD | Both | Not done |
| C2 | **Backups**: know the plan, enable daily backups or PITR, back up Storage objects separately, drill a restore, back up the Vault root key once the first client token exists | HARD | You | Plan unknown |
| C3 | Rotate the admin password and the Supabase access token that were shared in chat; raise hosted Auth minimum password length (6) and fix `site_url`; security headers (GitHub Pages ignores `_headers`) | HARD | You (settings) + Me | Open since the first audit |
| C4 | **Monitoring and alerts**: webhook 401/5xx, `unrouted` events, failed sends, token expiry, stale `last_webhook_at` | HARD | Both | None |
| C5 | Service-role key hygiene (it can read decrypted tokens) and a rotation runbook | HARD | You | Documented |
| C6 | Staging environment separate from production (second Supabase project) | SOFT, recommended | You | None |
| C7 | Rate limits and abuse controls on the admin functions; Auth rate limits confirmed | SOFT | Both | Unverified |

### D. Legal, commercial and support
| # | Blocker | Type | Owner | Status |
| --- | --- | --- | --- | --- |
| D1 | **Privacy policy and terms** (also required for App Review); data-processing terms with clients; who is controller and processor of their customers' messages | HARD | You | Not written |
| D2 | **Consent and retention** for imported chat history and contacts (Coexistence copies up to 180 days of a client's messages); retention and deletion on offboarding; export on request | HARD for coexistence | You + Me | Not designed |
| D3 | Client-facing **onboarding guide** (WhatsApp Business app 2.24.17+, keep the app open while syncing, what is shared, how to disconnect) and admin guide | HARD | Me (drafts) + You | Drafts in Phase 8 |
| D4 | Pricing and billing between you and clients (Meta bills clients for API usage; you bill for your service) | HARD | You | Not decided |
| D5 | Support process and incident contacts | SOFT | You | None |

## 2. Critical path
`A1 (Tech Provider)` -> `A2/A3/A4 (live mode, Embedded Signup configuration, webhook fields)` -> `B1 (Phase 2.1)` -> `B2-B4 (Phase 3)` -> `C1-C4 (hosted rehearsal, backups, monitoring)` -> **pilot with the owner's own second number** -> **one friendly client** -> general onboarding. App Review is stated to take about 24 hours on average, but business verification and the legal items usually dominate: start them now, in parallel with engineering.

## 3. Which features require Meta approval

| Capability | What Meta requires (from the pages read) | Needs App Review / Advanced access? |
| --- | --- | --- |
| Sending and receiving with **your own test number** to allow-listed recipients (today) | A Meta app with the WhatsApp use case; a user with a role on the app | **No** ("Business apps are automatically approved for Standard Access... if you are using the API for yourself as a Direct Developer you do not need Advanced access or app review") |
| Messaging **other businesses' numbers** through your platform | **Tech Provider** (business verification + App Review); business tokens from Embedded Signup | **Yes**: Advanced access to `whatsapp_business_messaging` and `whatsapp_business_management` |
| **Embedded Signup** for clients | Tech Provider or Solution Partner; Facebook Login for Business configuration; HTTPS allowed domains; live mode | Yes (the two permissions) |
| **Coexistence** (client keeps the WhatsApp Business app) | Tech Provider/Solution Partner; client app 2.24.17+; Embedded Signup with session logging; the four extra webhook fields | Yes (same) |
| **Contacts and chat-history sync** | Coexistence; client agrees to share history; `smb_app_data` calls within 24 hours of onboarding; up to 180 days of messages, media ids only for the last 14 days | Same as Coexistence |
| Mirroring messages sent from the Business app (`smb_message_echoes`) | Coexistence | Same |
| Customer **edit** (within 15 minutes) / **revoke** (within 2 days) events | Coexistence (delivered as `messages` webhooks) | Same |
| **Templates** (marketing/utility/authentication) | Each template is reviewed by Meta per account; managing client templates by API needs `whatsapp_business_management` Advanced access | Yes for client accounts |
| Media, voice notes, reactions, replies, read receipts, typing indicator | Part of `whatsapp_business_messaging` | Yes for client accounts (covered by the permission) |
| Onboarding more than **10 clients per rolling 7 days** | Business Verification + App Review + Access Verification (raises to 200); beyond that apply to be a Meta Business Partner | Yes |
| **Groups** | Per your brief the Groups API needs Official Business Account eligibility and is not available to Coexistence numbers; Meta's Coexistence table also lists group chats as not supported. The Groups API page itself was **not read** | **Unverified** |
| Calls, broadcast lists, disappearing and view-once messages, status, channels, live location, business profile/catalog tools | **Not supported** for a Business-app number on Cloud API (Meta's feature table) | n/a |
| Business-side **edit / delete for everyone** | No operation exists on the pages read | n/a (Unsupported by API) |
| Higher **client messaging limits** | "Start with messaging limits, which can be increased through API usage" (read); whether business verification of the client is also required: **Unverified** | n/a |
| Push notifications (FCM) | Not a Meta feature; needs your Firebase project | No |

## 4. Decisions only you can take
1. Start (or confirm the state of) **business verification and App Review** now: it is on the critical path and independent of the code.
2. Choose the **public HTTPS domain** for the onboarding page (a custom domain is advisable; the Embedded Signup domain must be allow-listed).
3. Approve **Phase 2.1 hardening** (B1) and the **hosted rehearsal** (C1).
4. Decide the **history retention and consent** policy (D2) and the **billing model** (D4).
5. Confirm the **Supabase plan** and backups (C2).

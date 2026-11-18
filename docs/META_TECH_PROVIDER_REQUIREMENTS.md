# Meta requirements: Tech Provider, Embedded Signup and Coexistence

> **Status of the Meta app "WT": Tech Provider approval, App Review and Access Verification are NOT VERIFIED.**
> Nothing in this repository or in the live system proves them. Only the owner can see them in Meta's dashboards.
> Embedded Signup therefore stays **behind a feature flag** (`FEATURE_EMBEDDED_SIGNUP`, off) and no real client is onboarded.
>
> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). Related: [WHATSAPP_API_INTEGRATION.md](WHATSAPP_API_INTEGRATION.md) ·
> [MULTI_TENANT_ARCHITECTURE.md](MULTI_TENANT_ARCHITECTURE.md) · [KNOWN_ISSUES_AND_ROADMAP.md](KNOWN_ISSUES_AND_ROADMAP.md)

## 1. Where this comes from

These pages were fetched and read **directly from Meta's developer site** on 2026-11-16 (page text extracted from the HTML; the "Updated" date is the one Meta prints):

| Page (developers.facebook.com/documentation/business-messaging/whatsapp/...) | Meta's "Updated" |
| --- | --- |
| `embedded-signup/onboarding-business-app-users` (Coexistence) | Nov 14, 2026 |
| `embedded-signup/overview` | Oct 29, 2026 |
| `embedded-signup/versions` | Oct 29, 2026 |
| `embedded-signup/version-5` | Oct 27, 2026 |
| `solution-providers/overview` | not shown on the page |
| `reference/whatsapp-business-phone-number/message-api` (sidebar and text only) | not shown |

**Meta's official Postman collection could not be used**: the Postman workspace page is a JavaScript application and its collection cannot be read without a Postman API key. The
developer documentation above was used instead. Where a statement below is not on those pages it is marked **Unverified**. Search-engine snippets and third-party mirrors were *not* relied on.

## 2. Embedded Signup version: use v5 (or v4), never v2/v3

| Fact (from Meta's versions page) | Consequence for us |
| --- | --- |
| Latest version is **v5** (introduced Oct 20, 2026). **v4** (Oct 8, 2025) is still available. | Build for **v5**; v4 is an acceptable fallback. |
| **v2 and v3 were deprecated on Oct 15, 2026**; requests for them, or with no/invalid version, are served as v4. | Never configure v2/v3. Always send `version` explicitly. |
| v5: WhatsApp Business app onboarding (Coexistence) is **on by default**; opt out with `features: [{ name: "whatsapp_business_app_onboarding", enabled: false }]`. `sessionInfoVersion` is ignored. | No `featureType` needed on v5. On v4 it is `featureType: "whatsapp_business_app_onboarding"`. |
| v5 session info returns `phone_number_id`, `is_on_biz_app`, `messaging_account_ids` (replaces `waba_id`), `primary_waac_ids`, `business_id`. Event is `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` when `is_on_biz_app` is true, else `FINISH`. | The onboarding function must read these fields (and, on v4, `waba_id`). |
| "Messaging account" holds templates, billing and webhook subscriptions; existing WABA ids are Messaging account ids. | Our `whatsapp_connections.waba_id` stores the Messaging account id. |
| v2 WABA-only sharing keeps working until Nov 16, 2026. | Irrelevant to us. |

## 3. What "Tech Provider" requires (from Meta's Embedded Signup overview)

| Requirement | State for the WT app |
| --- | --- |
| Be a Solution Partner or Tech Provider (Meta: "if you do not need a credit line... consider becoming a Tech Provider") | **Not verified** |
| **Business Verification** and **App Review** (the two steps of Meta's "Become a Tech Provider" page; they are done inside the App Dashboard under Use cases > WhatsApp > Customize > Tech Provider onboarding). **Access Verification** is mentioned on the pages read **only** as a third condition for raising the onboarding limit from 10 to 200 new customers per rolling 7 days; it is not defined on those pages | **Not verified** (all three) |
| Default limit **10 new business customers per rolling 7 days** until the above are complete | Applies if the app is a Tech Provider |
| Permissions `whatsapp_business_management` and `whatsapp_business_messaging`; **once the app is live, only permissions approved for Advanced Access through App Review appear** in the flow | **Not verified** |
| Tech Providers use **business tokens exclusively** | Matches our design (one Vault token per connection) |
| Onboarded clients must **add their own payment method** to their Messaging account before messaging (Tech Providers have no credit line) | Policy and onboarding-guide item |
| Embedded Signup must use **session logging** | Required in the front-end flow (Phase 3) |
| Existing WhatsApp accounts originally created via the developer app (test numbers) **cannot** be onboarded through Embedded Signup | Our Meta Test Number can never become a client connection |

**What the owner must check (Meta dashboards, not code):** whether the app is registered as a Tech Provider; Business Verification status; App Review status of the two permissions
(Advanced Access); Access Verification status; the App's mode (development or live); and the Embedded Signup configuration (config id, v5). None of these can be read from our backend.

## 4. Coexistence ("WhatsApp Business app users")

### Requirements (Meta)
- The client's WhatsApp Business app must be **version 2.24.17 or higher**.
- You must be a **Solution Partner or Tech Provider**, know Cloud API, and your **webhook callback must accept and digest** the new webhooks.
- Embedded Signup **with session logging**.
- A number used with both the app and Cloud API has a **fixed throughput of 20 messages per second**.
- Phone registration is **skipped** for coexistence (the number is already registered).

### Webhook fields to subscribe (App Dashboard, in addition to existing fields)
`account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes` (plus the existing `messages`).

### Synchronisation (strict clock)
After onboarding you have **24 hours** to request contacts and history, otherwise the client must be offboarded and complete the flow again.
Both calls are made once, with the client's business token: `POST /<PHONE_NUMBER_ID>/smb_app_data` with `{"messaging_product":"whatsapp","sync_type":"smb_app_state_sync"}` (contacts) and `"sync_type":"history"` (messages).
Meta states that **messages from the most recent 6 months** can be synchronised, and that if the client declines to share history a `history` webhook with error **2593109** is sent. Neither call can be repeated without offboarding.
Mirror new native-app messages from `smb_message_echoes`. A message the customer sent *just before* onboarding has no customer service window (template only).

### Edit and revoke (the question the earlier plan left open)
Meta's page (updated Nov 14, 2026) states **"Message Edit/Revoke is now supported"** for 1:1 chats, and documents two incoming `messages` webhook types:
- `type: "edit"`: *a WhatsApp user edited a previously sent message, within 15 minutes*; carries `edit.original_message_id` and the new message content.
- `type: "revoke"`: *a WhatsApp user revoked (deleted) a previously sent message, within two days*; carries `revoke.original_message_id`.

These are **events about a customer's messages, delivered to us**. The pages read contain **no Cloud API operation that lets a business edit or delete a message it already sent**: the messages API reference lists send operations and the "edit messages" / "revoke messages" sidebar entries link to the
*webhook* reference pages above. So: customer edit/revoke can be **synchronised** (Phase 4: today the webhook would store them as an "unsupported type" note, which is a known gap); business-side "delete for everyone" and "edit" remain **Unsupported by API** until Meta publishes an operation. The absence was confirmed on the pages read, which is evidence, not proof.

### Feature comparison (Meta's table)
| Feature | On Cloud API for an onboarded Business-app number |
| --- | --- |
| 1:1 chats | Supported; mirrored both ways; 6 months of history can sync |
| Contacts | Supported; all contacts with a WhatsApp number can sync |
| Group chats | **Not supported**; not synchronised |
| Disappearing messages, view-once, live location | **Not supported** (turned off for 1:1 chats) |
| Broadcast lists | **Not supported**; existing lists become read-only |
| Voice and video calls | **Not supported** |
| Catalog, orders, status; greeting/away messages, labels; business profile; Channels | **Not supported** through the API |
| Linked devices | Companion devices are unlinked at onboarding and can be re-linked; WhatsApp for Windows and WearOS are not supported. Messages from an unsupported companion **do not trigger** `messages` webhooks |

### Window, pricing, offboarding
- The 24-hour customer service window applies to messages **sent through Cloud API**; messages sent from the app are free and do not create or extend windows. Cloud API messages are billed at Cloud API rates.
- A client disconnects in the WhatsApp Business app (Settings > Account > Business Platform > Disconnect Account); an `account_update` webhook with `PARTNER_REMOVED` (and `disconnection_info.reason`: for example `PRIMARY_INACTIVITY` after about 14 days of an inactive primary device) is sent. **Deregister API cannot be used** for a number in both modes.
- Check status with `GET /<PHONE_NUMBER_ID>?fields=is_on_biz_app,platform_type` (expect `true` and `CLOUD_API`).
- Webhooks `edit`, `revoke`, `history`, `smb_app_state_sync`, `smb_message_echoes` identify users by **business-scoped user id** (`user_id`, `from_user_id`, `to_user_id`); the phone number may be omitted. Our schema already stores `wa_user_id`, and the webhook already accepts users without a phone number.
- Groups: the brief says the Groups API is not available to Coexistence numbers; Meta's Coexistence table agrees ("Group chats: not supported"). The Groups API itself was **not read** in this session: **Unverified**.

## 5. Other facts worth acting on
- Meta's examples use **Graph API v27.0**. Our default is **v26.0** (`WA_GRAPH_VERSION`). Moving up is a one-secret change that needs an approved test; it was not done.
- Business tokens come from the code exchange in Embedded Signup. A phone number alone can never produce a token. Clients never send us Meta passwords, App Secrets or tokens.

## 6. What this means for the build (not started in Phase 2)
| Item | Phase | Status |
| --- | --- | --- |
| Embedded Signup launch (v5) in the app, session-info capture, code exchange on the server | 3 | Pending; feature flag exists and refuses |
| Subscribe the four extra webhook fields; subscribe the client's Messaging account (`POST /<WABA_ID>/subscribed_apps`) | 3 | Pending (the subscribe action already exists for the test number only) |
| `smb_app_data` contacts and history calls inside the 24-hour window, with progress per connection | 3 | Pending |
| Handlers for `smb_message_echoes`, `history`, `smb_app_state_sync`, `account_update`; `edit` and `revoke` in `messages` | 3-4 | Pending |
| Token expiry check (`debug_token`) and alerts; `is_on_biz_app` status | 3 | Pending (columns exist) |
| Phone and payment onboarding guide for clients | 8 | Pending |

## 7. Verified vs not verified, in one table
| Statement | Status |
| --- | --- |
| Embedded Signup latest is v5; v2/v3 deprecated; v4 available | **Read from Meta (Oct 2026 pages)** |
| Coexistence needs Tech Provider/Solution Partner, app >= 2.24.17, four extra webhook fields, 24 h sync window | **Read from Meta (Nov 14, 2026)** |
| Edit/revoke are incoming events; no business-side edit/delete operation on the pages read | **Read from Meta**, absence = evidence not proof |
| WT is a Tech Provider; Business Verification, App Review, Access Verification complete | **Not verified** |
| Groups API details | **Not verified** |
| Postman collection contents | **Not accessible** |

## 8. Addendum (2026-11-16, second reading): how Tech Provider status is actually obtained
From Meta's "Become a Tech Provider" and "WhatsApp app review" pages:
1. **Verify your business** (business name, address, phone, email, website; documents if Meta cannot find the business). Business verification must be complete **before** App Review.
2. **App settings** for review: an app icon, a privacy policy and an app category.
3. **Videos**: (a) a message created and sent from the app and received in the WhatsApp client; (b) the app, or WhatsApp Manager, being used to create a message template. Meta accepts screen recordings of the API Setup cURL script and of WhatsApp Manager instead of a partner app.
4. **Advanced access** to `whatsapp_business_messaging` and `whatsapp_business_management` (written explanation of how each is used for onboarded clients). "Requesting unnecessary permissions is a common reason for rejection." The average App Review turnaround is stated as about 24 hours, and Meta says you do not need Embedded Signup fully built to start.
5. Business apps already have **Standard access** for testing with users who have a developer or admin role on the app. "If you are using the API for yourself as a Direct Developer you do not need Advanced access or app review", which is why the current test setup works without any of this; **a platform serving other businesses needs Advanced access.**
6. Onboarded clients must **add a payment method** (Tech Providers have no credit line).

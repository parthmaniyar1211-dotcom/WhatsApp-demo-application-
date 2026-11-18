# Own branded HTTPS onboarding page (launches Meta's official Embedded Signup)

**Decision (yours):** use our own branded HTTPS onboarding page that launches Meta's official Embedded Signup flow (option A in
`PHASE3_PLAN_EMBEDDED_SIGNUP_COEXISTENCE.md`). **Status: Designed. Nothing is built, nothing is registered with Meta, `FEATURE_EMBEDDED_SIGNUP` stays off.**
Building and testing it is Phase 3 and needs your approval plus the Meta items in `META_VERIFICATION_PREPARATION.md`.

## 1. What the client experiences

1. The platform admin creates the client (as today). The client's staff login is created with a temporary password and must choose its own (Phase 2.1).
2. The client signs in and opens **Connect WhatsApp** (or the admin sends them the page link). The page is ours: our logo, our colors, the client's business name, no staff/admin/owner labels.
3. Step by step, in plain language:
   * **What will happen** (you will log in to Facebook/Meta, choose or create your WhatsApp Business account, verify your number, and choose whether to keep using the WhatsApp Business app on the same phone).
   * **Consent** for chat-history synchronization (default off; text and enforcement in `PRIVACY_RETENTION_AND_CONSENT_POLICY.md`, section 3).
   * **Connect** button: launches Meta's official popup (Facebook JS SDK `FB.login` with our `config_id`).
4. Meta's flow runs in Meta's own window; we never see the client's Facebook password or WhatsApp verification code.
5. On return the page shows progress (connecting, registering the number, syncing) and finally **Connected**, with the number shown. Errors are explained in plain words with a retry.

## 2. Where it lives (HTTPS requirements)

* Must be served over **HTTPS from a domain you control**, and that domain must be added to the app's **Allowed domains** and **Valid OAuth redirect URIs** in Meta's app settings. GitHub Pages (`*.github.io`) is HTTPS today and could be registered, but a **custom domain** (for example `connect.<your-domain>`) is strongly recommended: it is what Meta and the client see, it survives a hosting change, and it can carry the privacy policy and terms pages that App Review needs. **Your decision: which domain.**
* Runs in a normal browser tab. It must **not** run inside the Android APK's WebView (origin and popup rules); in the APK, "Connect WhatsApp" opens the system browser at the page and returns to the app after.
* The page is a route of the existing React app or a small separate static page. Either way it holds **no secret**; it only has the Meta app id and `config_id` (both public by design).

## 3. Sequence (v5, Coexistence on by default)

```
Client browser (our page)              Our Edge Functions                Meta
  | 1. POST onboarding-start  ------->  create state (nonce, tenant,
  |    (signed-in login)                 user, expiry 15 min, stored)
  | <---- state, config_id
  | 2. FB.login(config_id, state) -------------------------------------> Meta popup (official flow)
  | <----- code  +  WA_EMBEDDED_SIGNUP message event (waba_id, phone_number_id)
  | 3. POST onboarding-complete {code, state, ids} -->  verify state, tenant, user, not expired, single use
  |                                       exchange code for a business token (server only)
  |                                       store token in Vault (per connection)
  |                                       subscribe the WABA to our webhook, register the number
  |                                       save connection with phone_number_id (routing key)
  |                                       if consent granted: allow history sync
  | <---- status
  | 4. Meta -> whatsapp-webhook (smb_app_data / history, state sync) routed by Phone Number ID
```

Controls: the `state` binds the Meta result to **one tenant and one signed-in user** (prevents connecting a client's number to another client); the code exchange and token never leave the server; the exchange uses the app secret held only in Edge Function secrets; session logging is sent as Meta requires; every step writes an audit row without secrets; and any unroutable event that arrives before the connection exists is **quarantined, not lost** (Phase 2.1), then replayed.

## 4. Failure handling

| Failure | Behavior |
| --- | --- |
| Client closes the popup | Page stays on step 3, nothing created, no state consumed beyond its expiry |
| Code expired or reused | `onboarding-complete` refuses, explains, offers retry |
| Number already connected to another client | Refused with a clear message (unique Phone Number ID); admin is alerted |
| Token exchange fails | Nothing stored; error audited; retry |
| Webhooks arrive before the connection row exists | Quarantined (7 days), replayed by `webhook-replay` after completion |
| Client revokes access in Meta | Meta's webhook / token error sets the connection to `error`/`revoked`; banner in the app; reconnect from the same page |

## 5. What is needed before this can be built

1. Tech Provider status and Advanced access (see `META_VERIFICATION_PREPARATION.md`): until then Embedded Signup cannot serve other businesses, and the default onboarding limit (10 new customers per rolling 7 days) applies.
2. Your domain decision and the privacy policy / terms URLs.
3. A decision on consent text (legal review).
4. Your approval to start Phase 3.

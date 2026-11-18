# WhatsApp Cloud API integration

> **Phase 2 notice (2026-11-16):** this document describes the single global connection. Edit/revoke and Embedded Signup facts were re-read from Meta on 2026-11-16; see META_TECH_PROVIDER_REQUIREMENTS.md (it corrects the earlier "unsupported edit/revoke" wording: customer edits and revokes arrive as webhooks; no business-side operation exists on the pages read).


> Status labels: see [README.md](README.md#status-labels-used-in-all-documents).
> No secret value appears in this document; only secret **names**. Identifiers (phone-number id, WABA id, app id) are
> shown as placeholders such as `<PHONE_NUMBER_ID>`.
> Related: [WEBHOOK_DOCUMENTATION.md](WEBHOOK_DOCUMENTATION.md) · [BACKEND_DOCUMENTATION.md](BACKEND_DOCUMENTATION.md) ·
> [SECURITY_DOCUMENTATION.md](SECURITY_DOCUMENTATION.md)

## 1. How the app talks to Meta

| Direction | Mechanism | Code |
| --- | --- | --- |
| App -> Meta (send text/media/template/reaction, upload media, mark read) | HTTPS to `https://graph.facebook.com/<version>/…` with `Authorization: Bearer <WA_TOKEN>` | `supabase/functions/_shared/graph.ts`, `send-whatsapp`, `mark-read` |
| Meta -> App (incoming messages, statuses) | HTTPS POST to the `whatsapp-webhook` Edge Function, signed with HMAC-SHA256 | `whatsapp-webhook` |
| Meta -> App (media download) | Two-step: Graph lookup of the media id returns a short-lived URL; the file is fetched with the same bearer token | `_shared/media.ts` |

Graph API version: **v26.0** by default (`WA_GRAPH_VERSION` overrides it without a deploy). The Meta endpoints used are
exactly these (all taken from `_shared/graph.ts` and the Edge Functions; nothing else is called):

- `POST /<PHONE_NUMBER_ID>/messages` (text, image, document, audio, video, template `hello_world`, reaction, and `status: read`)
- `POST /<PHONE_NUMBER_ID>/media` (only when `WA_MEDIA_MODE=upload`)
- `GET /<MEDIA_ID>` (incoming media lookup)
- `wa-diagnose` only (admin diagnostics): `GET /debug_token`, `GET /<PHONE_NUMBER_ID>?fields=…`, `GET /<WABA_ID>/message_templates?name=hello_world`,
  `GET /<WABA_ID>/subscribed_apps`, `GET /<APP_ID>`, `GET /<APP_ID>/subscriptions`, and `POST /<WABA_ID>/subscribed_apps` **only** when `action: subscribe_waba` is passed.

Per Meta's documentation, an endpoint not in this list must not be assumed to exist; see rule 7 in
[AI_DEVELOPER_CONTEXT.md](AI_DEVELOPER_CONTEXT.md).

## 2. The four credentials people confuse

| Name in this project | What it is | What it is used for | Lifetime | Where it lives |
| --- | --- | --- | --- | --- |
| **`WA_TOKEN`** (today: a *temporary* access token) | An access token that authorises Graph API calls on behalf of the WhatsApp Business Account | Every outgoing call: send, upload, mark read, download media, diagnostics | A temporary token from the API Setup page lasts about **24 hours**; a **System User** token can be non-expiring | Supabase secret `WA_TOKEN` (never in the browser or in git) |
| **System User token** (not configured) | The *permanent* replacement for the temporary token, created in Meta Business Settings -> System Users with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions, assigned the WhatsApp account | Same as `WA_TOKEN`; you would store it under the same secret name | Does not expire unless revoked | Would replace the value of `WA_TOKEN` |
| **`WA_APP_SECRET`** | The **App Secret** of the Meta app (App settings -> Basic). Not an access token. | Only to compute and verify the HMAC-SHA256 signature `X-Hub-Signature-256` on every webhook POST. If it is missing the webhook returns 503 (fails closed). | Until you reset it in Meta | Supabase secret |
| **`WA_VERIFY_TOKEN`** | A string you invent and type into **both** the Supabase secret and the Meta webhook form | Only for the one-time `GET` handshake (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`) when Meta saves the callback URL | Until you change it in both places | Supabase secret + Meta webhook form |

They are unrelated: the verify token proves *Meta -> you* at setup time, the app secret proves *every webhook POST came from Meta*,
and the access token proves *you -> Meta* on every call. A wrong or expired access token breaks **sending and media download
only**; it does not stop the webhook from receiving text messages (only media download needs it), and it does not affect
signature checking.

Other secrets/variables read by code: `WA_PHONE_ID` (the sending number's id), `WA_BUSINESS_ACCOUNT_ID` (WABA id, used only by
`wa-diagnose`), `WA_GRAPH_VERSION`, `WA_MEDIA_MODE` (`link` default, or `upload`), `WA_DRY_RUN` (`true` simulates sends without
calling Meta), plus the Supabase-provided `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `STAFF_EMAIL_DOMAIN`
(`admin-staff`). Values are not recorded here.

## 3. Current configuration (test mode)

| Item | State | Evidence / status |
| --- | --- | --- |
| Number | Meta **Test Number** (a sandbox number Meta provides), kept deliberately | Configured |
| Recipients | Only numbers on the test number's allowed-recipient list; others fail with Graph error **131030** | Behaviour from Meta rules; error mapping Tested locally |
| App mode | Development mode (not verified from Meta's UI by this audit) | Configured, unverified |
| Webhook callback URL | Points at the hosted `whatsapp-webhook` function | **Tested live**: `wa-diagnose` compared it with the expected URL and it matched |
| Webhook field `messages` | Subscribed | **Tested live** (diagnostic) |
| WABA subscribed to the app | Yes, subscribed via `POST /<WABA_ID>/subscribed_apps` | **Tested live**: the app appeared in the subscribed-apps list afterwards |
| `WA_TOKEN` | **Temporary, expired** at the time of this audit: sends return Graph error **190** (token expired) | Tested live (failure observed). Needs a new token pasted into the Supabase secret to send again. |
| App secret / verify token | Set in Supabase secrets | Configured; HMAC rejection of a bad signature is Tested locally, and an end-to-end signed delivery from Meta was seen earlier in this project (Tested live) |
| Production number | None | Pending (out of scope now) |
| Message templates | Only Meta's built-in `hello_world` (en_US) | Implemented; sending it live was not re-verified after the token expired |

Why messages can currently be *received* but not *sent*: receiving needs only the webhook and the app secret; sending needs a valid
access token. The app maps error 190 to a clear "token expired" message in the chat bubble (`_shared/wa_errors.ts`).

### Refreshing the temporary token (no code change)
1. Meta developer dashboard -> your app -> WhatsApp -> API Setup -> generate a new temporary token.
2. Put it into the Supabase secret `WA_TOKEN` (dashboard -> Edge Functions -> Secrets, or `supabase secrets set`). Never paste it into chat, code or docs.
3. Edge Functions read secrets on each cold start; no redeploy is normally needed, but allow a minute.
4. Repeat roughly every 24 hours, or move to a System User token (section 5).

## 4. Rules from WhatsApp that the app enforces

| Rule | Where | Status |
| --- | --- | --- |
| 24-hour customer-service window: free-form messages only within 24 h of the customer's last message (`last_inbound_at`) | `send-whatsapp` rejects with a clear error; composer shows a banner | Tested locally (Deno + browser) |
| Outside the window only an approved template may start a conversation; the app offers `hello_world` | composer + `send-whatsapp` | Tested locally; live template delivery **not** verified (token expired) |
| Media limits: images <= 5 MB; documents/audio/video <= 10 MB outgoing (WhatsApp allows more, the app is stricter); incoming up to 16 MB (bucket limit) | frontend + `send-whatsapp` + bucket | Tested locally |
| Voice notes must be **OGG/Opus**; Meta rejects WebM. The browser records WebM/Opus and remuxes it to OGG in `web/src/lib/voice.ts` | frontend | Tested locally (unit-level and in the browser with a fake mic); Meta acceptance on a real phone **not verified** |
| Reactions: one emoji per side per message | `send-whatsapp` / `apply_customer_reaction` | Tested locally |
| Rate: 20 outgoing messages per user per 60 s | `send-whatsapp` (counts `wa_messages.sent_by`) | Tested locally |
| **Delete for everyone is not available through the Cloud API.** Revoke/edit events reach the webhook only for coexistence setups. | The UI offers **Delete for me** only | Unsupported by API |
| Typing indicator: Cloud API supports sending one with a read receipt | Not implemented as a user-facing control | Pending |

## 5. Moving to production (not done; separate from test mode)

Nothing in this section is configured. Use it as a checklist when the owner decides to leave the test number.

1. **Business verification and a real number** in Meta Business Manager; register the number in WhatsApp Manager (the Test Number cannot be converted). Update `WA_PHONE_ID` and `WA_BUSINESS_ACCOUNT_ID` (secrets) to the new ids.
2. **App mode -> Live** (needs a privacy-policy URL and app review of `whatsapp_business_messaging` as required by Meta).
3. **Permanent token**: create a System User, assign the WhatsApp account and the app, grant `whatsapp_business_messaging` and `whatsapp_business_management`, generate a token with no expiry, set it as `WA_TOKEN`. Never reuse a personal/temporary token.
4. **Webhook**: re-point the callback URL if the project URL changes; re-subscribe the `messages` field; re-run `POST /<WABA_ID>/subscribed_apps` for the new WABA (admin diagnostic `subscribe_waba`).
5. **Templates**: create and get approved the templates the business needs (marketing/utility/authentication categories have different rules and pricing); extend the template picker (today fixed to `hello_world`).
6. **Recipients**: the allowed-recipient restriction disappears; opt-in and policy compliance become the business's responsibility. Pricing is per conversation/message category (check Meta's current pricing page; not verified here).
7. **Throughput and limits**: messaging limits start low and rise with quality; consider the 20/min per-user limit and retry behaviour.
8. **Security hardening** listed in [SECURITY_DOCUMENTATION.md](SECURITY_DOCUMENTATION.md) and [KNOWN_ISSUES_AND_ROADMAP.md](KNOWN_ISSUES_AND_ROADMAP.md) (monitoring, backups, password policy, site URL, headers).
9. **Re-run** [TESTING_AND_QA.md](TESTING_AND_QA.md) real-world checklist with the new number.

## 6. Error handling

`_shared/wa_errors.ts` maps Graph error codes to human-readable messages stored in `wa_messages.error` and shown on the failed bubble
(for example 190 token expired, 131030 recipient not in the allowed list, 131047 24-hour window closed, 131053 file rejected,
130429/80007 rate limits, 132001 template missing; the full table is in that file and covered by `wa_errors_test.ts`). `fetchWithRetry`
retries network errors, 429 and 5xx up to 3 times (500 ms, 1 s) with a 15 s timeout; 4xx errors are never retried.

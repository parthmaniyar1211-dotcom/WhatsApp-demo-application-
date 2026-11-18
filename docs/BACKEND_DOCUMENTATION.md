# Backend documentation

> **Phase 2 notice (2026-11-16):** this document describes the single-tenant functions. send/mark-read/webhook/admin-staff changed and admin-connections was added; see MULTI_TENANT_ARCHITECTURE.md section 8.


> Status labels: see [README.md](README.md#status-labels-used-in-all-documents).
> Related: [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md) · [WEBHOOK_DOCUMENTATION.md](WEBHOOK_DOCUMENTATION.md) ·
> [WHATSAPP_API_INTEGRATION.md](WHATSAPP_API_INTEGRATION.md) · [DEPLOYMENT_AND_OPERATIONS.md](DEPLOYMENT_AND_OPERATIONS.md)

## 1. Supabase project architecture

The backend is a single hosted Supabase project (PostgreSQL 17.11 was reported by the live database). It provides:

| Service | Used for |
| --- | --- |
| Auth | One email+password login; JWTs valid 3600 s (`jwt_exp` on the hosted project). Public sign-up disabled (`disable_signup: true`, verified). |
| PostgREST | Table reads (select only) and RPC calls from the browser. |
| Realtime | `conversations` and `wa_messages` are in the `supabase_realtime` publication (verified). |
| Storage | Private bucket `files`, 16 MiB limit, mime allow-list. |
| Edge Functions | Five functions (below), all **ACTIVE** on the hosted project (versions v4-v7 at audit time). |

Local development uses the Supabase CLI stack (`supabase start`, config in `supabase/config.toml`; project id
`whatsapp-shared-inbox`). `config.toml` also records `verify_jwt` per function.

## 2. Edge Function overview

| Function | JWT required (`verify_jwt`) | Who may call | Purpose |
| --- | --- | --- | --- |
| `whatsapp-webhook` | **No** (Meta cannot send one) - protected by HMAC signature | Meta | Receive messages and statuses. |
| `send-whatsapp` | Yes + staff check | Active staff | Send text/media/template/reaction. |
| `mark-read` | Yes + staff check | Active staff | Blue ticks + typing indicator at WhatsApp. |
| `admin-staff` | Yes + admin role | Admin staff | Create/disable/reset staff logins. **Not used by the current UI.** |
| `wa-diagnose` | Yes + admin role | Admin staff | Health check; one opt-in write action. |

Deployed `verify_jwt` values were read from the Management API and match `config.toml`.

### Code structure (every function)

```
supabase/functions/<name>/index.ts     wires real dependencies, calls Deno.serve(...)   (wa-diagnose: all logic in index.ts)
supabase/functions/<name>/handler.ts   logic as createXHandler({ env, store, fetchFn?, sleep?, now? }) -> (Request) => Response
supabase/functions/_shared/
  env.ts             waEnv(): reads WA_* secrets (blank counts as unset; dry run only when exactly "true")
  http.ts            corsHeaders, json(), HttpError, readBody(max bytes), parseJsonObject, bearerToken, logError
  graph.ts           fetchWithRetry(), graphUrl()
  media.ts           allowed types, size limits, extensions, safeFilename, storedContentType
  wa_errors.ts       staffMessage(code, detail): Meta error code -> readable text
  samples.ts         tiny sample files used only when WA_DRY_RUN=true in the webhook
  supabase_store.ts  the ONLY place that touches Supabase (service-role client) for the functions
```

This split is why the 90 Deno tests need no network: they pass in-memory stores.

## 3. Environment variables and secrets

Set as Supabase **secrets** (`supabase secrets set ...`), never in git or in the web app. Names verified against the code
(`Deno.env.get(...)`) and against the secrets list of the hosted project (names only; values are not readable).

| Name | Read by | Meaning | Default if unset |
| --- | --- | --- | --- |
| `WA_TOKEN` | webhook, send, mark-read, wa-diagnose | WhatsApp access token | none - sending/downloading fails with a clear message |
| `WA_PHONE_ID` | webhook, send, mark-read, wa-diagnose | WhatsApp Phone Number ID | none. The webhook ignores events for a different phone id **when set**. |
| `WA_APP_SECRET` | webhook, wa-diagnose | Meta App Secret (signature key) | none -> webhook answers **503** (fails closed) |
| `WA_VERIFY_TOKEN` | webhook, wa-diagnose | Token Meta echoes during webhook setup | none -> GET verification answers 403 |
| `WA_DRY_RUN` | webhook, send, mark-read, wa-diagnose | Only the exact value `true` enables dry run (no call to Meta) | off |
| `WA_GRAPH_VERSION` | all that call Meta | Graph API version | `v26.0` |
| `WA_MEDIA_MODE` | send | `link` (signed URL) or `upload` (upload to Meta, send by id) | `link` |
| `WA_BUSINESS_ACCOUNT_ID` | wa-diagnose only | WhatsApp Business Account id | checks skipped (warn) |
| `STAFF_EMAIL_DOMAIN` | admin-staff | domain for staff emails | `company.demo` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | all | provided by the platform | - |

The hosted project currently has `WA_TOKEN`, `WA_PHONE_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_BUSINESS_ACCOUNT_ID`,
`WA_DRY_RUN` and `WA_GRAPH_VERSION` (verified by name). `WA_DRY_RUN` is reported as `false` by `wa-diagnose`.
`WA_MEDIA_MODE` and `STAFF_EMAIL_DOMAIN` are not set (defaults apply).

## 4. `whatsapp-webhook`

**Purpose.** Receive everything Meta sends: customer messages, media references, reactions and delivery statuses. Full
detail in [WEBHOOK_DOCUMENTATION.md](WEBHOOK_DOCUMENTATION.md).

**Authentication.** None at the Supabase gateway (`verify_jwt = false`). `GET`: `hub.verify_token` must equal
`WA_VERIFY_TOKEN` (constant-time compare). `POST`: header `X-Hub-Signature-256` must be a valid HMAC-SHA256 of the raw
body with `WA_APP_SECRET`.

**Inputs.**

| Request | Shape |
| --- | --- |
| `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` | verification |
| `POST` JSON `{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{…}}]}]}` | Meta's standard payload (messages, contacts, statuses, metadata) |

**Outputs.**

| Case | HTTP | Body |
| --- | --- | --- |
| Verification ok | 200 | the challenge as `text/plain` |
| Verification refused | 403 | `{"error":"Verification failed"}` |
| Events processed | 200 | `{"ok":true,"stored":n,"duplicates":n,"statuses":n,"reactions":n,"ignored":n}` |
| `WA_APP_SECRET` missing | 503 | `{"error":"Webhook is not configured"}` |
| Bad/missing signature | 401 | `{"error":"Invalid signature"}` |
| Body not JSON | 400 | `{"error":"Body must be valid JSON"}` |
| Body > 1 MB | 413 | `{"error":"Request body too large"}` |
| Database failure | 500 | `{"error":"Internal error"}` (Meta retries) |
| Other methods | 405 | |

**Dependencies.** `_shared/supabase_store.ts` (`webhookStore`): RPCs `ingest_incoming`, `apply_message_status`,
`apply_customer_reaction`; Storage upload; update of `wa_messages.media_path / media_size / error`. Graph API for media
download. **Error conditions:** missing `WA_TOKEN` when media must be downloaded (message kept, error recorded);
media larger than 16 MB, unsupported type, or Meta HTTP error (message kept, reason recorded, webhook still `200`).

## 5. `send-whatsapp`

**Purpose.** The only way the app sends to WhatsApp: text, image, video, audio/voice note, PDF/document, the
`hello_world` template, and emoji reactions.

**Authentication.** `Authorization: Bearer <user JWT>`; the function verifies it with `auth.getUser(jwt)`, loads the
`staff` row and refuses disabled users.

**Input** (JSON, max 16 KiB), one of:

```jsonc
{ "conversation_id": "<uuid>", "text": "Hello", "reply_to": "<message uuid>" }                       // reply_to optional
{ "conversation_id": "<uuid>", "media_path": "outgoing/<user id>/<file>", "text": "caption", "filename": "a.pdf", "voice": true, "reply_to": "<message uuid>" }
{ "conversation_id": "<uuid>", "template": "hello_world" }
{ "conversation_id": "<uuid>", "reaction": { "message_id": "<message uuid>", "emoji": "👍" } }       // "" removes the reaction
```

**Output.** Success `200 {"message": <wa_messages row>, "dry_run": false}`. Meta refused: `502 {"error", "code":"send_failed",
"message": <failed row>}`. Other errors: `{"error": "...", "code": "..."}`.

| Condition | HTTP | `code` |
| --- | --- | --- |
| No/invalid JWT | 401 | `unauthenticated` |
| No staff row / disabled | 403 | `forbidden` |
| Invalid input (not a UUID, empty text, unknown template, bad `media_path` which must be exactly `outgoing/<caller id>/<file>`, caption > 1024, text > 4096, audio with caption, bad emoji) | 400 | `invalid` / `empty` |
| Conversation or quoted message not found / belongs to another chat | 404 | `not_found` |
| Quoted/reacted message never reached WhatsApp (no `wa_message_id`) | 409 | `invalid` |
| **24-hour window closed** (anything except a template) | 409 | `window_closed` |
| More than 20 messages in the last 60 s by this user | 429 | `rate_limited` |
| File larger than limit (photo 5 MB, other 10 MB) | 413 | `too_large` |
| `WA_TOKEN`/`WA_PHONE_ID` missing and not dry run | 500 | `not_configured` |
| Meta rejected the call | 502 | `send_failed` (reason in `error`, row marked `failed`) |

**Processing order** (`send-whatsapp/handler.ts`): authenticate -> parse -> branch (reaction / template / media / text) ->
conversation + 24-hour window -> resolve `reply_to` -> rate limit -> file checks (type from Storage metadata, size) ->
configuration check -> `create_outgoing` (status `sending`) -> Graph call -> `finishOutgoing` (`sent` + wamid, or `failed` +
reason). Reactions do not create a message row; they update `reaction_business` on the target row and are not counted
by the rate limiter (it counts `wa_messages` rows by `sent_by`).

**Graph requests made.** `POST /<WA_PHONE_ID>/messages` with `messaging_product: "whatsapp"`, `to` (or `recipient` for
customers known only by a business-scoped user id), `type`, the type's object, optional `context: {message_id}`;
media as `{link}` (10-minute signed URL) or `{id}` after `POST /<WA_PHONE_ID>/media` in upload mode; voice notes add
`voice: true` (only OGG). Retries: 3 attempts, backoff 500 ms then 1 s, only on network errors, HTTP 429 and 5xx, 15 s
timeout per try (`_shared/graph.ts`).

## 6. `mark-read`

**Purpose.** Tell WhatsApp the customer's messages were read (blue ticks on the customer's phone) and optionally show
"typing…". **Auth:** user JWT + active staff. **Input:** `{"conversation_id":"<uuid>","typing":true?}`.
**Output:** always `200` for Meta-side problems: `{"ok":true,"marked":true|false,"reason"?,"typing"?,"dry_run"?}`; errors
only for 400/401/403/404/405.

Logic: find the newest incoming message; nothing to do if none, if older than 30 days, or if it was already marked and no
typing is wanted; otherwise `POST /<WA_PHONE_ID>/messages {"messaging_product":"whatsapp","status":"read","message_id":<wamid>,"typing_indicator":{"type":"text"}?}`
(2 attempts) and remember it in `conversations.meta_read_wa_message_id`. Failures are returned as a `reason`, never as an
HTTP error, so reading a chat works when Meta is down.

## 7. `admin-staff`

**Purpose.** Manage staff logins with the service role (the browser must never hold that key). **Auth:** user JWT whose
staff row has `role = 'admin'`. **Input** `{"action": ...}`:

| action | fields | effect |
| --- | --- | --- |
| `create` | `staff_id` (3-20 letters/digits, uppercased), `password` (8-72 chars), `display_name?`, `role?` (`staff` or `admin`) | creates the auth user `<staff_id lowercase>@<STAFF_EMAIL_DOMAIN>` (confirmed) and the `staff` row; removes the auth user again if the staff row fails; 409 if the id exists |
| `set_disabled` | `user_id`, `disabled` | updates `staff.disabled` first, then bans/unbans the auth user (876000 h); an admin cannot disable themselves |
| `reset_password` | `user_id`, `password` | sets a new password |

Output `{"staff": {...}}`. Errors 400/401/403/404/405/409/500. **Status:** implemented and tested (9 Deno tests; 2
browser tests existed when the admin page existed, since removed); **not reachable from the current UI**.

## 8. `wa-diagnose`

**Purpose.** Read-only health check **run inside Supabase with the real secrets** (secret values cannot be read back, so
this is the only way to prove they work). **Auth:** admin JWT. **Input:** `{}` -> returns
`{"rows":[{"check","result":"PASS|FAIL|WARN|SKIP","detail"}],"failed":n}`. Checks (19 when everything is configured):
secret presence and lengths, `WA_DRY_RUN`, token validity and **expiry date** (via `debug_token`), phone number status,
`hello_world` template, business account subscription, whether `WA_APP_SECRET` is the app's real secret (app access token
`<app id>|<secret>`), whether Meta's webhook points at this project and subscribes to `messages`, and a self-test of the
deployed webhook (correct token, wrong token, signed POST, wrong signature, unsigned POST).

**One write action:** `{"action":"subscribe_waba"}` performs `POST /<WA_BUSINESS_ACCOUNT_ID>/subscribed_apps` and returns
the before/after list of subscribed apps. It was used once to subscribe the business account to the app. All strings in
the answer are scrubbed of the secret values. It sends no WhatsApp message and stores nothing.
There is no Deno test for this function (it is `index.ts` only); it was verified by running it against the hosted project.

## 9. Error handling

- Handlers throw `HttpError(status, message, code)`; anything else becomes `500 {"error":"Internal error"}`.
- Meta errors are translated by `staffMessage(code, detail)` in `_shared/wa_errors.ts` and always end with `(code N)`,
  e.g. 131030 "This number is not in the allowed list of the Meta test number…", 131047 24-hour window,
  190 "WhatsApp access token has expired or is invalid. An admin must set a new WA_TOKEN." Table in
  [WHATSAPP_API_INTEGRATION.md](WHATSAPP_API_INTEGRATION.md).
- Outgoing failures are **stored** on the message (`status = failed`, `error`) so they are visible in the chat.
- Webhook: database errors -> 500 (retry); media errors -> recorded on the row, still 200.

## 10. Logging and diagnostics

- Functions log counts, ids and status codes only - **never message text, tokens or file content**:
  `whatsapp-webhook: stored=… duplicates=… statuses=… reactions=… ignored=…`,
  `send-whatsapp: message=<uuid> type=<t> dry_run=<bool> ok=<bool>`, `mark-read: Meta refused (HTTP n)`, and
  `logError(label, err)` prints only the error message.
- Where to read: Supabase dashboard -> Edge Functions -> (function) -> Logs. (Reading logs through the Management API
  was attempted during this audit and the logs endpoint rejected the queries, so log access by script is **unverified**.)
- Diagnostics: `wa-diagnose` (above); `npm run real-check` (`scripts/real-check.mjs`, reads `~/wa-secrets.env`, never
  prints secrets); `npm run sim:*` scripts for the webhook ([TESTING_AND_QA.md](TESTING_AND_QA.md)).

## 11. Database communication

Functions use `serviceClient()` (`supabase_store.ts`): the service-role key, `persistSession: false`. Business writes go
through `SECURITY DEFINER` SQL functions (`ingest_incoming`, `create_outgoing`, `apply_message_status`,
`apply_customer_reaction`) that only `service_role` may execute; a few direct updates are made on `wa_messages`
(`media_path`, `media_size`, `error`, status finish, business reaction) and on `conversations.meta_read_wa_message_id`.

## 12. Deployment procedure (summary)

```bash
supabase link --project-ref <PROJECT_REF>
supabase secrets set --env-file ~/wa-secrets.env          # never from a file inside the repo
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy send-whatsapp
supabase functions deploy mark-read
supabase functions deploy admin-staff
supabase functions deploy wa-diagnose
```

Apply new migrations **before** deploying functions or the frontend that need them. Full procedure, rollback and
troubleshooting: [DEPLOYMENT_AND_OPERATIONS.md](DEPLOYMENT_AND_OPERATIONS.md). Note: the CLI in this environment asked for
`--yes` for hosted changes and `--use-api` (no Docker); both are described there.

## 13. Known backend limitations

- Only the template `hello_world` (en_US) can be sent (constant `TEMPLATES` in `send-whatsapp/handler.ts`).
- Rate limit counts only stored message rows (reactions are not counted).
- If the function crashes between the Graph call and saving the result, a message can stay in `sending`.
- No automated test for `wa-diagnose`.
- The deployed function code was not byte-compared with the repository (drift is unverified).

## Phase 2.1 additions (2026-11-18; local only, not deployed)

| Function | Auth | Purpose |
| --- | --- | --- |
| `complete-password-change` | JWT (`verify_jwt = true`) | The only way to clear `staff.must_change_password`: fresh session (30 min), flagged login, 8-72 characters, not the temporary password, rate limited; sets the password, signs out other sessions, audits. |
| `webhook-replay` | JWT, active platform admin without a pending password change | Replays the quarantined events of one Phone Number ID through the normal webhook path; returns counts only. |
| `whatsapp-webhook` (changed) | Meta signature | Unroutable change sets are quarantined with a reason instead of dropped; 500 if the quarantine cannot be written; structured, customer-data-free routing logs; hourly best-effort purge. |
| `admin-staff`, `admin-connections`, `send-whatsapp`, `mark-read` (changed) | JWT | Refuse (or give no tenant to) a login that must still change its password. `admin-staff` creates every account with the requirement set. |

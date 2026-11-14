# Decisions and fixes

## Important: the "existing code" was not in the repository

The task said `whatsapp_setup.sql`, `supabase/functions/whatsapp-webhook`, `supabase/functions/send-whatsapp`
and `README.md` already existed. The repository was **completely empty** (no commits, no files, no other
branches). I therefore wrote the backend from scratch to the description in the task, with the same file and
function names. If you have the earlier code somewhere else, it was not used and can be dropped, or tell me
where it is and I will compare the two.

Because there was no old code, there is no list of "bugs in the old code". Instead, section 3 lists the
defects I hit while building and how they were fixed, and section 4 lists the classic bugs of this kind of
backend that the code deliberately avoids (each one is covered by a test).

## 1. How it was verified

Nothing was verified against your hosted Supabase project or against Meta (no credentials here).
Everything else ran against a **real local Supabase stack** (`supabase start`: Postgres 17, GoTrue auth,
PostgREST, Realtime, Storage and the Edge Runtime in Docker) with `WA_DRY_RUN=true`:

- the migration applied cleanly, and applied cleanly a second time;
- the three functions ran in the real Edge Runtime;
- the harness scripts ran against the real webhook;
- the Playwright tests drove the real web app against that stack at desktop and phone width.

## 2. Design decisions

### Backend

| Decision | Why |
| --- | --- |
| One idempotent migration; `whatsapp_setup.sql` is a byte-for-byte copy (`npm run check:sql` enforces it) | Two files that must stay "in sync" drift. A copy with a check cannot. |
| Clients can only **read** tables. Every write goes through an Edge Function (service role) or one of four small RPCs | Smallest possible surface. The APK cannot corrupt data even with a bug. Table privileges are revoked as well as RLS, so a missing policy fails closed. |
| `staff` table with `role` and `disabled`; RLS uses `is_active_staff()` | Disabling takes effect immediately for data access (no waiting for the 1-hour JWT to expire). The auth user is also banned so it cannot sign in or refresh. |
| Unread = incoming messages newer than `conversation_reads.last_read_at` for that user, computed by `unread_counts()`; "mark read" uses the server clock | Per-user, no counters to keep consistent, immune to wrong phone clocks. |
| Take chat = `conversations.assigned_to`, set through `take_conversation()`; taking over from a colleague is allowed; release by the owner or an admin | Simple and visible to everyone through Realtime. A stuck owner (colleague went home) must not block the customer. |
| Incoming message stored by one SQL function `ingest_incoming_message` (`on conflict (wa_message_id) do nothing`) | Deduplication is atomic in the database, so two parallel Meta retries cannot both insert. |
| Status updates go through `apply_message_status`, which never moves a message backwards | Meta delivers `read` and `delivered` out of order. |
| `created_at` (arrival time, server clock) orders messages; WhatsApp's own time is kept in `wa_timestamp` and drives the 24-hour window | Ordering and unread counts must not depend on Meta's clock or on delayed deliveries; the window must depend on when the customer really wrote. |
| Bucket `files` is private, 10 MB, `image/jpeg`, `image/png`, `image/webp`, `application/pdf` only | Limits are enforced by Storage itself for every uploader, including the functions. Nothing that can run script (HTML, SVG) can be stored. |
| Outgoing files: the client uploads to `outgoing/<own user id>/…` (enforced by a storage policy), the function checks path, size and type again and gives Meta a **10-minute signed URL** | As requested. The server never trusts the client's claim about the file. |
| Incoming files other than JPEG/PNG/WebP/PDF, or larger than 10 MB, are **not stored**; the message is kept with a visible reason | "Photos and PDFs" is the scope. The staff member still sees that something was sent. |
| Audio, video, stickers, locations, reactions are stored as type `other` with "[Unsupported message type: …]" | Nothing a customer sends disappears silently. |
| Webhook returns 200 even when a file download fails, but 500 when the database fails | A broken file must not make Meta retry forever; a database outage must (duplicates are dropped). |
| Missing `WA_APP_SECRET` → HTTP **503**; wrong signature → **401** | Both reject. 503 makes the misconfiguration obvious and Meta retries later, so messages are not lost once the secret is set. |
| If `WA_PHONE_ID` is set, events for other phone number ids are ignored | Protects against a second number or app pointing at the same webhook. |
| `WA_DRY_RUN=true` also makes the **webhook** use a built-in sample photo/PDF instead of downloading from Meta | Without it the harness could not test files end to end (the simulated media id does not exist). Signature checks stay on. It is off unless the value is exactly `true`. |
| Only the `hello_world` template (en_US) can be sent | Demo scope. The allow-list is one constant in `send-whatsapp/handler.ts`. |
| Rate limit: 20 messages per staff member per minute, counted in the database | Works across function instances without extra infrastructure. |
| Graph API calls: 3 tries, backoff 0.5 s then 1 s, 15 s timeout, retry only on network errors, 429 and 5xx | 4xx answers are real rejections and are shown to staff. Known trade-off: if Meta processed a send but answered 5xx, a retry could deliver it twice. |
| Graph API version is `WA_GRAPH_VERSION`, default `v24.0` | Meta retires versions; changing it must not need a deploy. I could not check from here which version is current for your app. |
| A separate `admin-staff` function, admin role checked on the server | The service role key never leaves Supabase. |
| First admin is created in the dashboard plus one SQL statement | The alternative (a script with the service role key on your machine) breaks the "service key only in Supabase" rule. |
| Handlers take their dependencies as arguments (`handler.ts`), `index.ts` wires the real Supabase client | The Deno tests run in milliseconds with no network and no project. |
| Logs contain ids, counts, status codes and staff IDs only | No message text, no tokens, no file content. |

### Web app

| Decision | Why |
| --- | --- |
| No router, no state library, no UI kit: React, `@supabase/supabase-js`, plain CSS | As requested: simple and readable. |
| Hash routes (`#/c/<id>`, `#/admin`) | The phone back button closes a chat; works on any static host without rewrite rules. |
| The app reloads its data every time Realtime (re)connects, when the browser comes back online and when the tab becomes visible; changes that arrive during a reload are replayed on top of it | Realtime does not replay missed events. This makes "auto-reconnect" lose nothing. |
| No optimistic bubbles: the reply appears when the server answers (and through Realtime) | What staff see is always what the database has. |
| Unread badges are re-read from the server (debounced) instead of counted in the browser | Cannot drift. |
| Admin types or generates the password in clear text | The admin has to tell the staff member the password anyway. |
| The staff email domain `company.demo` is a constant in the web app and the function's default | One place each. Change both together if needed. |
| Playwright runs every test at desktop (1280 px) and phone (Pixel 7) width | Staff may use a phone. |

### Things deliberately left out (demo scope)

- Uploaded outgoing files are never deleted (also not when the send fails afterwards).
- If the function crashes between calling Meta and saving the result, a message can stay in "Sending…".
- Conversation list is limited to the 500 most recent; messages load 100 at a time with "Load earlier".
- No push notifications, no typing indicators, no message search, no audio/video.
- `WA_TOKEN` from Meta's API Setup page expires after about a day; a permanent system-user token is needed for production.

## 3. Defects found while building, and their fixes

| # | Defect | Found by | Fix |
| --- | --- | --- | --- |
| 1 | After the Realtime server restarted, the app showed "Live" again but a message that arrived in the next ~3 seconds never appeared. Realtime confirms the channel join first and the database subscription a few seconds later; changes in between are not delivered. | Playwright test that restarts the Realtime container | `useLiveChannel` reloads again when the server confirms the database subscription. Re-run 3 times: pass. **The APK must do the same.** |
| 2 | Two reloads running at the same time could let the older one overwrite newer live changes. | Review of the fix for #1 (it made concurrent reloads normal) | Changes are queued while any reload is in flight and replayed on top of each result. |
| 3 | The message list did not stay at the bottom when the area shrank (error box or attachment row appearing, phone keyboard). | Screenshot review | A `ResizeObserver` keeps it pinned unless the user scrolled up. |
| 4 | On a phone the customer name was cut to "E2E Custo…" by the owner label and button. | Screenshot review | Owner row moves under the name below 768 px. |
| 5 | `finishOutgoing` used two updates where one is enough (the status cannot move before the message id is saved). | Self-review | Single update. |
| 6 | Chosen-photo preview set state inside an effect (flagged by the React lint rules, and wrong under StrictMode). | ESLint | Object URL is created in the event handler and revoked on change/unmount. |

## 4. Classic bugs this backend avoids (each has a test)

| Bug | Protection | Test |
| --- | --- | --- |
| Signature computed over re-serialised JSON instead of the raw body | HMAC over the raw bytes, constant-time compare | "signature is checked against the exact raw body" |
| Webhook open when the secret env var is missing (`if (secret && …)`) | Fails closed with 503 / 403 | "fails closed when WA_APP_SECRET is not set", "…WA_VERIFY_TOKEN…" |
| Meta retries create duplicate messages | Unique `wa_message_id` + atomic insert | "duplicate message id is stored once", `sim:duplicate` |
| `delivered` after `read` moves the status backwards | `apply_message_status` | Playwright "late delivered must not move the message backwards" |
| Public bucket / permanent public file URLs | Private bucket, signed URLs only | Playwright checks the link is a signed URL; curl check for disabled users |
| Client can send from someone else's folder or an incoming file path | Path must be `outgoing/<caller id>/<file>` | "invalid input is 400" |
| 24-hour rule enforced only in the UI | Enforced in `send-whatsapp` (409) | "closed 24h window: text is refused…" |
| Any signed-in user (or self-signup) can read chats | RLS requires an active `staff` row; signup off | curl checks: anon → denied, disabled staff → empty, signup → `signup_disabled` |
| Default Supabase grants let `anon`/`authenticated` call internal SQL functions | Explicit `revoke` + `grant` per function | curl: `apply_message_status` as staff → "permission denied" |
| A disabled user keeps working until the token expires | RLS checks `disabled` on every query; functions check it too | curl with the still-valid token → no rows, send → 401 |
| Service role key in the client for admin actions | `admin-staff` function | `grep` for `service_role` in `web/` finds only the warning comment in `.env.example` |

## 5. Not verified (needs your accounts)

- Real WhatsApp messages in either direction, real media download from Meta, Meta fetching our signed URLs,
  the real `hello_world` template. Covered by TEST_PLAN.md stage 3.
- `supabase link`, `db push`, `secrets set`, `functions deploy` against your hosted project
  (the CLI here is not logged in). The same migration and functions ran on the local stack.
- Hosting on Cloudflare Pages / Netlify (settings are documented, not deployed).

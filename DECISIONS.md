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
- all functions ran in the real Edge Runtime;
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
| Graph API version is `WA_GRAPH_VERSION`, default `v26.0` | Meta retires versions; changing it must not need a deploy. v26.0 is the current version (see part 2). |
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


---

# Part 2: real-API correctness and WhatsApp-like features

## 6. How the Meta documentation was read

The task said to read the current official docs and not rely on memory. `developers.facebook.com` and
`graph.facebook.com` are **blocked by this session's network policy**, so I could not open the pages
directly. I read them through web search restricted to `developers.facebook.com`, which returns the content
of the official pages. To read them directly next time, allow `developers.facebook.com` in the session's
network settings. Consequence: facts below marked "confirmed" came from the official pages via search;
anything I could not find there is marked "not confirmed" and is covered by a step in REAL_TEST_PLAN.md.

| Fact | Source page | Status |
| --- | --- | --- |
| Latest Graph API version is **v26.0**, released 2026-07-29. v24.0 was still valid but two versions old. | Graph API changelog / versions | confirmed. Default changed from v24.0 to v26.0. |
| Mark as read: `POST /<phone id>/messages` `{ messaging_product, status: "read", message_id }`; adding `typing_indicator: { type: "text" }` shows "typing…" (dismissed on send or after 25 s); marking one message marks earlier ones; within 30 days | "Mark messages as read", "Typing indicators" | confirmed |
| Reaction: `type: "reaction"`, `reaction: { message_id, emoji }`, empty emoji removes; not for messages older than 30 days | Messages reference | confirmed |
| Quote: top-level `context: { message_id }` | Messages reference | confirmed |
| Audio: AAC, AMR, MP3, M4A, OGG (Opus only, mono), 16 MB. Voice notes need OGG/Opus and `audio.voice: true`. A "played" status exists for voice notes (since 2026-03-17) | "Audio messages", Media reference | confirmed |
| Images JPEG/PNG **5 MB**; video MP4/3GP 16 MB (H.264 + AAC); documents 100 MB; stickers WebP | Media reference | confirmed |
| Media download: `GET /<media id>` → `{ url, mime_type, sha256, file_size }`; download the URL with the bearer token; URL valid 5 minutes | Media reference | confirmed |
| Sending by `link` works (Meta caches the asset 10 minutes) but uploading and sending by `id` is recommended | Media reference, image / video pages | confirmed |
| Incoming shapes for audio (`voice`), contacts, interactive (`button_reply`, `list_reply`), button (`payload`, `text`), unsupported (`unsupported.type`, error 131051), failed statuses (`errors[].code/title/message/error_data.details`) | Webhook reference pages | confirmed |
| Incoming shapes for location and reaction, and `context.forwarded` | Webhook reference | **not confirmed** by the search (pages exist, content not returned). Implemented from the long-standing documented format; REAL_TEST_PLAN steps 9, 10. |
| Since April 2026 webhooks carry a business-scoped user id (`from_user_id`, `contacts[].user_id`); the phone number can be missing for customers with a username; such customers are addressed with `recipient` instead of `to` | "Business-scoped user IDs" | confirmed for webhooks. Sending to a user id: documented, start date not confirmed. |
| Error codes 190, 131026, 131047, 131049, 131051, 131053, 131031, 132000, 132001, 132015, 133010, 80007, 130429, 131016, 131021, 131057 | "WhatsApp error codes" | confirmed |
| Error codes 131030, 131052, 131056 | same page | **not returned** by the search. Mapped from their long-standing meaning. |

## 7. Mismatches found in the audit, and the fixes

| # | Mismatch with the real API | Fix |
| --- | --- | --- |
| 1 | Default Graph version v24.0 was two versions behind. | Default `v26.0`; `real-check` compares the requested version with the one Meta actually served. |
| 2 | A customer without a visible phone number (username users, 2026) was **silently dropped**: the webhook required a numeric `from`. | Messages are accepted with `from_user_id`; conversations are matched by phone number or user id and learn the other one when Meta sends it; replies use `recipient` when there is no number. Verified on the local database (three messages, with and without number, land in one chat). |
| 3 | Audio, video, stickers, locations, contacts, button and list replies were stored as "[Unsupported message type]". | All are stored as their own type and rendered. |
| 4 | Reactions from the customer were stored as an "unsupported" message. | They update the reacted-to message (`reaction_customer`); a reaction without emoji removes it. |
| 5 | Quotes were lost in both directions. | `context.id` is stored; `reply_to` is sent as `context.message_id`. |
| 6 | The `played` status was ignored. | Accepted, after `read`. |
| 7 | Photos up to 10 MB were accepted and would fail at Meta (limit 5 MB). | 5 MB for photos in the app and in `send-whatsapp`. |
| 8 | Only images and PDFs were stored; WhatsApp voice notes arrive as `audio/ogg; codecs=opus`. | Bucket and code accept Meta's audio/video types and common office documents; 16 MB (Meta's audio/video limit). A file type that does not fit its message type (a PDF sent as "image") is refused. |
| 9 | Failed sends and failed statuses showed Meta's raw text. | `_shared/wa_errors.ts` maps the codes to staff-facing sentences and always appends "(code N)". |
| 10 | The business never told WhatsApp that messages were read, so customers never saw blue ticks. | New `mark-read` function, called when a chat is opened or a message arrives in the open chat; optional typing indicator. |
| 11 | An expired token during media download produced "HTTP 401". | "…the WhatsApp access token is invalid or expired". |
| 12 | Voice notes uploaded from the browser were stored as `audio/ogg` without the Opus parameter, because Storage drops it for multipart uploads. Meta requires OGG audio to be declared as Opus. | The web app uploads raw bytes with the full Content-Type. Found by the Playwright test that downloads the stored file. **The APK must upload the same way.** |

24-hour window logic was re-checked and left as it was: the window is counted from the time WhatsApp
reports for the customer's last message; templates are always allowed; reactions and quoted replies need an
open window because they are normal (non-template) messages.

## 8. Decisions in part 2

| Decision | Why |
| --- | --- |
| Signed-link sending stays the default; `WA_MEDIA_MODE=upload` switches to "upload to Meta, send by id" | The task asks for signed URLs. Meta recommends ids, and I cannot prove from here that Meta accepts our link for every type (audio is the risky one). The switch needs no deploy. |
| Voice notes: record with `MediaRecorder`, force mono through the Web Audio API, and **repackage** Chrome's WebM/Opus into OGG/Opus in the browser (about 150 lines, no library) | Meta accepts OGG/Opus but not WebM. The Opus packets are identical in both containers, so no re-encoding and no multi-megabyte ffmpeg download. Firefox records OGG directly. Safari can only record AAC/MP4, which WhatsApp accepts as normal audio, not as a voice note. The result is checked with ffprobe in the test (Opus, mono, decodes cleanly). |
| Reactions are columns on the message (`reaction_customer`, `reaction_business`), not rows | WhatsApp allows one reaction per participant per message, and the business is one participant, whoever of the staff clicks. Updates travel through the existing Realtime subscription. |
| `mark-read` never returns an error for a Meta failure | Staff must be able to read a chat when Meta is down or the token expired. The reason is in the response and the function log. |
| Typing indicator at most every 20 seconds | WhatsApp shows it for 25 seconds; one call per keystroke would burn the rate limit. |
| Starred and hidden are per staff member (`message_flags`); hidden messages are filtered in that person's view and in their search | "Hide for me" must not affect colleagues, and nothing can be deleted for the customer anyway. The UI says so at the moment of hiding. |
| Quick replies are shared by all staff and any staff member can edit them | Small team; one place to maintain. Three starter snippets are created when the table is empty. |
| Notes and labels live on the conversation and are edited through one RPC | Everyone sees them live; clients still cannot write tables directly. |
| Message search is `ILIKE` on body and file name, limited to 100 hits | Simple and correct at demo scale. A trigram index is the next step if it gets slow. |
| Unread divider is computed once when the chat opens; pages are 50 messages; older pages load when scrolling near the top | WhatsApp behaviour. A jump to an older message (search, star, quote) loads everything between it and the loaded part, so the list never has a gap. |
| Location opens a Google Maps link; no embedded map | No map key or third-party script in the app. The link is built from the stored numbers only, never from a URL the customer sent. |
| Emoji picker is a fixed set of 80; reactions offer 6 | No dependency. |
| Settings (theme, sound, notifications) are per browser in `localStorage` | They are device preferences, not account data. Sound is on by default, notifications are off until the user allows them. |
| The setup SQL is now all migrations concatenated (`npm run check:sql`) | The first migration may already be applied on your project, so new schema goes in a second file. |
| Incoming message types nobody can render (polls, orders, live location, deleted messages) are stored as type `other` with a readable note | Staff see that the customer sent something and can ask for it in another form. |
| Not built, on purpose | Online / last seen, Status/Stories, editing or deleting sent messages for the customer, calls: the official API has none of them. The customer details panel and the message menu say so. |

## 9. Defects found while building part 2

| # | Defect | Found by | Fix |
| --- | --- | --- | --- |
| 7 | Voice notes lost their `codecs=opus` content type on upload (see mismatch 12). | Playwright voice test | Raw-bytes upload. |
| 8 | Jumping twice to the same message within 2.5 s did not scroll the second time. | Playwright search test | Every jump creates a new highlight object. |
| 9 | "Scroll to latest" did not count new messages when the chat was opened at the unread divider. | Playwright history test | The last seen message is recorded on the first scroll event too. |
| 10 | Location and contact cards picked up the login card's CSS class and were drawn as big boxes. | Screenshot review | Separate class. |
| 11 | On a phone the message menu ran off the right edge of the screen, and the menu arrow overlapped the text. | Screenshot review | The menu is a bottom sheet under 768 px; text leaves room for the arrow on touch screens. |
| 12 | Adding the root `package.json` made `deno check` look for `node_modules`. | Running the checks | Deno scripts use `--no-config`. |

## 10. Not verified in part 2 (needs your credentials or phone)

- Every call to Meta: sending text, media, voice notes, templates, reactions and quotes; mark-as-read and
  typing; media download; Meta fetching our signed links; real webhook payloads from a phone.
  All request bodies are asserted in Deno tests against the documented shapes; REAL_TEST_PLAN.md covers each.
- `scripts/real-check.mjs` against the real Graph API. It was run against the local stack and a local
  stand-in for the Graph API (pass and fail cases, secrets redacted).
- Deploying the new migration and the `mark-read` function to your hosted project.
- Recording in Firefox and Safari (only Chromium was run).


---

# Part 3: WhatsApp Web look, contacts, no staff concept

The request: "exactly like the WhatsApp interface", add a contact by number, chat with them through the WhatsApp
API, no employees / staff / admin, no Stories.

| Decision | Why |
| --- | --- |
| New look: dark by default, chat list left, conversation right, doodle background, green/teal palette, avatars, filter chips (All / Unread / Starred), round icon buttons | Matches the screenshot of WhatsApp Web. Own colours and icons, no WhatsApp logo or artwork. Light theme is in the ⋯ menu. |
| One login: only a password is typed; the app signs in as `admin1@company.demo`. Change it in ⋯ → Change password | Removes staff IDs from the interface. The site is public, so some login is still required: without it anyone could read chats and send messages. |
| Removed from the interface: staff IDs, admin page, owner / take chat, labels, notes, sender IDs on messages | Not wanted. |
| Kept in the backend: `staff` table, roles, `admin-staff` function, `sent_by` columns | Row level security is built on `is_active_staff()`, and the APK plan uses the same backend. Nothing there is exposed in the web app any more. Removing it would be a risky migration for no visible gain. |
| New chat = RPC `start_conversation(phone, name)`; saved name in `conversations.contact_name` | Clients cannot insert into `conversations`. The WhatsApp profile name keeps arriving in `customer_name` and never overwrites the saved name (tested). |
| A 10-digit number gets +91 | The default country for this team. Anything else is typed with its country code. Constant `DEFAULT_COUNTRY` in `NewChatDialog.tsx`. |
| Starting a chat shows the template sender, with the reason in plain words | WhatsApp rule: a business can only open a conversation with an approved template; free text works for 24 hours after the person replies. This cannot be removed. A Meta *test* number can only message numbers on its allowed list. |
| "Hide for me" renamed "Delete for me", with a note that the other person still has the message | Same feature, WhatsApp wording, honest about the API limit. |
| Settings (theme, sound, notifications, quick replies, password, log out) live in the ⋯ menu of the chat list | Like WhatsApp Web. On a phone the menu is therefore in the list, not inside a chat. |
| Search typed as text no longer matches phone numbers | A defect found by a test: a name search containing digits ("Asha 7421") also matched unrelated numbers. Numbers are matched only when the query looks like a number. |

Not changed: all backend behaviour from parts 1 and 2 (webhook, send, mark-read, 24-hour rule, error mapping).

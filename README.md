# WhatsApp shared inbox

Customers message the business WhatsApp number. The message appears in a shared web inbox in real time.
Staff reply from the web app and the customer receives the reply in WhatsApp. Photos, PDFs, videos and
voice notes work both ways, with ticks, quoted replies, reactions and the other things staff know from WhatsApp
(as far as the official Cloud API allows).

The web app looks and works like WhatsApp Web: a chat list on the left, the conversation on the right, a
"New chat" button to add a phone number, and a single password to sign in (no staff IDs, no admin page).

This repository holds the **Supabase backend** (database, storage, Edge Functions), a **web test console**
and a **test harness** that simulates WhatsApp without a phone. The future Android APK uses the same backend,
so a pass here means the backend is correct.

```
whatsapp_setup.sql                 full schema (paste into the Supabase SQL editor)
supabase/migrations/               the same schema as a migration (for `supabase db push`)
supabase/functions/
  whatsapp-webhook/                receives messages + delivery statuses from Meta (no JWT, HMAC signature)
  send-whatsapp/                   staff replies, quotes, reactions (JWT, 24-hour rule, rate limit, WA_DRY_RUN)
  mark-read/                       blue ticks for the customer + "typing…" (JWT)
  admin-staff/                     create / disable / reset staff logins (admin JWT, service role inside)
  tests/                           Deno tests for all functions
scripts/                           test harness: simulate incoming messages, duplicates, bad signatures
scripts/real-check.mjs             live smoke test with your real credentials (sends nothing)
web/                               Vite + React + TypeScript web console (anon key only)
TEST_PLAN.md                       step-by-step test without a phone (simulated + dry run)
REAL_TEST_PLAN.md                  step-by-step test with your phone
DECISIONS.md                       design decisions and bugs fixed
```

## What you need

- Node.js 20.12 or newer
- The Supabase CLI (`npm i -g supabase`, or use `npx supabase ...`)
- A Supabase account and a Meta developer app with the WhatsApp product (for the real test only)
- Optional: Deno 2 (only to run the function tests yourself)

## Setup from zero

### 1. Create the Supabase project

1. https://supabase.com/dashboard → **New project**. Wait until it is ready.
2. **Project Settings → API**: note the **Project URL** and the **anon public** key
   (a `sb_publishable_...` key also works). Note the **project ref** (the `abcd...` part of the URL).
3. **Authentication → Sign In / Providers**: keep **Email** enabled and turn **off**
   "Allow new users to sign up". Staff accounts are created only by an admin.
   (Even with signup on, a stranger could not read anything: without a `staff` row every table is closed.)

### 2. Create the database schema

Either paste the whole of `whatsapp_setup.sql` into **SQL Editor → New query → Run**, or use the CLI:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

The SQL is idempotent. Running it twice is safe.

### 3. Create the first admin

1. **Authentication → Users → Add user → Create new user**
   - Email: `admin1@company.demo`
   - Password: choose one (8+ characters)
   - Tick **Auto Confirm User**
2. **SQL Editor**, run:

```sql
insert into public.staff (user_id, staff_id, display_name, role)
select id, 'ADMIN1', 'Admin', 'admin' from auth.users where email = 'admin1@company.demo'
on conflict (user_id) do update set role = 'admin', disabled = false;
```

You now sign in to the web app with just that password (the app signs in as `admin1@company.demo`).
Change the password any time from the ⋯ menu → **Change password**.

### 4. Set the secrets

These live only in Supabase. Never put them in `web/`, in git, or in chat.

| Secret | Where it comes from |
| --- | --- |
| `WA_VERIFY_TOKEN` | You invent it (for example `openssl rand -hex 24`). You type the same value into Meta later. |
| `WA_APP_SECRET` | Meta app dashboard → **App settings → Basic → App secret** |
| `WA_TOKEN` | Meta app dashboard → **WhatsApp → API Setup** → access token |
| `WA_PHONE_ID` | Meta app dashboard → **WhatsApp → API Setup** → **Phone number ID** (not the phone number) |
| `WA_DRY_RUN` | `true` for the simulated tests, `false` for the real test |

Put them in a file **outside this repository** (for example `~/wa-secrets.env`, one `NAME=value` per line), then:

```bash
supabase secrets set --env-file ~/wa-secrets.env
```

To change one value later: `supabase secrets set WA_DRY_RUN=false`.

Optional secrets:

| Secret | Default | Meaning |
| --- | --- | --- |
| `WA_GRAPH_VERSION` | `v26.0` | Graph API version (v26.0 is the current one, released 2026-07-29) |
| `WA_MEDIA_MODE` | `link` | `link`: Meta fetches files from a 10-minute signed URL. `upload`: files are uploaded to Meta first and sent by media id. Switch to `upload` if Meta reports media errors 131052 / 131053. |

### 5. Deploy the functions

```bash
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy send-whatsapp
supabase functions deploy mark-read
supabase functions deploy admin-staff
```

Updating an existing project: run `supabase db push` (or paste `whatsapp_setup.sql` again, it is safe to
re-run) **before** deploying the functions, because the new functions use the new SQL functions.

The webhook URL is `https://YOUR_PROJECT_REF.supabase.co/functions/v1/whatsapp-webhook`.

### 6. Start the web app

```bash
cd web
cp .env.example .env        # then edit .env: Project URL and anon key
npm install
npm run dev                 # http://localhost:5173
```

Sign in with the password from step 3.

**Add a contact:** click the new-chat button (top left), type the number with country code (a 10-digit number gets
+91), optionally a name, **Start chat**. WhatsApp only lets a business start a conversation with an approved
template, so the chat offers **Send template** first (`hello_world`). Once the person replies you can type freely
for 24 hours. A Meta test number can only message numbers added under WhatsApp → API Setup.

### 7. Configure the test harness

```bash
cp .env.example .env        # in the repository root; then edit .env
```

Fill in `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_PHONE_ID` (same values as the Supabase secrets) and the
`E2E_STAFF_ID` / `E2E_PASSWORD` of the staff login you created. This file is git-ignored.

### 8. Connect Meta (needed only for the real test)

1. Meta app dashboard → **WhatsApp → Configuration → Webhook → Edit**
   - Callback URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/whatsapp-webhook`
   - Verify token: the value of `WA_VERIFY_TOKEN`
   - **Verify and save**
2. Under **Webhook fields**, subscribe to **messages**.
3. **WhatsApp → API Setup**: add your own phone number to the "To" list of the test number.

### 9. Test

1. [TEST_PLAN.md](TEST_PLAN.md): everything without a phone (simulated messages, dry run).
2. `npm run real-check`: checks the deployed webhook and your real token. It reads `~/wa-secrets.env`
   (the same file you used for `supabase secrets set`), sends no message and never prints a secret.
3. [REAL_TEST_PLAN.md](REAL_TEST_PLAN.md): the test with your phone.

**Health check inside Supabase.** `wa-diagnose` (admin login required, sends nothing, stores nothing) runs with the
real secrets and returns only pass/fail: secret names and lengths, whether the token is valid and when it expires,
the phone number, the template, whether `WA_APP_SECRET` is really this Meta app's secret, whether Meta's webhook points
at this project with the `messages` field, and a signed/unsigned/wrong-signature test of the deployed webhook.
Call it with `POST /functions/v1/wa-diagnose` and the admin's access token. It is read-only unless the body is
`{"action":"subscribe_waba"}`, which subscribes the app to the business account (`POST /<WABA id>/subscribed_apps`).

## Commands

Run from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev` | start the web app (http://localhost:5173) |
| `npm run build` | type-check and build the web app into `web/dist` |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` for the web app |
| `npm run check:functions` | `deno check` + `deno lint` on the Edge Functions |
| `npm run test:functions` | Deno tests for the Edge Functions (no network needed) |
| `npm run check:sql` | checks `whatsapp_setup.sql` equals the migration |
| `npm run sim:all` | the whole simulated webhook test |
| `npm run sim -- text "Hello"` | one simulated message: `text`, `image`, `video`, `document`, `audio`, `sticker`, `location`, `contacts` |
| `npm run sim -- text "Yes" --reply-to <wa_message_id>` | the customer quotes a message |
| `npm run sim -- reaction <wa_message_id> 👍` | the customer reacts (no emoji = removes the reaction) |
| `npm run sim -- status <wa_message_id> delivered` | a delivery status: `sent`, `delivered`, `read`, `played`, `failed` |
| `npm run real-check` | live check of the deployed webhook and your real token (needs `~/wa-secrets.env`) |
| `npm run test:e2e` | Playwright test against your Supabase project (first time: `cd web && npx playwright install chromium`) |

## Hosting the web app

**GitHub Pages (set up in this repository).** `.github/workflows/deploy-web.yml` builds `web/` and publishes it
on every push to the default branch.

1. Once: repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push, or run **Actions → Deploy web app → Run workflow**.
3. The site is at `https://<owner>.github.io/<repository>/`.

The workflow contains the public Supabase URL and anon key (they are in the browser bundle of every hosted copy
anyway; row level security protects the data). Never add the service_role key or any `WA_*` value there.
Asset paths are relative (`base: "./"`), so the same build also works at the root of another host.

**Cloudflare Pages / Netlify**

| Setting | Cloudflare Pages | Netlify |
| --- | --- | --- |
| Root / base directory | `web` | `web` |
| Build command | `npm run build` | `npm run build` |
| Output / publish directory | `dist` | `dist` |
| Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | same |
| Node version | 20 or newer (`NODE_VERSION=22`) | same |

Only the anon key goes into hosting settings. `web/public/_headers` adds basic security headers on both hosts.

## Running everything locally (optional, needs Docker)

The whole stack can run on your machine, without a Supabase account or Meta:

```bash
cp supabase/functions/.env.example supabase/functions/.env   # throwaway local secrets, dry run on
supabase start                                               # applies the migration
node scripts/local-create-admin.mjs ADMIN1 "choose-a-password"
supabase status                                              # shows the local API URL and anon key for web/.env
```

Use `WA_APP_SECRET=local-app-secret`, `WA_VERIFY_TOKEN=local-verify-token`, `WA_PHONE_ID=LOCAL_PHONE_ID`
in the root `.env`, then run `npm run sim:all` and `npm run test:e2e`.

## What the web app does

| Feature | Notes |
| --- | --- |
| Ticks | clock (sending), one grey (sent), two grey (delivered), two blue (read, or played for voice notes), red mark (failed, with the reason) |
| Blue ticks for the customer | opening a chat marks the customer's messages as read at WhatsApp |
| Typing indicator | the customer sees "typing…" while staff write (WhatsApp shows it for at most 25 s) |
| Reply with quote, reactions | both directions, from the small arrow at the top right of a message |
| Voice notes | record with the microphone button; sent as OGG/Opus so WhatsApp shows a real voice note |
| Photos, videos, stickers, documents, locations, contacts | preview, player, file card with name and size, map link |
| Long chats | date separators, grouped messages, unread divider, endless scrolling, "scroll to latest" button |
| Search | in the sidebar: chats (name, number, label) and message text in all chats; in a chat: the magnifier |
| Starred / Delete for me | private to you. Deleting for me never deletes anything for the other person |
| Quick replies | type `/` in the reply box; manage them under Settings (gear) → Quick replies |
| Contact info | the ⓘ button: saved name (editable), number, starred messages, messages deleted for me |
| Notifications, sound, dark mode | Settings (gear), remembered per browser |
| Emoji, paste, drag and drop | emoji button; Ctrl+V a screenshot; drop a file on the chat |

Not possible with the official WhatsApp Business API, and therefore not in the app: the customer's online /
last-seen status, Status/Stories, editing or deleting a sent message for the customer, and calls.
The contact info panel and the message menu say so.

## Backend contract (for the APK)

The APK uses the same anon key and a staff login (`emp1001@company.demo` + password).

- **Read** (RLS: active staff only): `conversations`, `wa_messages`, `staff`, `conversation_reads`,
  `quick_replies`, and the caller's own `message_flags`.
- **Realtime**: `postgres_changes` on `conversations` and `wa_messages`. Reload the data every time the
  channel reports the database subscription is active (see `web/src/hooks/useLiveChannel.ts`).
  Reactions, statuses, labels and notes arrive as updates of those rows.
- **RPC**: `unread_counts()`, `mark_conversation_read(p_conversation_id)`,
  `take_conversation(p_conversation_id)`, `release_conversation(p_conversation_id)`,
  `set_message_flags(p_message_id, p_starred, p_hidden)`, `save_quick_reply(p_id, p_shortcut, p_body)`,
  `delete_quick_reply(p_id)`, `update_conversation_info(p_conversation_id, p_notes, p_labels)`,
  `search_messages(p_query, p_conversation_id, p_limit)`.
- **Send**: upload the file (if any) to bucket `files` at `outgoing/<user id>/<name>` as **raw bytes with
  the Content-Type header** (not multipart), then `POST /functions/v1/send-whatsapp` with one of:
  - `{ conversation_id, text, reply_to? }`
  - `{ conversation_id, media_path, text?, filename?, voice?, reply_to? }`
    (JPEG/PNG ≤ 5 MB, PDF / MP4 / audio ≤ 10 MB; voice notes must be OGG/Opus mono uploaded as
    `audio/ogg; codecs=opus`)
  - `{ conversation_id, template: "hello_world" }`
  - `{ conversation_id, reaction: { message_id, emoji } }` (`emoji: ""` removes it)

  `reply_to` and `reaction.message_id` are `wa_messages.id` values. Errors are `{ error, code }` with HTTP
  400 / 401 / 403 / 404 / 409 (`window_closed`) / 413 / 429 / 502.
- **Read receipts / typing**: `POST /functions/v1/mark-read` with `{ conversation_id, typing? }` when the
  user opens a chat, when a new message arrives in the open chat, and (with `typing: true`, at most every
  20 s) while the user types.
- **Files**: the bucket is private. Ask for a signed URL when showing a file.
- **Contacts**: RPC `start_conversation(p_phone, p_name)` (digits with country code) and
  `rename_contact(p_conversation_id, p_name)`; `conversations.contact_name` is the saved name and wins over the
  WhatsApp profile name (`customer_name`).
- **Admin** (not used by the web app any more): `POST /functions/v1/admin-staff` with `action` = `create` / `set_disabled` / `reset_password`.
- **Customers without a phone number**: since 2026 Meta can hide the number of customers who use a
  username. `conversations.wa_id` is then Meta's user id (not digits); show "number hidden".

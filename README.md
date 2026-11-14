# WhatsApp shared inbox

Customers message the business WhatsApp number. The message appears in a shared web inbox in real time.
Staff reply from the web app and the customer receives the reply in WhatsApp. Photos and PDFs work both ways.

This repository holds the **Supabase backend** (database, storage, Edge Functions), a **web test console**
and a **test harness** that simulates WhatsApp without a phone. The future Android APK uses the same backend,
so a pass here means the backend is correct.

```
whatsapp_setup.sql                 full schema (paste into the Supabase SQL editor)
supabase/migrations/               the same schema as a migration (for `supabase db push`)
supabase/functions/
  whatsapp-webhook/                receives messages + delivery statuses from Meta (no JWT, HMAC signature)
  send-whatsapp/                   staff replies (JWT, 24-hour rule, rate limit, WA_DRY_RUN)
  admin-staff/                     create / disable / reset staff logins (admin JWT, service role inside)
  tests/                           Deno tests for all three functions
scripts/                           test harness: simulate incoming messages, duplicates, bad signatures
web/                               Vite + React + TypeScript web console (anon key only)
TEST_PLAN.md                       step-by-step manual test
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

You now sign in to the web app with staff ID `ADMIN1`. Create all other staff from the **Admin** page.

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
Optional: `WA_GRAPH_VERSION` (default `v24.0`).

### 5. Deploy the functions

```bash
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy send-whatsapp
supabase functions deploy admin-staff
```

The webhook URL is `https://YOUR_PROJECT_REF.supabase.co/functions/v1/whatsapp-webhook`.

### 6. Start the web app

```bash
cd web
cp .env.example .env        # then edit .env: Project URL and anon key
npm install
npm run dev                 # http://localhost:5173
```

Sign in with `ADMIN1`. Open **Admin**, create `EMP1001` with a password.

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

Follow [TEST_PLAN.md](TEST_PLAN.md).

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
| `npm run sim:text -- "Hello"` | one simulated text message (also `sim:image`, `sim:document`) |
| `npm run sim:status -- <wa_message_id> delivered` | a simulated delivery status |
| `npm run test:e2e` | Playwright test against your Supabase project (first time: `cd web && npx playwright install chromium`) |

## Hosting the web app (optional)

Running it locally is enough for the test. To host it for free:

| Setting | Cloudflare Pages | Netlify |
| --- | --- | --- |
| Root / base directory | `web` | `web` |
| Build command | `npm run build` | `npm run build` |
| Output / publish directory | `dist` | `dist` |
| Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | same |
| Node version | 20 or newer (`NODE_VERSION=22`) | same |

Only the anon key goes into the hosting settings. `web/public/_headers` adds basic security headers on both hosts.

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

## Backend contract (for the APK)

The APK uses the same anon key and a staff login (`emp1001@company.demo` + password).

- **Read** (RLS: active staff only): `conversations`, `wa_messages`, `staff`, `conversation_reads`.
- **Realtime**: `postgres_changes` on `conversations` and `wa_messages`. Reload the data every time the
  channel reports the database subscription is active (see `web/src/hooks/useLiveChannel.ts`).
- **RPC**: `unread_counts()`, `mark_conversation_read(p_conversation_id)`,
  `take_conversation(p_conversation_id)`, `release_conversation(p_conversation_id)`.
- **Send**: upload the file (if any) to bucket `files` at `outgoing/<user id>/<name>.jpg|png|pdf`, then
  `POST /functions/v1/send-whatsapp` with `{ conversation_id, text?, media_path?, filename?, template? }`.
  Errors are `{ error, code }` with HTTP 400 / 401 / 403 / 404 / 409 (`window_closed`) / 413 / 429 / 502.
- **Files**: the bucket is private. Ask for a signed URL when showing a file.
- **Admin**: `POST /functions/v1/admin-staff` with `action` = `create` / `set_disabled` / `reset_password`.

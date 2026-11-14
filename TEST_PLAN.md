# Test plan

Do the three stages in order. Each stage adds one real component.

| Stage | WhatsApp needed | `WA_DRY_RUN` on the server |
| --- | --- | --- |
| 1. Simulated incoming messages | no | `true` |
| 2. Reply test | no | `true` |
| 3. Real test with your phone | yes | `false` |

Before you start: finish README.md steps 1 to 7. Keep the web app open (`npm run dev`, http://localhost:5173)
and signed in as a staff member (for example `EMP1001`). All commands run from the repository root.

Make sure dry run is on for stages 1 and 2:

```bash
supabase secrets set WA_DRY_RUN=true
```

---

## Stage 1: simulated tests with the harness (no WhatsApp)

The harness builds the same JSON Meta sends, signs it with `WA_APP_SECRET` and posts it to your webhook.

### 1.1 Everything in one go

```bash
npm run sim:all
```

- **Pass:** the last line is `ALL PASSED`, and every line above starts with `PASS` (one `SKIP` is fine if you
  did not set `E2E_STAFF_ID` / `E2E_PASSWORD`).
- **Fail:** any line starting with `FAIL`. The line says what to check. The usual causes:

| Message | Cause |
| --- | --- |
| `HTTP 401` on a signed message | `WA_APP_SECRET` in `.env` differs from the Supabase secret |
| `HTTP 503` | `WA_APP_SECRET` is not set in Supabase |
| `correct verify token -> HTTP 403` | `WA_VERIFY_TOKEN` in `.env` differs from the Supabase secret |
| `accepted the request but ignored the event` | `WA_PHONE_ID` in `.env` differs from the Supabase secret |
| `HTTP 404` | the function is not deployed, or `VITE_SUPABASE_URL` is wrong |
| `HTTP 401` on `verify-webhook` | the webhook was deployed without `--no-verify-jwt` |

The individual steps, if you want to run them one at a time:

| Step | Command | Pass |
| --- | --- | --- |
| Webhook verification | `npm run sim:verify` | 200 with the challenge for the right token, 403 for a wrong token |
| Bad signature | `npm run sim:bad-signature` | four lines `-> HTTP 401` |
| Text | `npm run sim:text -- "Hello"` | `PASS  text accepted` |
| Image | `npm run sim:image -- "A caption"` | `PASS  image accepted` |
| Document | `npm run sim:document -- "invoice.pdf"` | `PASS  document accepted` |
| Duplicate | `npm run sim:duplicate` | `second delivery recognised as duplicate` and `exactly one row in wa_messages` |

### 1.2 Look at the web inbox (do not reload the page)

- **Pass:**
  - A conversation **Test Customer** appeared by itself, at the top of the list, with a green unread badge.
  - The header shows a green dot and **Live**.
  - Open it: you see the text messages, a green checkered test photo, and a `invoice.pdf` /
    `test-document.pdf` row with a **Download** link that opens a small PDF.
  - The unread badge disappears after opening.
- **Fail:**
  - Nothing appears until you reload → Realtime is not working. Check that `whatsapp_setup.sql` ran without
    errors (it adds the tables to the `supabase_realtime` publication).
  - Messages appear but the photo says "File could not be downloaded" → `WA_DRY_RUN` is not `true`
    (the simulated media id does not exist at Meta).
  - The list is empty even after reload → you are signed in with a login that has no `staff` row.

### 1.3 Live update check

With the conversation list visible, run:

```bash
npm run sim:text -- "Second message" --from 919800000002 --name "Second Customer"
```

- **Pass:** "Second Customer" appears at the top within about a second, without touching the browser.
- **Fail:** it only appears after a reload.

### 1.4 Automated version (optional)

```bash
cd web && npx playwright install chromium && cd ..
npm run test:e2e
```

- **Pass:** `12 passed` (6 tests at desktop width, 6 at phone width). Without `E2E_ADMIN_ID` /
  `E2E_ADMIN_PASSWORD` the two admin tests are skipped: `8 passed, 4 skipped`.
- **Skipped with "End-to-end test skipped: it needs a real Supabase project. Missing: ..."** → fill in the
  values it lists.

---

## Stage 2: reply test with `WA_DRY_RUN=true`

Nothing is sent to Meta. The server does everything else: login check, 24-hour rule, storage, database.

### 2.1 Text reply

Open **Test Customer**, type `Test reply`, press **Send**.

- **Pass:** a green bubble on the right with your text, your staff ID (for example `EMP1001`) at the bottom
  left and the status **Sent**. The text box is empty again.
- **Fail:**
  - Red box "WhatsApp is not configured on the server" → `WA_DRY_RUN` is not `true`.
  - Red box "Not signed in" / "not allowed" → the login is disabled or has no `staff` row.

### 2.2 Delivery statuses

In **Supabase → Table Editor → wa_messages**, copy the `wa_message_id` of your reply
(it starts with `wamid.DRYRUN.`). Then:

```bash
npm run sim:status -- wamid.DRYRUN.xxxxxxxx delivered
npm run sim:status -- wamid.DRYRUN.xxxxxxxx read
```

- **Pass:** the bubble changes to **Delivered**, then to a blue **Read**, without a reload.
- **Fail:** `ignored the event` → the id is wrong, or the message is already further along
  (a message never goes back from Read to Delivered).

### 2.3 Failed message

Send another reply, copy its id, then:

```bash
npm run sim:status -- wamid.DRYRUN.yyyyyyyy failed
```

- **Pass:** the bubble turns red, status **Failed**, with "Not delivered: 131026: Simulated failure from the test harness".

### 2.4 Photo and PDF

1. Press the paperclip, choose a JPEG or PNG under 10 MB, add a caption, **Send**.
2. Press the paperclip, choose a PDF under 10 MB, **Send**.
3. Try a file over 10 MB, and a `.txt` file.

- **Pass:** (1) a bubble with the photo, (2) a bubble with the PDF name and **Download**, (3) a red message
  "This file is larger than 10 MB." / "Only JPEG or PNG photos and PDF files can be sent." and nothing is sent.

### 2.5 The 24-hour rule

```bash
npm run sim:text -- "Old message" --from 919800000003 --name "Old Customer" --hours-ago 25
```

Open **Old Customer**.

- **Pass:** a yellow banner "24-hour window closed", the text box is disabled, and a **Send template**
  button for `hello_world` is shown. Press it: a bubble "Template hello_world" appears with status **Sent**.
  Then run `npm run sim:text -- "I am back" --from 919800000003`: the banner disappears and the text box
  works again, without a reload.
- **Fail:** you can type free text while the banner is shown, or the server accepts free text
  (it must answer "The 24-hour window is closed").

### 2.6 Take chat

Open a conversation and press **Take chat**. Sign in as a second staff member in another browser
(or a private window).

- **Pass:** the header shows "Owner: You (EMP1001)". The other staff member sees the owner's ID on the
  conversation and in the list within a second. **Release** removes it for everyone.

### 2.7 Unread counts are per person

Still with two staff members signed in, send `npm run sim:text -- "Who reads this?"`.

- **Pass:** both see an unread badge. When one opens the chat, only that person's badge disappears.

### 2.8 Admin

Sign in as `ADMIN1`, open **Admin**.

| Action | Pass |
| --- | --- |
| Create `EMP1002` with a password | green "Created EMP1002"; that person can sign in |
| Sign in as `EMP1002` | there is no **Admin** button |
| **Reset password** for `EMP1002` | the old password stops working, the new one works |
| **Disable** `EMP1002` | their open app stops showing data after a reload ("Account not active"); signing in again is refused |
| **Enable** | they can sign in again |

### 2.9 Reload and offline

- Reload the page → **Pass:** you are still signed in.
- Turn Wi-Fi off → **Pass:** a yellow "You are offline" banner, the dot turns red, **Send** is disabled.
  Run `npm run sim:text -- "While offline"` from another network path if you can (or just wait), turn Wi-Fi
  on → the dot turns green (**Live**) and missed messages appear.

---

## Stage 3: real test with your phone

Finish README.md step 8 first (webhook URL, verify token, `messages` field, your number in the "To" list).

Switch dry run off:

```bash
supabase secrets set WA_DRY_RUN=false
```

`WA_TOKEN` from the API Setup page expires after about 24 hours. If replies fail with a token error,
copy a new token and run `supabase secrets set WA_TOKEN=...` again.

### 3.1 Phone → inbox (text)

From your phone, send `hi` in WhatsApp to the Meta test number.

- **Pass:** within a few seconds a conversation with your WhatsApp name and number appears in the web inbox,
  with "hi" and an unread badge. No reload.
- **Fail:**
  - Nothing arrives. In **Supabase → Edge Functions → whatsapp-webhook → Logs**:
    - no request at all → the webhook URL in Meta is wrong, or the `messages` field is not subscribed
    - `401` → `WA_APP_SECRET` is not the App secret of this Meta app
    - `ignored=1` → `WA_PHONE_ID` is not the Phone number ID of the test number

### 3.2 Inbox → phone (text)

Open the conversation, type `Hello from the web inbox`, **Send**.

- **Pass:** the message arrives on your phone. The bubble shows **Sent**, then **Delivered**, then a blue
  **Read** when you open WhatsApp on the phone.
- **Fail:** a red bubble with the reason from WhatsApp. Common reasons:

| Reason | Fix |
| --- | --- |
| `131030 ... not in allowed list` | add your number to the "To" list of the test number |
| `190 ...` / `Error validating access token` | `WA_TOKEN` expired; set a new one |
| `131047` / "24-hour window is closed" | send a new message from the phone first |
| `WhatsApp is not configured on the server` | `WA_TOKEN` or `WA_PHONE_ID` is not set |

### 3.3 Photo, phone → inbox

Send a photo with a caption from your phone.

- **Pass:** the photo and caption appear in the conversation. Clicking the photo opens it.
- **Fail:** "File could not be downloaded" → `WA_TOKEN` is missing or expired. "larger than 10 MB" is expected for big files.

### 3.4 PDF, phone → inbox

Send a PDF from your phone.

- **Pass:** a row with the file name and **Download**; the PDF opens.
- Other file types (Word, zip, audio, video) show "File type not supported" / "Unsupported message type". That is expected.

### 3.5 Photo, inbox → phone

Attach a JPEG or PNG, add a caption, **Send**.

- **Pass:** the photo with caption arrives on your phone; the status moves to **Delivered**.

### 3.6 PDF, inbox → phone

Attach a PDF, **Send**.

- **Pass:** the PDF arrives on your phone with its file name and opens.
- **Fail:** status **Failed** with a media download reason → tell me the reason text shown in the bubble.

### 3.7 Template outside the window (optional)

Wait 24 hours without writing from the phone (or test with a number that never wrote), open the
conversation, press **Send template**.

- **Pass:** the "Hello World" template arrives on the phone.

### 3.8 Duplicate protection (real)

Nothing to do: Meta sometimes delivers the same event twice. **Pass:** you never see the same incoming
message twice in a conversation.

---

## When all three stages pass

The backend is verified for the APK. Leave `WA_DRY_RUN=false`.

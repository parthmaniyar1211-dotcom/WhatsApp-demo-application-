# Test plan

Do the three stages in order. Each stage adds one real component.
Stages 1 and 2 need no phone. Stage 3 (your phone) is in [REAL_TEST_PLAN.md](REAL_TEST_PLAN.md).

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
| Voice note, video, sticker | `npm run sim -- audio` / `video "caption"` / `sticker` | `PASS  ... accepted` |
| Location, contact | `npm run sim -- location "Office"` / `contacts "Ravi"` | `PASS  ... accepted` |
| Document | `npm run sim:document -- "invoice.pdf"` | `PASS  document accepted` |
| Duplicate | `npm run sim:duplicate` | `second delivery recognised as duplicate` and `exactly one row in wa_messages` |

### 1.2 Look at the web inbox (do not reload the page)

- **Pass:**
  - A conversation **Test Customer** appeared by itself, at the top of the list, with a green unread badge.
  - The header shows a green dot and **Live**.
  - Open it: you see the text messages, a green checkered test photo, a `test-document.pdf` card
    ("PDF · 598 B") with a **Download** link, a voice message and a video you can play, a green sticker,
    a location card with "Open in Google Maps" and a contact card.
  - Above the first new message there is a line "N unread messages".
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

- **Pass:** `44 passed` (22 tests at desktop width, 22 at phone width).
- The voice-note test needs `ffprobe` only for an extra check; without it the test still runs.
- **Skipped with "End-to-end test skipped: it needs a real Supabase project. Missing: ..."** → fill in the
  values it lists.

---

## Stage 2: reply test with `WA_DRY_RUN=true`

Nothing is sent to Meta. The server does everything else: login check, 24-hour rule, storage, database.

### 2.1 Text reply

Open **Test Customer**, type `Test reply`, press **Send**.

- **Pass:** a green bubble on the right with your text, your staff ID (for example `EMP1001`) at the bottom
  left and **one grey tick** (hover it: "Sent"). The text box is empty again.
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

- **Pass:** the tick changes to **two grey ticks** (delivered), then to **two blue ticks** (read), without a reload.
- **Fail:** `ignored the event` → the id is wrong, or the message is already further along
  (a message never goes back from Read to Delivered).

### 2.3 Failed message

Send another reply, copy its id, then:

```bash
npm run sim:status -- wamid.DRYRUN.yyyyyyyy failed
```

- **Pass:** the bubble turns red with a red mark instead of ticks, and the text
  "Not delivered: Message could not be delivered. The number may not be on WhatsApp, … (code 131026)".

### 2.4 Photo and PDF

1. Press the paperclip, choose a JPEG or PNG under 5 MB, add a caption, **Send**.
2. Press the paperclip, choose a PDF under 10 MB, **Send**.
3. Try a photo over 5 MB, a PDF over 10 MB, and a `.txt` file.

- **Pass:** (1) a bubble with the photo, (2) a card with the PDF name, size and **Download**, (3) a red message
  "Photos can be at most 5 MB." / "PDF files can be at most 10 MB." /
  "Only JPEG or PNG photos, PDF files, MP4 videos and audio files can be sent." and nothing is sent.

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

### 2.6 Add a contact and start a chat

New chat button (top left) → phone number `98765 43210` → name `Test Person` → **Start chat**.

- **Pass:** the chat opens named "Test Person", with the banner "Send a template message to start" and a
  **Send template** button instead of the text box. After the template is sent, `npm run sim:text -- "Hi" --from 919876543210`
  opens the text box without a reload, and the saved name stays.
- Typing the same number again opens the same chat (no duplicate). A number with fewer than 7 digits is refused.

### 2.7 Password

⋯ menu → **Change password** → enter a new one → "Password changed." Log out, sign in with the new one.

### 2.8 Unread

`npm run sim:text -- "Who reads this?"`

- **Pass:** a green badge on the chat; the **Unread** filter lists it; opening it clears the badge.

### 2.9 Reload and offline

- Reload the page → **Pass:** you are still signed in.
- Turn Wi-Fi off → **Pass:** a yellow "You are offline" banner, the dot turns red, **Send** is disabled.
  Run `npm run sim:text -- "While offline"` from another network path if you can (or just wait), turn Wi-Fi
  on → the dot turns green (**Live**) and missed messages appear.

---

### 2.10 WhatsApp-like features

Use the **Test Customer** chat. `<id>` is the `wa_message_id` of one of your replies
(Supabase → Table Editor → `wa_messages`, it starts with `wamid.DRYRUN.`).

| What | Do this | Pass |
| --- | --- | --- |
| Read at WhatsApp | open a chat with unread messages | `conversations.meta_read_wa_message_id` is filled in (Table Editor). With real WhatsApp the customer sees blue ticks. |
| Reply with quote | hover a customer message → small arrow → **Reply** → type → Send | your bubble shows the quoted text in a grey box |
| Customer quotes you | `npm run sim -- text "This one" --reply-to <id>` | the new bubble shows a quote of your reply with your staff ID |
| Reaction from the customer | `npm run sim -- reaction <id> 👍`, then `npm run sim -- reaction <id>` | 👍 appears under your bubble, then disappears |
| Your reaction | message menu → pick an emoji; click the emoji chip | the emoji appears under the customer's bubble; a click removes it |
| Voice note | microphone button → allow the microphone → speak → **Done** → **Send** | a "Voice message" bubble with a player that plays your recording |
| Played | `npm run sim -- status <id of the voice note> played` | the ticks are blue; hover says "Played" |
| Photo preview | click a photo | it opens large; Escape or **Close** closes it |
| Long chat | run `npm run sim:text -- "Line"` many times, or use the Playwright test | older messages load by themselves when you scroll up; a round arrow button brings you back down and counts new messages |
| Search in a chat | magnifier in the chat header → type a word | matching messages are listed; a click jumps to the message and highlights it |
| Search everywhere | type a word in the sidebar search | a "Messages" section lists matches from all chats |
| Star | message menu → **Star** | a small star on the bubble; the message is listed under the **Starred** tab |
| Delete for me | message menu → **Delete for me** | the message disappears for you only; the notice says WhatsApp does not delete it for the other person; **Undo** brings it back |
| Quick replies | type `/he` in the reply box, press Enter | the saved text is inserted (not sent). ⋯ menu → **Quick replies** lets you add, change and delete them |
| Contact info | ⓘ in the chat header | name, number. Edit the name: it changes in the header and the list and survives a new message |
| API limits | ⓘ → scroll down | a list of what WhatsApp does not allow (online status, editing/deleting, Status, calls) |
| Notification and sound | ⋯ menu → switch on **Desktop notifications**, allow it; open another chat; `npm run sim:text -- "Ping" --from 919800000009` | a sound and a browser notification with the customer's name |
| Emoji | smiley button → pick one | it is inserted where the cursor is |
| Paste / drop | copy a screenshot and press Ctrl+V in the reply box; drag a PDF onto the chat | the file is attached, ready to send |
| Dark mode | ⋯ menu → Theme → **Light** / **Dark** (dark is the default) | the whole app is dark and stays dark after a reload |

---

## Stage 3: real test with your phone

Follow [REAL_TEST_PLAN.md](REAL_TEST_PLAN.md). It starts with `npm run real-check` and then goes through
every case with exact phone steps: text, photo, PDF and voice note both ways, location, reaction,
quoted reply, read ticks, a failed send, and the closed window with the template.

---

## When all three stages pass

The backend is verified for the APK. Leave `WA_DRY_RUN=false`.

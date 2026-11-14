# Real test plan (your phone, real WhatsApp)

Everything in this file needs your real Meta credentials and a phone. None of it could be run by the
engineer; the same flows were tested with simulated webhooks and `WA_DRY_RUN=true` (see TEST_PLAN.md).

You need two things in your hands:

- **The phone**: a WhatsApp account whose number is in the "To" list of the Meta test number.
- **The web app**: http://localhost:5173, signed in as a staff member, with the chat open on screen.

"The business number" below means the Meta test number.

## 0. Before the first message

1. Deploy (README.md steps 2 to 5). There is one new function since the first version: `mark-read`.
2. Secrets: `WA_DRY_RUN=false`, and a fresh `WA_TOKEN` (the token on the API Setup page lasts about 24 hours).
3. Run the live check. It sends no WhatsApp message:

```bash
npm run real-check
```

| Line in the table | If it says FAIL |
| --- | --- |
| Webhook verification (GET, correct token) | 403: `WA_VERIFY_TOKEN` in `~/wa-secrets.env` differs from the Supabase secret. 401: redeploy the webhook with `--no-verify-jwt`. 404: wrong `SUPABASE_URL` or not deployed. |
| Webhook rejects an unsigned POST | 503: `WA_APP_SECRET` is not set in Supabase. |
| Webhook accepts WA_APP_SECRET signature | 401: `WA_APP_SECRET` differs from the Supabase secret. |
| WA_TOKEN is valid and can read WA_PHONE_ID | Code 190: token expired, copy a new one. Code 100 / 33: `WA_PHONE_ID` is not the Phone number ID. |
| Graph API version | Meta answered with another version: `supabase secrets set WA_GRAPH_VERSION=<that version>`. |
| hello_world template / App is subscribed | Only checked when `WA_BUSINESS_ACCOUNT_ID` is set. "no app subscribed" means webhooks will never arrive: finish README step 8. |

**Pass:** `ALL CHECKS PASSED`. Do not continue until it does.

The check cannot see two things: whether the token and phone id stored **in Supabase** are the same as in
`~/wa-secrets.env`, and whether `WA_DRY_RUN` is really `false`. If messages show "Sent" in the web app but
never reach the phone, dry run is still on.

## How to read a failure

- **A red bubble in the web app** shows the reason and Meta's code, for example "(code 131047)".
  The code table is at the end of this file.
- **Nothing arrives in the web app**: Supabase dashboard → Edge Functions → `whatsapp-webhook` → Logs.
  No request at all = Meta is not calling the webhook (URL, verify token, `messages` field not subscribed).
  `ignored=1` = `WA_PHONE_ID` in Supabase is not the Phone number ID of the number you wrote to.

---

## 1. Text, phone → web

**Phone:** send `hi` to the business number.

**Expect in the web app, within about 3 seconds, without reloading:**
- A chat with your WhatsApp profile name and `+<your number>` at the top of the list, bold, with a green "1".
- A short sound (Settings → Sound is on by default).
- Open it: a white bubble on the left with "hi". The badge disappears. The line above the text box says
  "Reply window open: 23 h 59 min left".

**Expect on the phone:** the two grey ticks next to "hi" turn **blue** a moment after you open the chat in
the web app. (That is the `mark-read` function.)

**Fail:** blue ticks never appear → Edge Functions → `mark-read` → Logs. `Meta refused (HTTP 401)` = token.

## 2. Text, web → phone

**Web:** type `Hello from the web inbox`, press Enter.

**Expect on the phone:** "typing…" appears under the business name while you type (it stops after 25
seconds or when the message arrives), then the message arrives.

**Expect in the web app:** a green bubble on the right with your staff ID. The tick goes
one grey tick (sent) → two grey ticks (delivered) → two **blue** ticks when you open the chat on the phone.

**Fail:** red bubble → see the code table.

## 3. Photo, phone → web

**Phone:** send a photo from the gallery with the caption `my photo`.

**Expect:** the photo and the caption in a bubble. Click the photo: it opens large; Escape closes it.

**Fail:** "File could not be downloaded: the WhatsApp access token is invalid or expired" → new `WA_TOKEN`.

## 4. Photo, web → phone

**Web:** paperclip → choose a JPEG or PNG under 5 MB → caption `from web` → Send.
(Also try: paste a screenshot with Ctrl+V, and drag a photo onto the chat. Both attach the file.)

**Expect on the phone:** the photo with the caption. **In the web app:** ticks go to delivered.

**Fail:** status Failed with "(code 131052)" or "(code 131053)" → Meta could not fetch or accept the file.
Set `supabase secrets set WA_MEDIA_MODE=upload` (files are then uploaded to Meta instead of fetched by link)
and send again. Tell the engineer which code you saw.

## 5. PDF, phone → web

**Phone:** attach → Document → pick a PDF.

**Expect:** a card with the file name, "PDF · <size>" and **Download**. The download opens the PDF.
Word, Excel, PowerPoint, text and CSV files are stored too. Other types show "File type not supported".

## 6. PDF, web → phone

**Web:** paperclip → a PDF under 10 MB → Send.

**Expect on the phone:** the PDF with its file name; it opens.

## 7. Voice note, phone → web

**Phone:** hold the microphone, say a few words, release.

**Expect:** a bubble "Voice message" with a player. Press play: you hear the recording.

## 8. Voice note, web → phone

**Web:** click the green microphone (allow the microphone when the browser asks) → speak for a few seconds →
**Done** → listen to the preview if you like → **Send**.

**Expect on the phone:** it arrives as a **voice note** (round play button with a waveform, not a file
attachment). Play it.

**Expect in the web app:** after you play it on the phone, the ticks are blue and their label (hover) is
"Played".

**Fail:**
- Arrives as a plain audio file → you recorded in Safari (it cannot record OGG/Opus). Use Chrome, Edge or Firefox.
- Status Failed with code 131052 / 131053 → set `WA_MEDIA_MODE=upload` as in step 4 and try again.
  This is the one format I could not prove against Meta: the file is verified to be mono OGG/Opus, but only
  Meta can confirm it accepts our signed link for audio.

## 9. Location, phone → web

**Phone:** attach → Location → Send your current location.

**Expect:** a card with a red pin, the place name or address if WhatsApp sent one, the coordinates and
"Open in Google Maps". The link opens the right place.

(A "live location" is not delivered by the Business API. It shows as an unsupported message. That is expected.)

## 10. Reaction, both ways

**Phone:** long-press one of the web app's messages → ❤️.
**Expect in the web app:** ❤️ under that bubble. Change it to 👍 on the phone: it changes. Remove it: it disappears.

**Web:** hover a customer message → the small arrow at its top right → pick 🙏.
**Expect on the phone:** 🙏 on that message. Click the 🙏 chip in the web app: it is removed on the phone too.

## 11. Reply with quote, both ways

**Phone:** swipe right on one of the web app's messages → type `this one` → send.
**Expect in the web app:** the bubble shows a grey quote box with your staff ID and the quoted text.

**Web:** message menu → **Reply** → type `answering that` → Send.
**Expect on the phone:** the message arrives with the quoted message above it.

## 12. Read ticks, both ways (summary of what you saw)

| Direction | Where | Pass |
| --- | --- | --- |
| Customer → business | on the phone | grey ticks turn blue when staff open the chat in the web app |
| Business → customer | in the web app | one grey → two grey → two blue when the chat is opened on the phone |

If "Read receipts" is switched off in the phone's WhatsApp privacy settings, the web app stays at two grey
ticks. That is WhatsApp's behaviour, not a bug.

## 13. Failed send

Pick one:

- **Number not allowed (test numbers only):** remove your number from the "To" list in Meta → API Setup,
  then reply from the web app.
  **Expect:** red bubble, "This number is not in the allowed list of the Meta test number. … (code 131030)".
  Add the number back afterwards.
- **Expired token:** wait until the 24-hour token has expired (or set `WA_TOKEN` to a wrong value), then reply.
  **Expect:** red bubble, "WhatsApp access token has expired or is invalid. An admin must set a new WA_TOKEN. (code 190)".

**Pass:** the bubble is red with a red mark instead of ticks, the reason is readable, and the text box still
works for the next message after you fix the cause.

## 14. Window closed + template

The window closes 24 hours after your **last message from the phone**.

1. Do not write from the phone for 24 hours. There is no shortcut with a real phone.
   (The simulated version takes seconds: TEST_PLAN.md step 2.5.)
2. Open the chat in the web app.

**Expect:** a yellow banner "24-hour window closed", the text box is disabled, a **Send template** button.
The message menu no longer offers Reply or reactions.

3. Press **Send template**.

**Expect on the phone:** the "Hello World" template message.
**Expect in the web app:** a bubble "Template hello_world" with ticks.

4. Answer from the phone.

**Expect in the web app:** the banner disappears and the text box works again, without a reload.

**Fail:** "The template does not exist in this language or is not approved yet. (code 132001)" → the
account has no approved `hello_world` template in `en_US` (check with `WA_BUSINESS_ACCOUNT_ID` set in
`npm run real-check`).

---

## Things that are expected, not bugs

- No "online" or "last seen" for the customer, no Status/Stories, no calls, no editing or deleting of a
  sent message: the WhatsApp Business API does not offer them. The app says so in the customer details panel.
- Polls, live locations, view-once photos and messages the customer deletes arrive as
  "[Message type not supported by the WhatsApp Business API …]".
- A customer who uses a WhatsApp username may appear as "Number hidden by WhatsApp". Replies still work.
- Photos over 5 MB cannot be sent (WhatsApp's limit). Other files: 10 MB from the web app.

## Meta error codes the app explains

| Code | Shown to staff | What to do |
| --- | --- | --- |
| 190 | access token has expired or is invalid | `supabase secrets set WA_TOKEN=<new token>` |
| 131030 | number is not in the allowed list of the Meta test number | add the number under WhatsApp → API Setup |
| 131047 | 24-hour window is closed | send the template, or wait for the customer |
| 132001 | template does not exist in this language or is not approved | approve / fix the template in WhatsApp Manager |
| 132000, 132012 | template variables wrong | fix the template parameters (not used by `hello_world`) |
| 132015, 132016 | template paused / disabled for low quality | edit the template in WhatsApp Manager |
| 131052 | WhatsApp could not download the file | send again; if it repeats, `WA_MEDIA_MODE=upload` |
| 131053 | WhatsApp rejected the file (type or size) | use JPEG/PNG ≤ 5 MB, PDF, MP4, OGG/Opus audio |
| 130429, 80007, 4 | rate limit reached | wait a minute |
| 131056 | too many messages to this customer in a short time | wait a little |
| 131026 | message could not be delivered | the number is not on WhatsApp, or the customer must update WhatsApp |
| 131049 | not delivered to protect the customer from too many business messages | try again in 24 hours |
| 131031 | business account is locked | check Meta Business Manager |
| 131042 | payment problem on the business account | fix billing in Meta |
| 133010 | business phone number is not registered | register the number in WhatsApp Manager |
| any other | Meta's own text with "(code N)" | look the code up on Meta's "WhatsApp error codes" page |

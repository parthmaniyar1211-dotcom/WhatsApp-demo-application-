# Project overview

> Status labels are explained in [README.md](README.md#status-labels-used-in-all-documents).

## What the application does

It is a website that looks and works like **WhatsApp Web**, connected to a real **WhatsApp Business number**.

- Customers write to the business's WhatsApp number from their normal WhatsApp app.
- Those messages appear in the website's chat list within a few seconds, without refreshing.
- The business person types a reply in the website, and the customer receives it in WhatsApp.
- Photos, videos, voice notes and PDF documents can be received and (except voice-note and video details, see
  [MESSAGE_AND_MEDIA_DOCUMENTATION.md](MESSAGE_AND_MEDIA_DOCUMENTATION.md)) sent.
- You can also add a phone number yourself ("New chat") and start a conversation.

Think of it as WhatsApp Web, but for a *business number* run through Meta's official business interface instead of a
personal phone.

## Why it was created

A business wants to answer customers from a computer, on a shared page, without keeping a phone in hand. The project was
built first as a **web test console** to prove that the whole backend works, before building an Android app on the same
backend. The same Supabase project is intended to serve the future Android app.

## Who uses it

| User | Use |
| --- | --- |
| The business owner / person answering customers | Reads and answers WhatsApp messages in the browser. |
| A future team of several people | The database is built for several users (stars and deleted messages are per user); the interface currently has **one login**. |
| A developer | Uses the test tools and documentation to extend it. |

## Main features

| Feature | Status |
| --- | --- |
| Live chat list and conversation view (no refresh needed) | Implemented, tested locally, tested live (messages received) |
| Receive text, photo, video, audio/voice, document, location, contact messages | Implemented, tested locally; text and video **tested live**; the rest not yet tested with a real phone |
| Send text, photo, PDF, video, audio, voice note, template | Implemented, tested locally; text and PDF **tested live** (before the temporary token expired) |
| Delivery ticks (sent, delivered, read, failed with reason) | Implemented, tested locally; "read" observed live |
| Start a chat with any phone number (New chat) | Implemented, tested locally and live (chat creation) |
| Reply to a message (quote), react with emoji | Implemented, tested locally; not tested with real WhatsApp |
| Voice-note recording in the browser | Implemented, tested locally (Chromium) |
| Search (in a chat and across all chats), Starred messages, quick replies, emoji picker, dark/light theme, browser notifications | Implemented, tested locally |
| **Delete for me** (hide a message only in your own view, with Undo) | Implemented, tested locally, tested live |
| **Delete for everyone** | **Unsupported by API** - shown as unavailable with an explanation |
| Single password login, no public sign-up | Implemented, tested live |

## Technology stack (plain version)

| Part | Technology | Plain meaning |
| --- | --- | --- |
| Website | React + TypeScript + Vite | The screens you see. |
| Hosting of the website | GitHub Pages | Free hosting; updates itself when code is pushed. |
| Database, login, files, live updates | Supabase | A hosted back-end service (PostgreSQL database, authentication, file storage, realtime). |
| Server logic | Supabase Edge Functions (Deno) | Small programs that talk to WhatsApp safely. |
| WhatsApp connection | Meta WhatsApp Business Cloud API | Meta's official way for software to send and receive WhatsApp messages. |
| Tests | Playwright, Deno test, SQL tests | Automatic checks. |

## Current project status (as audited)

- The website is live on GitHub Pages and talks to a hosted Supabase project.
- All five Edge Functions are deployed and active; the database has all four migrations applied.
- Meta's webhook is configured and subscribed to `messages`, and the business account is subscribed to the app
  (checked by the `wa-diagnose` function). Real messages have been received and sent through the **Meta test number**.
- **The temporary WhatsApp access token has expired**, so sending to WhatsApp currently fails with Meta error code 190
  until a new token is stored. Receiving still works.

## What has been completed

Everything in the feature table above marked Implemented, plus: database security (row level security), private file
storage with short-lived links, signature-checked webhook, a diagnostics function, automatic deployment of the website,
and about 190 automated test cases across four suites ([TESTING_AND_QA.md](TESTING_AND_QA.md)).

## What is still pending

| Item | Why |
| --- | --- |
| A non-expiring access token (Meta *System User* token) | The current token is temporary and expires about every day. See [WHATSAPP_API_INTEGRATION.md](WHATSAPP_API_INTEGRATION.md). |
| Real-phone tests of photos, voice notes, locations, reactions, quoted replies, template delivery | Only text and video (incoming) and text and PDF (outgoing) were observed live. |
| A real production WhatsApp number | Not started. The project deliberately uses Meta's **test number** for now. |
| Monitoring, alerts, backup verification | None configured. |
| An Android app | Planned; the backend is prepared for it. |

## Current limitations

1. **WhatsApp rules, not bugs:** a business can only *start* a conversation with an approved template message; free
   text is possible for 24 hours after the customer last wrote. A Meta test number can only message up to five
   pre-approved phone numbers.
2. **Delete for everyone does not exist** in the Cloud API. Deleting in this app only hides the message from you.
3. No "online"/"last seen", no Status/Stories, no calls, no editing of sent messages: the Cloud API does not provide them.
4. One login for the whole app (no separate staff accounts in the interface).
5. The temporary token expires daily (see above).
6. Reactions, voice notes, location and quoted replies have only been tested with simulated messages.

See [KNOWN_ISSUES_AND_ROADMAP.md](KNOWN_ISSUES_AND_ROADMAP.md) for the full list and the plan.

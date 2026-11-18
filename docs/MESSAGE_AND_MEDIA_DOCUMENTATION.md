# Message and media documentation

> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). Verified against
> `supabase/functions/send-whatsapp/handler.ts`, `_shared/media.ts`, `whatsapp-webhook/handler.ts` and the live bucket configuration.
> Related: [WEBHOOK_DOCUMENTATION.md](WEBHOOK_DOCUMENTATION.md) · [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md) ·
> [WHATSAPP_API_INTEGRATION.md](WHATSAPP_API_INTEGRATION.md)

## 1. Message types

| Type | Incoming | Outgoing | Notes |
| --- | --- | --- | --- |
| Text | Yes | Yes (<= 4096 chars) | Emoji supported (picker in composer) |
| Image | Yes (JPEG, PNG, WebP) | Yes (JPEG, PNG; <= 5 MB) | Optional caption (<= 1024 chars) |
| Document | Yes (any type in the allowed table) | Yes (**PDF only**; <= 10 MB) | Original filename kept (sanitised) |
| Audio / voice note | Yes (voice flag preserved) | Yes (OGG, MP3, M4A, AAC, AMR; voice notes recorded in the browser) | Voice must be OGG/Opus for Meta |
| Video | Yes (MP4, 3GP) | Yes (MP4; <= 10 MB) | |
| Sticker | Yes (WebP) | No | |
| Location | Yes | No | Shown as a card with a map link |
| Contacts | Yes | No | Shown as contact cards |
| Interactive / button replies | Yes (stored as the chosen text) | No | |
| Template | - | Yes, **only `hello_world` (en_US)** | The only way to start a conversation outside the 24 h window |
| Reaction | Yes (decorates a message) | Yes | One emoji per side per message; sending needs the open window |
| Reply (quote) | Yes (`context.id`) | Yes (`context.message_id`) | The quoted message must belong to the same conversation |
| Forwarded flag | Yes | No | Display only |
| Unsupported / system / other | Yes (stored as a bracketed note) | No | |

## 2. Outgoing text, step by step

```mermaid
sequenceDiagram
  participant UI as Composer
  participant F as send-whatsapp
  participant DB as Postgres
  participant G as Graph API
  UI->>F: POST {conversation_id, text, reply_to?} + user JWT
  F->>F: validate JWT, active staff, input, 24h window, rate limit
  F->>DB: create_outgoing(...) -> row status "sending"
  F->>G: POST /{phone-id}/messages
  alt accepted
    G-->>F: wamid
    F->>DB: row -> status "sent" + wa_message_id
  else error
    G-->>F: error code
    F->>DB: row -> status "failed" + mapped reason
  end
  F-->>UI: {message}
  Note over DB,UI: later statuses arrive through the webhook; Realtime updates the ticks
```

The browser shows the message instantly (optimistic) and reconciles with the row from Realtime. Retrying a failed message sends a new row.

## 3. Incoming file lifecycle

1. Webhook stores the message row (type, caption, mime, filename, voice flag).
2. It checks the mime is allowed for that kind (`incomingAllowed`), then asks Graph for the media URL and downloads it (Bearer `WA_TOKEN`; the URL is short-lived).
3. The size is checked twice (metadata and downloaded bytes) against **16 MiB**; larger files are not stored and the message gets the note "File is larger than 16 MB and was not stored".
4. The file is uploaded as `incoming/<sender wa_id or user id>/<message uuid>.<ext>` (audio/ogg keeps `codecs=opus`), `media_path`/`media_size` are set.
5. On any failure the message stays, with `error` explaining why ("File type not supported", "token invalid or expired", ...). One broken file never fails the webhook.
6. The browser requests a **signed URL (1 h)** for display/download. Files are never public.

## 4. Outgoing file lifecycle

1. The browser validates type/size (images 5 MB, others 10 MB) and uploads to `outgoing/<own user id>/<random>.<ext>` using the user's session. The storage policy forces the folder to be the uploader's own id.
2. It calls `send-whatsapp` with `media_path` (+ optional caption). The function re-validates: the path must be in the caller's own folder, the stored mime/size must match `outgoingRule`, and the conversation window must be open.
3. **Link mode (default, `WA_MEDIA_MODE=link`)**: a **10-minute** signed URL is sent to Meta, which fetches the file. **Upload mode**: the function uploads the file to Meta's `/media` endpoint and sends by media id.
4. The row is saved with the file attached; the sender sees it in the bubble from its own storage copy.
5. Result today: the logic is Tested locally (Deno tests with a fake Graph and the browser suite); real delivery of photos, documents, voice and video to a phone is **not verified live** (token expired; no real-phone session recorded).

## 5. Voice notes

- Recording uses `MediaRecorder` (WebM/Opus in Chrome). Meta accepts OGG/Opus, not WebM, so `web/src/lib/voice.ts` **remuxes** the Opus packets into an OGG container in the browser; no re-encoding.
- The upload sends raw bytes (an `ArrayBuffer`) so the content type `audio/ogg; codecs=opus` is preserved; a `Blob` upload previously lost the codec parameter (fixed).
- Voice playback shows waveform/duration and speed; "played" status is set by Meta when the customer listens.
- Status: Tested locally (browser with a fake microphone and unit tests on the remuxer). Acceptance by Meta and playback on a real phone: **Configured, unverified**.

## 6. Message statuses

| Status | Meaning | Set by |
| --- | --- | --- |
| `received` | incoming message | `ingest_incoming` |
| `sending` | stored, Graph call in progress | `create_outgoing` |
| `sent` | accepted by Meta | `send-whatsapp` |
| `delivered`, `read`, `played` | Meta webhook | `apply_message_status` |
| `failed` | Graph error or Meta delivery failure; the reason is stored and shown | `send-whatsapp` or webhook |

State machine in `apply_message_status`: `sending -> sent -> delivered -> read -> played`; never backwards; `failed` may only replace `sending` or `sent`.
Ticks in the UI: one grey tick = sent, two grey = delivered, two blue = read/played. Real blue ticks from a real phone were seen earlier for text; not re-verified.

## 7. Mark as read

Opening a chat calls `mark_conversation_read` (private per user) and, through `mark-read`, tells Meta the newest incoming message was read
(`status: read`), so the customer sees blue ticks. `conversations.meta_read_wa_message_id` avoids repeat calls. Needs a valid `WA_TOKEN`.

## 8. Search, stars, replies, quick replies

- Search (`search_messages`): case-insensitive match on text and filename, >= 2 chars; excludes messages you deleted for yourself; name/number search is done client-side on the contact list.
- Stars: per-user `message_flags.starred`. Replies: stored as the quoted wamid and rendered as a quote block; clicking jumps to the original.
- Quick replies: shared snippets, typed as `/shortcut` in the composer; managed in Settings.

## 9. Limits summary

| Limit | Value | Enforced in |
| --- | --- | --- |
| Text | 4096 chars | `send-whatsapp` |
| Caption | 1024 chars | `send-whatsapp` |
| Outgoing image | 5 MB | browser + `send-whatsapp` |
| Outgoing doc/audio/video | 10 MB | browser + `send-whatsapp` |
| Stored/incoming file | 16 MiB (bucket limit) | webhook + bucket |
| Request body to `send-whatsapp` | 16 KiB | function |
| Rate | 20 sends / 60 s / user | `send-whatsapp` |
| Window | 24 h from `last_inbound_at` | `send-whatsapp` + UI |
| Webhook body | 1 MiB | webhook |

WhatsApp itself allows larger documents (up to 100 MB) and other types; the app is deliberately stricter and only supports the types listed above.

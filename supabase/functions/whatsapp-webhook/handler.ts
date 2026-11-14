// whatsapp-webhook: receives messages and delivery statuses from Meta.
//
// No Supabase JWT (Meta cannot send one). Instead:
//   GET  -> webhook verification: hub.verify_token must equal WA_VERIFY_TOKEN.
//   POST -> X-Hub-Signature-256 must be a valid HMAC-SHA256 of the raw body with WA_APP_SECRET.
// Both fail closed: if the secret is not configured, the request is rejected.
//
// The handler is built from injected dependencies so it can be tested without Supabase or Meta.

import { HttpError, json, logError, readBody } from "../_shared/http.ts";
import { fetchWithRetry, type FetchFn, graphUrl, type SleepFn } from "../_shared/graph.ts";
import {
  cleanMime,
  extensionFor,
  incomingAllowed,
  MAX_STORED_BYTES,
  type MediaKind,
  safeFilename,
  storedContentType,
} from "../_shared/media.ts";
import {
  base64ToBytes,
  SAMPLE_MP4_BASE64,
  SAMPLE_OGG_BASE64,
  SAMPLE_PDF_BASE64,
  SAMPLE_PNG_BASE64,
  SAMPLE_WEBP_BASE64,
} from "../_shared/samples.ts";
import { staffMessage } from "../_shared/wa_errors.ts";

export interface WebhookEnv {
  verifyToken?: string; // WA_VERIFY_TOKEN
  appSecret?: string; // WA_APP_SECRET
  token?: string; // WA_TOKEN (needed to download incoming media)
  phoneId?: string; // WA_PHONE_ID (when set, events for other numbers are ignored)
  graphVersion: string;
  dryRun: boolean; // WA_DRY_RUN: use sample files instead of downloading media from Meta
}

export type IncomingType =
  | "text"
  | "image"
  | "document"
  | "audio"
  | "video"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "button"
  | "other";

export interface IncomingLocation {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
  url: string | null;
}

export interface IncomingContact {
  name: string;
  phones: string[];
}

export interface IncomingMessage {
  /** Customer phone number (digits). Null when Meta only shares the business-scoped user id. */
  waId: string | null;
  /** Business-scoped user id (BSUID), sent by Meta since 2026. May be null. */
  userId: string | null;
  customerName: string | null;
  waMessageId: string;
  type: IncomingType;
  body: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  mediaVoice: boolean;
  timestamp: string | null; // ISO
  /** wamid of the message the customer replied to (webhook "context.id"). */
  replyTo: string | null;
  forwarded: boolean;
  location: IncomingLocation | null;
  contacts: IncomingContact[] | null;
}

export interface WebhookStore {
  /** Returns the new message id, or null when this wa_message_id is already stored. */
  ingestIncoming(message: IncomingMessage): Promise<string | null>;
  /** Uploads the file and links it to the message. */
  saveMedia(messageId: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  setMessageError(messageId: string, error: string): Promise<void>;
  /** Returns true when a message row changed. */
  applyStatus(waMessageId: string, status: string, error: string | null): Promise<boolean>;
  /** The customer reacted to a message ("" removes the reaction). True when the message exists. */
  applyReaction(waMessageId: string, emoji: string): Promise<boolean>;
}

export interface WebhookDeps {
  env: WebhookEnv;
  store: WebhookStore;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TEXT_LENGTH = 8000;
// "played" is sent when the customer listens to a voice message for the first time.
const STATUSES = new Set(["sent", "delivered", "read", "played", "failed"]);
const MEDIA_TYPES = new Set(["image", "document", "audio", "video", "sticker"]);

export function createWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      if (req.method === "GET") return verifySubscription(req, deps.env);
      if (req.method === "POST") return await receive(req, deps);
      return json({ error: "Method not allowed" }, 405);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      // A 500 makes Meta retry later; duplicates are dropped by wa_message_id.
      logError("whatsapp-webhook failed", err);
      return json({ error: "Internal error" }, 500);
    }
  };
}

// --- GET: subscription verification ---------------------------------------

function verifySubscription(req: Request, env: WebhookEnv): Response {
  const params = new URL(req.url).searchParams;
  const challenge = params.get("hub.challenge");
  const tokenOk = !!env.verifyToken && timingSafeEqual(params.get("hub.verify_token") ?? "", env.verifyToken);
  if (params.get("hub.mode") === "subscribe" && tokenOk && challenge) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return json({ error: "Verification failed" }, 403);
}

// --- POST: events -----------------------------------------------------------

async function receive(req: Request, deps: WebhookDeps): Promise<Response> {
  const { env, store } = deps;
  if (!env.appSecret) {
    // Fail closed. 503 (not 401) so the misconfiguration is visible and Meta retries later.
    console.error("whatsapp-webhook: WA_APP_SECRET is not set; rejecting request");
    return json({ error: "Webhook is not configured" }, 503);
  }

  const raw = await readBody(req, MAX_BODY_BYTES);
  const signature = req.headers.get("x-hub-signature-256");
  if (!(await isValidSignature(raw, signature, env.appSecret))) {
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "Body must be valid JSON" }, 400);
  }

  const result = { ok: true, stored: 0, duplicates: 0, statuses: 0, reactions: 0, ignored: 0 };
  const root = asRecord(payload);
  if (root.object !== "whatsapp_business_account") {
    result.ignored++;
    return json(result);
  }

  for (const entry of asArray(root.entry)) {
    for (const change of asArray(asRecord(entry).changes)) {
      const changeRecord = asRecord(change);
      const value = asRecord(changeRecord.value);
      if (changeRecord.field !== "messages") {
        result.ignored++;
        continue;
      }
      const phoneId = asRecord(value.metadata).phone_number_id;
      if (env.phoneId && phoneId !== env.phoneId) {
        result.ignored++; // event for a different business number
        continue;
      }

      // Account-level problems reported by Meta. Log the code only.
      for (const rawError of asArray(value.errors)) {
        console.error(`whatsapp-webhook: Meta reported error code ${asRecord(rawError).code ?? "unknown"}`);
      }

      // Profile names, by phone number and by business-scoped user id.
      const names = new Map<string, string>();
      for (const contact of asArray(value.contacts)) {
        const c = asRecord(contact);
        const name = asRecord(c.profile).name;
        if (typeof name !== "string") continue;
        if (typeof c.wa_id === "string") names.set(c.wa_id, name.slice(0, 200));
        if (typeof c.user_id === "string") names.set(c.user_id, name.slice(0, 200));
      }

      for (const rawMessage of asArray(value.messages)) {
        const message = asRecord(rawMessage);

        // A reaction is not a message of its own: it decorates an earlier message.
        if (message.type === "reaction") {
          const reaction = asRecord(message.reaction);
          if (typeof reaction.message_id !== "string") {
            result.ignored++;
            continue;
          }
          const emoji = typeof reaction.emoji === "string" ? reaction.emoji : ""; // missing = removed
          if (await store.applyReaction(reaction.message_id, emoji)) result.reactions++;
          else result.ignored++;
          continue;
        }

        const incoming = normalizeMessage(message, names);
        if (!incoming) {
          result.ignored++;
          continue;
        }
        const messageId = await store.ingestIncoming(incoming);
        if (!messageId) {
          result.duplicates++;
          continue;
        }
        result.stored++;
        if (MEDIA_TYPES.has(incoming.type)) {
          await attachMedia(deps, messageId, incoming, asRecord(message[incoming.type]));
        }
      }

      for (const rawStatus of asArray(value.statuses)) {
        const status = asRecord(rawStatus);
        if (typeof status.id !== "string" || typeof status.status !== "string" || !STATUSES.has(status.status)) {
          result.ignored++;
          continue;
        }
        const changed = await store.applyStatus(status.id, status.status, statusError(status));
        if (changed) result.statuses++;
        else result.ignored++;
      }
    }
  }

  console.log(
    `whatsapp-webhook: stored=${result.stored} duplicates=${result.duplicates} statuses=${result.statuses} ` +
      `reactions=${result.reactions} ignored=${result.ignored}`,
  );
  return json(result);
}

const USER_ID = /^[\w.:-]{1,128}$/;

function normalizeMessage(message: Record<string, unknown>, names: Map<string, string>): IncomingMessage | null {
  const id = message.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 255) return null;

  // "from" is the phone number. Since 2026 Meta also sends a business-scoped user id
  // ("from_user_id") and may leave the phone number out for customers who use a username.
  const waId = typeof message.from === "string" && /^\d{5,20}$/.test(message.from) ? message.from : null;
  const rawUserId = message.from_user_id ?? message.user_id;
  const userId = typeof rawUserId === "string" && USER_ID.test(rawUserId) ? rawUserId : null;
  if (!waId && !userId) return null;

  const seconds = Number(message.timestamp);
  const context = asRecord(message.context);
  const base: IncomingMessage = {
    waId,
    userId,
    customerName: (waId && names.get(waId)) || (userId && names.get(userId)) || null,
    waMessageId: id,
    type: "other",
    body: null,
    mediaMime: null,
    mediaFilename: null,
    mediaVoice: false,
    timestamp: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    replyTo: typeof context.id === "string" && context.id.length <= 255 ? context.id : null,
    forwarded: context.forwarded === true || context.frequently_forwarded === true,
    location: null,
    contacts: null,
  };
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, MAX_TEXT_LENGTH) : null);

  switch (message.type) {
    case "text":
      return { ...base, type: "text", body: text(asRecord(message.text).body) ?? "" };

    case "image":
    case "video":
    case "document":
    case "audio":
    case "sticker": {
      const media = asRecord(message[message.type]);
      const mime = cleanMime(typeof media.mime_type === "string" ? media.mime_type : "");
      return {
        ...base,
        type: message.type,
        body: text(media.caption), // audio and stickers have no caption
        mediaMime: mime || null,
        mediaFilename: message.type === "document" ? safeFilename(media.filename, "document") : null,
        mediaVoice: message.type === "audio" && media.voice === true,
      };
    }

    case "location": {
      const location = asRecord(message.location);
      const latitude = Number(location.latitude);
      const longitude = Number(location.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return { ...base, body: "[Location that could not be read]" };
      }
      const name = text(location.name)?.slice(0, 200) ?? null;
      const address = text(location.address)?.slice(0, 300) ?? null;
      const url = typeof location.url === "string" && /^https?:\/\//i.test(location.url) ? location.url.slice(0, 500) : null;
      return {
        ...base,
        type: "location",
        body: name ?? address,
        location: { latitude, longitude, name, address, url },
      };
    }

    case "contacts": {
      const contacts: IncomingContact[] = [];
      for (const raw of asArray(message.contacts).slice(0, 20)) {
        const contact = asRecord(raw);
        const nameRecord = asRecord(contact.name);
        const name = text(nameRecord.formatted_name) ?? text(nameRecord.first_name) ?? "Contact";
        const phones = asArray(contact.phones)
          .map((phone) => asRecord(phone).phone ?? asRecord(phone).wa_id)
          .filter((phone): phone is string => typeof phone === "string")
          .map((phone) => phone.slice(0, 40))
          .slice(0, 5);
        contacts.push({ name: name.slice(0, 120), phones });
      }
      return { ...base, type: "contacts", body: contacts.map((c) => c.name).join(", ").slice(0, 300), contacts };
    }

    case "interactive": {
      // The customer tapped a reply button or picked a list row in one of our interactive messages.
      const interactive = asRecord(message.interactive);
      const reply = asRecord(interactive.button_reply ?? interactive.list_reply);
      return { ...base, type: "interactive", body: text(reply.title) ?? "[Interactive reply]" };
    }

    case "button": {
      // The customer tapped a quick-reply button of a template.
      const button = asRecord(message.button);
      return { ...base, type: "button", body: text(button.text) ?? text(button.payload) ?? "[Button]" };
    }

    case "system":
      // For example "customer changed their phone number".
      return { ...base, body: text(asRecord(message.system).body) ?? "[System message]" };

    default: {
      // "unsupported" (polls, view-once media, deleted messages ...), orders, and anything
      // Meta adds later. Recorded so staff see that the customer sent something.
      const declared = message.type === "unsupported" ? asRecord(message.unsupported).type : message.type;
      const kind = typeof declared === "string" ? declared.replace(/[^a-z_]/gi, "").slice(0, 30) : "";
      return {
        ...base,
        body: kind && kind !== "unsupported" && kind !== "unknown"
          ? `[Unsupported message type: ${kind}]`
          : "[Message type not supported by the WhatsApp Business API. Ask the customer to send it as text, photo or file.]",
      };
    }
  }
}

function statusError(status: Record<string, unknown>): string | null {
  if (status.status !== "failed") return null;
  const first = asRecord(asArray(status.errors)[0]);
  const detail = asRecord(first.error_data).details ?? first.message ?? first.title ?? "Delivery failed";
  return staffMessage(first.code, detail);
}

// --- Incoming media ----------------------------------------------------------

async function attachMedia(
  deps: WebhookDeps,
  messageId: string,
  incoming: IncomingMessage,
  media: Record<string, unknown>,
): Promise<void> {
  const { store } = deps;
  const kind = incoming.type as MediaKind;
  try {
    const mime = incoming.mediaMime ?? "";
    const extension = extensionFor(mime);
    if (!extension || !incomingAllowed(kind, mime)) {
      await store.setMessageError(messageId, `File type not supported: ${mime || "unknown"}`);
      return;
    }
    if (typeof media.id !== "string" || !/^[\w.-]{1,200}$/.test(media.id)) {
      await store.setMessageError(messageId, "File could not be downloaded: missing media id");
      return;
    }
    const bytes = await downloadMedia(deps, media.id, kind);
    if (bytes.byteLength > MAX_STORED_BYTES) {
      await store.setMessageError(messageId, TOO_LARGE);
      return;
    }
    // Phone number when known, otherwise the user id: both are safe path segments.
    const folder = (incoming.waId ?? incoming.userId ?? "unknown").replace(/[^\w.-]/g, "_");
    const path = `incoming/${folder}/${messageId}.${extension}`;
    await store.saveMedia(messageId, path, bytes, storedContentType(mime));
  } catch (err) {
    // The message row is already stored; never fail the whole webhook because of a file.
    logError(`whatsapp-webhook: media for message ${messageId} failed`, err);
    try {
      const reason = err instanceof HttpError ? err.message : "File could not be downloaded";
      await store.setMessageError(messageId, reason);
    } catch (inner) {
      logError("whatsapp-webhook: could not record media error", inner);
    }
  }
}

const TOO_LARGE = "File is larger than 16 MB and was not stored";
const DRY_RUN_SAMPLES: Record<MediaKind, string> = {
  image: SAMPLE_PNG_BASE64,
  document: SAMPLE_PDF_BASE64,
  audio: SAMPLE_OGG_BASE64,
  video: SAMPLE_MP4_BASE64,
  sticker: SAMPLE_WEBP_BASE64,
};

async function downloadMedia(deps: WebhookDeps, mediaId: string, kind: MediaKind): Promise<Uint8Array> {
  const { env } = deps;
  if (env.dryRun) return base64ToBytes(DRY_RUN_SAMPLES[kind]);
  if (!env.token) throw new HttpError(500, "File could not be downloaded: WA_TOKEN is not set");

  const retry = { fetchFn: deps.fetchFn, sleep: deps.sleep };
  const auth = { headers: { Authorization: `Bearer ${env.token}` } };

  // Step 1: ask Graph where the file is. The answer is { url, mime_type, sha256, file_size, id }.
  const metaResponse = await fetchWithRetry(graphUrl(env.graphVersion, mediaId), auth, retry);
  if (!metaResponse.ok) {
    const status = metaResponse.status;
    await metaResponse.body?.cancel();
    throw new HttpError(
      502,
      status === 401 || status === 403
        ? "File could not be downloaded: the WhatsApp access token is invalid or expired"
        : `File could not be downloaded (HTTP ${status})`,
    );
  }
  const meta = asRecord(await metaResponse.json());
  if (Number(meta.file_size) > MAX_STORED_BYTES) throw new HttpError(413, TOO_LARGE);
  if (typeof meta.url !== "string" || !meta.url.startsWith("https://")) {
    throw new HttpError(502, "File could not be downloaded: no download URL");
  }

  // Step 2: download it. The URL is valid for 5 minutes and needs the same bearer token.
  const fileResponse = await fetchWithRetry(meta.url, auth, retry);
  if (!fileResponse.ok) {
    await fileResponse.body?.cancel();
    throw new HttpError(502, `File could not be downloaded (HTTP ${fileResponse.status})`);
  }
  if (Number(fileResponse.headers.get("content-length") ?? "0") > MAX_STORED_BYTES) {
    await fileResponse.body?.cancel();
    throw new HttpError(413, TOO_LARGE);
  }
  return new Uint8Array(await fileResponse.arrayBuffer());
}

// --- Signature ---------------------------------------------------------------

export async function isValidSignature(body: Uint8Array, header: string | null, secret: string): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "");
  if (!match) return false;
  const signature = new Uint8Array(32);
  for (let i = 0; i < 32; i++) signature[i] = parseInt(match[1].slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // crypto.subtle.verify compares in constant time.
  return await crypto.subtle.verify("HMAC", key, signature, body as BufferSource);
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// --- Tiny helpers for walking untrusted JSON ---------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

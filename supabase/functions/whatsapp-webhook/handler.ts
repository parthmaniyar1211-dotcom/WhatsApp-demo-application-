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
import { cleanMime, extensionFor, MAX_FILE_BYTES, safeFilename } from "../_shared/media.ts";
import { base64ToBytes, SAMPLE_PDF_BASE64, SAMPLE_PNG_BASE64 } from "../_shared/samples.ts";

export interface WebhookEnv {
  verifyToken?: string; // WA_VERIFY_TOKEN
  appSecret?: string; // WA_APP_SECRET
  token?: string; // WA_TOKEN (needed to download incoming media)
  phoneId?: string; // WA_PHONE_ID (when set, events for other numbers are ignored)
  graphVersion: string;
  dryRun: boolean; // WA_DRY_RUN: use sample files instead of downloading media from Meta
}

export interface IncomingMessage {
  waId: string;
  customerName: string | null;
  waMessageId: string;
  type: "text" | "image" | "document" | "other";
  body: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  timestamp: string | null; // ISO
}

export interface WebhookStore {
  /** Returns the new message id, or null when this wa_message_id is already stored. */
  ingestIncoming(message: IncomingMessage): Promise<string | null>;
  /** Uploads the file and links it to the message. */
  saveMedia(messageId: string, path: string, bytes: Uint8Array, mime: string): Promise<void>;
  setMessageError(messageId: string, error: string): Promise<void>;
  /** Returns true when a message row changed. */
  applyStatus(waMessageId: string, status: string, error: string | null): Promise<boolean>;
}

export interface WebhookDeps {
  env: WebhookEnv;
  store: WebhookStore;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TEXT_LENGTH = 8000;
const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

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

  const result = { ok: true, stored: 0, duplicates: 0, statuses: 0, ignored: 0 };
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

      const names = new Map<string, string>();
      for (const contact of asArray(value.contacts)) {
        const c = asRecord(contact);
        const name = asRecord(c.profile).name;
        if (typeof c.wa_id === "string" && typeof name === "string") names.set(c.wa_id, name.slice(0, 200));
      }

      for (const rawMessage of asArray(value.messages)) {
        const message = asRecord(rawMessage);
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
        if (incoming.type === "image" || incoming.type === "document") {
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
    `whatsapp-webhook: stored=${result.stored} duplicates=${result.duplicates} statuses=${result.statuses} ignored=${result.ignored}`,
  );
  return json(result);
}

function normalizeMessage(message: Record<string, unknown>, names: Map<string, string>): IncomingMessage | null {
  const from = message.from;
  const id = message.id;
  if (typeof from !== "string" || !/^\d{5,20}$/.test(from)) return null;
  if (typeof id !== "string" || id.length === 0 || id.length > 255) return null;

  const seconds = Number(message.timestamp);
  const base = {
    waId: from,
    customerName: names.get(from) ?? null,
    waMessageId: id,
    timestamp: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    mediaMime: null,
    mediaFilename: null,
  };

  if (message.type === "text") {
    const body = asRecord(message.text).body;
    return { ...base, type: "text", body: typeof body === "string" ? body.slice(0, MAX_TEXT_LENGTH) : "" };
  }
  if (message.type === "image" || message.type === "document") {
    const media = asRecord(message[message.type]);
    const caption = typeof media.caption === "string" ? media.caption.slice(0, MAX_TEXT_LENGTH) : null;
    const mime = cleanMime(typeof media.mime_type === "string" ? media.mime_type : "");
    return {
      ...base,
      type: message.type,
      body: caption,
      mediaMime: mime || null,
      mediaFilename: message.type === "document" ? safeFilename(media.filename, "document") : null,
    };
  }
  // Audio, video, stickers, locations, reactions ... are recorded but not rendered.
  const kind = typeof message.type === "string" ? message.type.replace(/[^a-z_]/gi, "").slice(0, 30) : "unknown";
  return { ...base, type: "other", body: `[Unsupported message type: ${kind}]` };
}

function statusError(status: Record<string, unknown>): string | null {
  if (status.status !== "failed") return null;
  const first = asRecord(asArray(status.errors)[0]);
  const detail = asRecord(first.error_data).details ?? first.message ?? first.title ?? "Delivery failed";
  return `${first.code ?? "error"}: ${detail}`.slice(0, 300);
}

// --- Incoming media ----------------------------------------------------------

async function attachMedia(
  deps: WebhookDeps,
  messageId: string,
  incoming: IncomingMessage,
  media: Record<string, unknown>,
): Promise<void> {
  const { store } = deps;
  try {
    const mime = incoming.mediaMime ?? "";
    const extension = extensionFor(mime);
    if (!extension) {
      await store.setMessageError(messageId, `File type not supported: ${mime || "unknown"}`);
      return;
    }
    if (typeof media.id !== "string" || !/^[\w.-]{1,200}$/.test(media.id)) {
      await store.setMessageError(messageId, "File could not be downloaded: missing media id");
      return;
    }
    const bytes = await downloadMedia(deps, media.id, incoming.type === "image" ? "image" : "document");
    if (bytes.byteLength > MAX_FILE_BYTES) {
      await store.setMessageError(messageId, "File is larger than 10 MB and was not stored");
      return;
    }
    const path = `incoming/${incoming.waId}/${messageId}.${extension}`;
    await store.saveMedia(messageId, path, bytes, mime);
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

async function downloadMedia(deps: WebhookDeps, mediaId: string, kind: "image" | "document"): Promise<Uint8Array> {
  const { env } = deps;
  if (env.dryRun) {
    return base64ToBytes(kind === "image" ? SAMPLE_PNG_BASE64 : SAMPLE_PDF_BASE64);
  }
  if (!env.token) throw new HttpError(500, "File could not be downloaded: WA_TOKEN is not set");

  const retry = { fetchFn: deps.fetchFn, sleep: deps.sleep };
  const auth = { headers: { Authorization: `Bearer ${env.token}` } };

  // Step 1: ask Graph where the file is.
  const metaResponse = await fetchWithRetry(graphUrl(env.graphVersion, mediaId), auth, retry);
  if (!metaResponse.ok) {
    await metaResponse.body?.cancel();
    throw new HttpError(502, `File could not be downloaded (HTTP ${metaResponse.status})`);
  }
  const meta = asRecord(await metaResponse.json());
  if (typeof meta.file_size === "number" && meta.file_size > MAX_FILE_BYTES) {
    throw new HttpError(413, "File is larger than 10 MB and was not stored");
  }
  if (typeof meta.url !== "string" || !meta.url.startsWith("https://")) {
    throw new HttpError(502, "File could not be downloaded: no download URL");
  }

  // Step 2: download it (the URL is short-lived and needs the same token).
  const fileResponse = await fetchWithRetry(meta.url, auth, retry);
  if (!fileResponse.ok) {
    await fileResponse.body?.cancel();
    throw new HttpError(502, `File could not be downloaded (HTTP ${fileResponse.status})`);
  }
  if (Number(fileResponse.headers.get("content-length") ?? "0") > MAX_FILE_BYTES) {
    await fileResponse.body?.cancel();
    throw new HttpError(413, "File is larger than 10 MB and was not stored");
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

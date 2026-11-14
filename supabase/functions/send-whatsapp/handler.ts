// send-whatsapp: staff reply to a customer.
//
// Requires a staff JWT. Enforces:
//   * the caller is an active (not disabled) staff member,
//   * the WhatsApp 24-hour window for free text / files (templates are always allowed),
//   * file rules (JPEG/PNG/PDF, max 10 MB, only from the caller's own upload folder),
//   * a per-user rate limit.
// With WA_DRY_RUN=true no call is made to Meta and a fake message id is returned.
//
// Request body (JSON):
//   { "conversation_id": "<uuid>", "text": "hello" }
//   { "conversation_id": "<uuid>", "media_path": "outgoing/<user id>/<file>", "text": "caption", "filename": "a.pdf" }
//   { "conversation_id": "<uuid>", "template": "hello_world" }
// Response: { "message": <wa_messages row> }  (HTTP 502 with the failed row when Meta rejects it)

import { bearerToken, corsHeaders, HttpError, json, logError, parseJsonObject, readBody } from "../_shared/http.ts";
import { fetchWithRetry, type FetchFn, graphErrorReason, graphUrl, type SleepFn } from "../_shared/graph.ts";
import { cleanMime, MAX_FILE_BYTES, outgoingKind, safeFilename } from "../_shared/media.ts";

export interface SendEnv {
  token?: string; // WA_TOKEN
  phoneId?: string; // WA_PHONE_ID
  graphVersion: string;
  dryRun: boolean; // WA_DRY_RUN
}

export interface StaffRow {
  user_id: string;
  staff_id: string;
  role: string;
  disabled: boolean;
}

export interface ConversationRow {
  id: string;
  wa_id: string;
  last_inbound_at: string | null;
}

export type MessageRow = Record<string, unknown> & { id: string };

export interface NewOutgoing {
  conversationId: string;
  sentBy: string;
  type: "text" | "image" | "document" | "template";
  body: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
}

export interface SendStore {
  /** Returns the user id for a valid access token, otherwise null. */
  getUserId(jwt: string): Promise<string | null>;
  getStaff(userId: string): Promise<StaffRow | null>;
  getConversation(id: string): Promise<ConversationRow | null>;
  countRecentSends(userId: string, sinceIso: string): Promise<number>;
  getFileInfo(path: string): Promise<{ size: number; mime: string } | null>;
  createSignedUrl(path: string, expiresInSeconds: number): Promise<string>;
  createOutgoing(message: NewOutgoing): Promise<MessageRow>;
  finishOutgoing(
    id: string,
    result: { status: "sent" | "failed"; waMessageId?: string; error?: string },
  ): Promise<MessageRow>;
}

export interface SendDeps {
  env: SendEnv;
  store: SendStore;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  now?: () => number;
}

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const RATE_LIMIT_MAX = 20; // messages ...
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // ... per minute, per staff member
export const MAX_TEXT_LENGTH = 4096; // WhatsApp text limit
export const MAX_CAPTION_LENGTH = 1024; // WhatsApp caption limit
const SIGNED_URL_SECONDS = 10 * 60; // long enough for Meta to fetch the file, then it expires
const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Approved templates that may be sent from the console. hello_world exists in every Meta test account.
const TEMPLATES: Record<string, { language: string }> = {
  hello_world: { language: "en_US" },
};

export function createSendHandler(deps: SendDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      return await send(req, deps);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, code: err.code }, err.status, corsHeaders);
      }
      logError("send-whatsapp failed", err);
      return json({ error: "Internal error" }, 500, corsHeaders);
    }
  };
}

async function send(req: Request, deps: SendDeps): Promise<Response> {
  const { env, store } = deps;
  const now = (deps.now ?? Date.now)();

  // 1. Who is calling?
  const jwt = bearerToken(req);
  const userId = jwt ? await store.getUserId(jwt) : null;
  if (!userId) throw new HttpError(401, "Not signed in", "unauthenticated");
  const staff = await store.getStaff(userId);
  if (!staff || staff.disabled) throw new HttpError(403, "This account is not allowed to send messages", "forbidden");

  // 2. What do they want to send?
  const input = parseJsonObject(await readBody(req, MAX_BODY_BYTES));
  const conversationId = input.conversation_id;
  if (typeof conversationId !== "string" || !UUID.test(conversationId)) {
    throw new HttpError(400, "conversation_id must be a UUID", "invalid");
  }
  if (input.text !== undefined && input.text !== null && typeof input.text !== "string") {
    throw new HttpError(400, "text must be a string", "invalid");
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const mediaPath = input.media_path;
  const templateName = input.template;

  let type: NewOutgoing["type"];
  if (templateName !== undefined && templateName !== null) {
    if (typeof templateName !== "string" || !Object.hasOwn(TEMPLATES, templateName)) {
      throw new HttpError(400, "Unknown template", "invalid");
    }
    if (text || mediaPath) throw new HttpError(400, "A template cannot be combined with text or a file", "invalid");
    type = "template";
  } else if (mediaPath !== undefined && mediaPath !== null) {
    // Only files the caller uploaded themselves: outgoing/<their user id>/<file name>
    if (
      typeof mediaPath !== "string" || mediaPath.length > 300 || mediaPath.includes("..") ||
      !mediaPath.startsWith(`outgoing/${userId}/`) || mediaPath.split("/").length !== 3
    ) {
      throw new HttpError(400, "media_path must be a file in your own outgoing folder", "invalid");
    }
    if (text.length > MAX_CAPTION_LENGTH) {
      throw new HttpError(400, `Caption is too long (max ${MAX_CAPTION_LENGTH} characters)`, "invalid");
    }
    type = "image"; // corrected below from the stored file's real type
  } else {
    if (!text) throw new HttpError(400, "Message is empty", "empty");
    if (text.length > MAX_TEXT_LENGTH) {
      throw new HttpError(400, `Message is too long (max ${MAX_TEXT_LENGTH} characters)`, "invalid");
    }
    type = "text";
  }

  // 3. Conversation and the 24-hour window.
  const conversation = await store.getConversation(conversationId);
  if (!conversation) throw new HttpError(404, "Conversation not found", "not_found");
  if (type !== "template" && !isWindowOpen(conversation.last_inbound_at, now)) {
    throw new HttpError(
      409,
      "The 24-hour window is closed. Only a template message can be sent until the customer writes again.",
      "window_closed",
    );
  }

  // 4. Rate limit.
  const recent = await store.countRecentSends(userId, new Date(now - RATE_LIMIT_WINDOW_MS).toISOString());
  if (recent >= RATE_LIMIT_MAX) {
    throw new HttpError(429, "Too many messages. Wait a minute and try again.", "rate_limited");
  }

  // 5. File checks (the bucket enforces the same limits at upload time).
  let mediaMime: string | null = null;
  let mediaFilename: string | null = null;
  if (typeof mediaPath === "string" && type !== "template") {
    const info = await store.getFileInfo(mediaPath);
    if (!info) throw new HttpError(400, "File not found. Upload it again.", "invalid");
    if (info.size > MAX_FILE_BYTES) throw new HttpError(413, "File is larger than 10 MB", "too_large");
    mediaMime = cleanMime(info.mime);
    const kind = outgoingKind(mediaMime);
    if (!kind) throw new HttpError(400, "Only JPEG/PNG images and PDF files can be sent", "invalid");
    type = kind;
    if (kind === "document") mediaFilename = safeFilename(input.filename, "document.pdf");
  }

  if (!env.dryRun && (!env.token || !env.phoneId)) {
    console.error("send-whatsapp: WA_TOKEN or WA_PHONE_ID is not set");
    throw new HttpError(500, "WhatsApp is not configured on the server", "not_configured");
  }

  // 6. Store the message first, so it is visible (as "sending") even if the call to Meta is slow.
  const row = await store.createOutgoing({
    conversationId,
    sentBy: userId,
    type,
    body: type === "template" ? (templateName as string) : text || null,
    mediaPath: type === "image" || type === "document" ? (mediaPath as string) : null,
    mediaMime,
    mediaFilename,
  });

  // 7. Send.
  let outcome: { ok: true; waMessageId: string } | { ok: false; error: string };
  try {
    if (env.dryRun) {
      outcome = { ok: true, waMessageId: `wamid.DRYRUN.${crypto.randomUUID()}` };
    } else {
      const link = row.media_path ? await store.createSignedUrl(row.media_path as string, SIGNED_URL_SECONDS) : null;
      const graphBody = buildGraphBody(conversation.wa_id, type, text, link, mediaFilename, templateName as string);
      outcome = await callGraph(deps, graphBody);
    }
  } catch (err) {
    logError("send-whatsapp: Graph API call failed", err);
    outcome = { ok: false, error: "Could not reach WhatsApp. Try again." };
  }

  console.log(`send-whatsapp: message=${row.id} type=${type} dry_run=${env.dryRun} ok=${outcome.ok}`);
  if (outcome.ok) {
    const saved = await store.finishOutgoing(row.id, { status: "sent", waMessageId: outcome.waMessageId });
    return json({ message: saved, dry_run: env.dryRun }, 200, corsHeaders);
  }
  const failed = await store.finishOutgoing(row.id, { status: "failed", error: outcome.error });
  return json({ error: outcome.error, code: "send_failed", message: failed }, 502, corsHeaders);
}

export function isWindowOpen(lastInboundAt: string | null, now: number): boolean {
  if (!lastInboundAt) return false;
  const last = Date.parse(lastInboundAt);
  return Number.isFinite(last) && now - last < WINDOW_MS;
}

function buildGraphBody(
  to: string,
  type: NewOutgoing["type"],
  text: string,
  link: string | null,
  filename: string | null,
  templateName: string,
): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to, type };
  switch (type) {
    case "text":
      return { ...base, text: { body: text, preview_url: false } };
    case "image":
      return { ...base, image: { link, ...(text ? { caption: text } : {}) } };
    case "document":
      return { ...base, document: { link, filename, ...(text ? { caption: text } : {}) } };
    case "template":
      return { ...base, template: { name: templateName, language: { code: TEMPLATES[templateName].language } } };
  }
}

async function callGraph(
  deps: SendDeps,
  body: Record<string, unknown>,
): Promise<{ ok: true; waMessageId: string } | { ok: false; error: string }> {
  const { env } = deps;
  const response = await fetchWithRetry(
    graphUrl(env.graphVersion, `${env.phoneId}/messages`),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { fetchFn: deps.fetchFn, sleep: deps.sleep },
  );
  if (!response.ok) return { ok: false, error: await graphErrorReason(response) };
  const data = await response.json();
  const id = data?.messages?.[0]?.id;
  if (typeof id !== "string") return { ok: false, error: "WhatsApp did not return a message id" };
  return { ok: true, waMessageId: id };
}

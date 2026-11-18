// send-whatsapp: staff reply to a customer.
//
// Requires a staff JWT. Enforces:
//   * the caller is an active (not disabled) staff member of an active tenant,
//   * the conversation belongs to the caller's tenant (another tenant's chat is "not found"),
//   * the message is sent with the credentials of the conversation's own WhatsApp connection,
//   * the WhatsApp 24-hour window for everything except templates,
//   * file rules (type and size, only from the caller's own upload folder),
//   * a per-user rate limit.
// With WA_DRY_RUN=true no call is made to Meta and a fake message id is returned.
//
// Request body (JSON), one of:
//   { "conversation_id": "<uuid>", "text": "hello", "reply_to": "<message uuid>"? }
//   { "conversation_id": "<uuid>", "media_path": "outgoing/<user id>/<file>", "text": "caption"?,
//     "filename": "a.pdf"?, "voice": true?, "reply_to": "<message uuid>"? }
//   { "conversation_id": "<uuid>", "template": "hello_world" }
//   { "conversation_id": "<uuid>", "reaction": { "message_id": "<message uuid>", "emoji": "👍" } }   ("" removes it)
// Response: { "message": <wa_messages row> }  (HTTP 502 with the failed row when Meta rejects it)

import { bearerToken, corsHeaders, HttpError, json, logError, parseJsonObject, readBody } from "../_shared/http.ts";
import { fetchWithRetry, type FetchFn, graphUrl, type SleepFn } from "../_shared/graph.ts";
import { cleanMime, outgoingRule, safeFilename, storedContentType } from "../_shared/media.ts";
import { staffMessage } from "../_shared/wa_errors.ts";
import { type ConnectionCredentials, type ConnectionStore, requireCredentials } from "../_shared/connections.ts";

export interface SendEnv {
  // The access token and phone number id are NOT here: they belong to the tenant's connection and
  // are resolved per request through SendStore.getCredentials.
  graphVersion: string;
  dryRun: boolean; // WA_DRY_RUN
  mediaMode?: "link" | "upload"; // WA_MEDIA_MODE, default "link"
}

export interface StaffRow {
  user_id: string;
  staff_id: string;
  role: string;
  disabled: boolean;
  /** The caller's active tenant (membership not disabled, tenant active), or null. */
  tenant_id: string | null;
}

export interface ConversationRow {
  id: string;
  tenant_id: string;
  connection_id: string; // the WhatsApp number this chat belongs to
  wa_id: string; // phone number (digits) or business-scoped user id
  last_inbound_at: string | null;
}

export type MessageRow = Record<string, unknown> & { id: string };

export interface MessageRef {
  id: string;
  conversation_id: string;
  wa_message_id: string | null;
}

export type OutgoingType = "text" | "image" | "document" | "audio" | "video" | "template";

export interface NewOutgoing {
  conversationId: string;
  sentBy: string;
  type: OutgoingType;
  body: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  mediaSize: number | null;
  mediaVoice: boolean;
  replyTo: string | null; // wamid of the quoted message
}

export interface SendStore extends ConnectionStore {
  /** Returns the user id for a valid access token, otherwise null. */
  getUserId(jwt: string): Promise<string | null>;
  getStaff(userId: string): Promise<StaffRow | null>;
  getConversation(id: string): Promise<ConversationRow | null>;
  getMessage(id: string): Promise<MessageRef | null>;
  countRecentSends(userId: string, sinceIso: string): Promise<number>;
  getFileInfo(path: string): Promise<{ size: number; mime: string } | null>;
  createSignedUrl(path: string, expiresInSeconds: number): Promise<string>;
  downloadFile(path: string): Promise<Uint8Array>;
  createOutgoing(message: NewOutgoing): Promise<MessageRow>;
  finishOutgoing(
    id: string,
    result: { status: "sent" | "failed"; waMessageId?: string; error?: string },
  ): Promise<MessageRow>;
  /** Stores our reaction on a message (null removes it) and returns the row. */
  setBusinessReaction(messageId: string, emoji: string | null, staffId: string): Promise<MessageRow>;
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
const WINDOW_CLOSED = "The 24-hour window is closed. Only a template message can be sent until the customer writes again.";

// Approved templates that may be sent from the console. hello_world exists in every Meta test account.
const TEMPLATES: Record<string, { language: string }> = {
  hello_world: { language: "en_US" },
};

type Outcome = { ok: true; waMessageId: string } | { ok: false; error: string };

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
  if (!staff || staff.disabled || !staff.tenant_id) {
    throw new HttpError(403, "This account is not allowed to send messages", "forbidden");
  }

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
  const present = (value: unknown) => value !== undefined && value !== null;

  if (present(input.reaction)) {
    if (text || present(mediaPath) || present(templateName) || present(input.reply_to)) {
      throw new HttpError(400, "A reaction cannot be combined with anything else", "invalid");
    }
    return await react(deps, staff, conversationId, input.reaction, now);
  }

  let type: OutgoingType;
  if (present(templateName)) {
    if (typeof templateName !== "string" || !Object.hasOwn(TEMPLATES, templateName)) {
      throw new HttpError(400, "Unknown template", "invalid");
    }
    if (text || present(mediaPath) || present(input.reply_to)) {
      throw new HttpError(400, "A template cannot be combined with text, a file or a reply", "invalid");
    }
    type = "template";
  } else if (present(mediaPath)) {
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
  // Another tenant's conversation is reported exactly like a missing one.
  if (!conversation || conversation.tenant_id !== staff.tenant_id) {
    throw new HttpError(404, "Conversation not found", "not_found");
  }
  if (type !== "template" && !isWindowOpen(conversation.last_inbound_at, now)) {
    throw new HttpError(409, WINDOW_CLOSED, "window_closed");
  }

  // 4. The quoted message, if this is a reply.
  let replyTo: string | null = null;
  if (present(input.reply_to)) {
    replyTo = (await targetMessage(store, input.reply_to, conversationId, "reply_to")).wa_message_id;
  }

  // 5. Rate limit.
  const recent = await store.countRecentSends(userId, new Date(now - RATE_LIMIT_WINDOW_MS).toISOString());
  if (recent >= RATE_LIMIT_MAX) {
    throw new HttpError(429, "Too many messages. Wait a minute and try again.", "rate_limited");
  }

  // 6. File checks (the bucket enforces type and an upper size limit at upload time as well).
  let mediaMime: string | null = null;
  let mediaFilename: string | null = null;
  let mediaSize: number | null = null;
  let mediaVoice = false;
  if (typeof mediaPath === "string" && type !== "template") {
    const info = await store.getFileInfo(mediaPath);
    if (!info) throw new HttpError(400, "File not found. Upload it again.", "invalid");
    mediaMime = cleanMime(info.mime);
    const rule = outgoingRule(mediaMime);
    if (!rule) {
      throw new HttpError(400, "Only JPEG/PNG photos, PDF files, MP4 videos and audio can be sent", "invalid");
    }
    if (info.size > rule.maxBytes) {
      throw new HttpError(413, `File is larger than ${rule.maxBytes / 1024 / 1024} MB`, "too_large");
    }
    type = rule.kind;
    mediaSize = info.size;
    if (type === "audio" && text) throw new HttpError(400, "Audio cannot have a caption", "invalid");
    if (type === "document") mediaFilename = safeFilename(input.filename, "document.pdf");
    // WhatsApp shows OGG/Opus as a voice note (with transcription) when "voice" is set.
    mediaVoice = type === "audio" && mediaMime === "audio/ogg" && input.voice === true;
  }

  // The tenant's own credentials (never a shared token). A dry run needs none.
  const creds = env.dryRun ? null : await requireCredentials(store, conversation.connection_id);

  // 7. Store the message first, so it is visible (as "sending") even if the call to Meta is slow.
  const row = await store.createOutgoing({
    conversationId,
    sentBy: userId,
    type,
    body: type === "template" ? (templateName as string) : text || null,
    mediaPath: mediaMime ? (mediaPath as string) : null,
    mediaMime,
    mediaFilename,
    mediaSize,
    mediaVoice,
    replyTo,
  });

  // 8. Send.
  let outcome: Outcome;
  try {
    if (env.dryRun) {
      outcome = { ok: true, waMessageId: `wamid.DRYRUN.${crypto.randomUUID()}` };
    } else {
      const graphBody: Record<string, unknown> = { ...recipient(conversation.wa_id), type };
      if (replyTo) graphBody.context = { message_id: replyTo };
      if (type === "text") {
        graphBody.text = { body: text, preview_url: false };
      } else if (type === "template") {
        const name = templateName as string;
        graphBody.template = { name, language: { code: TEMPLATES[name].language } };
      } else {
        const media = await mediaReference(deps, creds!, row.media_path as string, mediaMime as string);
        if (!media.ok) throw new GraphFailure(media.error);
        graphBody[type] = {
          ...media.reference,
          ...(text ? { caption: text } : {}),
          ...(type === "document" ? { filename: mediaFilename } : {}),
          ...(mediaVoice ? { voice: true } : {}),
        };
      }
      outcome = await callGraph(deps, creds!, graphBody);
    }
  } catch (err) {
    if (err instanceof GraphFailure) {
      outcome = { ok: false, error: err.message };
    } else {
      logError("send-whatsapp: Graph API call failed", err);
      outcome = { ok: false, error: "Could not reach WhatsApp. Try again." };
    }
  }

  console.log(`send-whatsapp: message=${row.id} type=${type} dry_run=${env.dryRun} ok=${outcome.ok}`);
  if (outcome.ok) {
    const saved = await store.finishOutgoing(row.id, { status: "sent", waMessageId: outcome.waMessageId });
    return json({ message: saved, dry_run: env.dryRun }, 200, corsHeaders);
  }
  const failed = await store.finishOutgoing(row.id, { status: "failed", error: outcome.error });
  return json({ error: outcome.error, code: "send_failed", message: failed }, 502, corsHeaders);
}

/** Reaction to a message of the conversation. Reactions need an open 24-hour window too. */
async function react(
  deps: SendDeps,
  staff: StaffRow,
  conversationId: string,
  rawReaction: unknown,
  now: number,
): Promise<Response> {
  const { env, store } = deps;
  const reaction = typeof rawReaction === "object" && rawReaction !== null
    ? (rawReaction as Record<string, unknown>)
    : {};
  const emoji = reaction.emoji;
  // One emoji (which can be several code points, for example with a skin tone), or "" to remove.
  if (typeof emoji !== "string" || emoji.length > 32 || /[\s\w]/.test(emoji)) {
    throw new HttpError(400, "reaction.emoji must be a single emoji, or empty to remove the reaction", "invalid");
  }
  const conversation = await store.getConversation(conversationId);
  if (!conversation || conversation.tenant_id !== staff.tenant_id) {
    throw new HttpError(404, "Conversation not found", "not_found");
  }
  const target = await targetMessage(store, reaction.message_id, conversationId, "reaction.message_id");
  if (!isWindowOpen(conversation.last_inbound_at, now)) throw new HttpError(409, WINDOW_CLOSED, "window_closed");

  const recent = await store.countRecentSends(staff.user_id, new Date(now - RATE_LIMIT_WINDOW_MS).toISOString());
  if (recent >= RATE_LIMIT_MAX) {
    throw new HttpError(429, "Too many messages. Wait a minute and try again.", "rate_limited");
  }
  const creds = env.dryRun ? null : await requireCredentials(store, conversation.connection_id);

  if (!env.dryRun) {
    let outcome: Outcome;
    try {
      outcome = await callGraph(deps, creds!, {
        ...recipient(conversation.wa_id),
        type: "reaction",
        reaction: { message_id: target.wa_message_id, emoji },
      });
    } catch (err) {
      logError("send-whatsapp: Graph API call failed", err);
      outcome = { ok: false, error: "Could not reach WhatsApp. Try again." };
    }
    if (!outcome.ok) return json({ error: outcome.error, code: "send_failed" }, 502, corsHeaders);
  }
  console.log(`send-whatsapp: reaction on message=${target.id} dry_run=${env.dryRun}`);
  const saved = await store.setBusinessReaction(target.id, emoji || null, staff.staff_id);
  return json({ message: saved, dry_run: env.dryRun }, 200, corsHeaders);
}

/** A message of this conversation that WhatsApp knows (it has a wamid). */
async function targetMessage(
  store: SendStore,
  id: unknown,
  conversationId: string,
  field: string,
): Promise<MessageRef & { wa_message_id: string }> {
  if (typeof id !== "string" || !UUID.test(id)) throw new HttpError(400, `${field} must be a message id`, "invalid");
  const message = await store.getMessage(id);
  if (!message || message.conversation_id !== conversationId) {
    throw new HttpError(404, "That message is not part of this conversation", "not_found");
  }
  if (!message.wa_message_id) {
    throw new HttpError(409, "That message was never delivered to WhatsApp, so it cannot be quoted or reacted to", "invalid");
  }
  return message as MessageRef & { wa_message_id: string };
}

export function isWindowOpen(lastInboundAt: string | null, now: number): boolean {
  if (!lastInboundAt) return false;
  const last = Date.parse(lastInboundAt);
  return Number.isFinite(last) && now - last < WINDOW_MS;
}

/** Phone numbers go in "to". Customers known only by their business-scoped user id go in "recipient". */
function recipient(waId: string): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual" };
  return /^\d+$/.test(waId) ? { ...base, to: waId } : { ...base, recipient: waId };
}

class GraphFailure extends Error {}

/** How the file is handed to Meta: a short-lived signed link (default) or an uploaded media id. */
async function mediaReference(
  deps: SendDeps,
  creds: ConnectionCredentials,
  path: string,
  mime: string,
): Promise<{ ok: true; reference: { link: string } | { id: string } } | { ok: false; error: string }> {
  const { env, store } = deps;
  if (env.mediaMode !== "upload") {
    return { ok: true, reference: { link: await store.createSignedUrl(path, SIGNED_URL_SECONDS) } };
  }
  const bytes = await store.downloadFile(path);
  const contentType = storedContentType(mime);
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", contentType);
  form.set("file", new Blob([bytes as BlobPart], { type: contentType }), path.split("/").pop() ?? "file");
  const response = await fetchWithRetry(
    graphUrl(env.graphVersion, `${creds.phoneId}/media`),
    { method: "POST", headers: { Authorization: `Bearer ${creds.token}` }, body: form },
    { fetchFn: deps.fetchFn, sleep: deps.sleep },
  );
  if (!response.ok) return { ok: false, error: await graphError(response) };
  const id = (await response.json())?.id;
  if (typeof id !== "string") return { ok: false, error: "WhatsApp did not accept the file" };
  return { ok: true, reference: { id } };
}

async function callGraph(deps: SendDeps, creds: ConnectionCredentials, body: Record<string, unknown>): Promise<Outcome> {
  const { env } = deps;
  const response = await fetchWithRetry(
    graphUrl(env.graphVersion, `${creds.phoneId}/messages`),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { fetchFn: deps.fetchFn, sleep: deps.sleep },
  );
  if (!response.ok) return { ok: false, error: await graphError(response) };
  const data = await response.json();
  // Reactions answer with { success: true } on some versions and with a message id on others.
  const id = data?.messages?.[0]?.id;
  if (typeof id !== "string" && body.type !== "reaction") {
    return { ok: false, error: "WhatsApp did not return a message id" };
  }
  return { ok: true, waMessageId: typeof id === "string" ? id : "" };
}

/** Graph API error body: { error: { message, type, code, error_data: { details }, ... } } */
async function graphError(response: Response): Promise<string> {
  try {
    const err = (await response.json())?.error;
    if (err) return staffMessage(err.code, err.error_data?.details ?? err.message);
  } catch {
    // not JSON
  }
  return `WhatsApp API error (HTTP ${response.status})`;
}

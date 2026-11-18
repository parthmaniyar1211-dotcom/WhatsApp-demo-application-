// whatsapp-webhook: receives messages and delivery statuses from Meta.
//
// No Supabase JWT (Meta cannot send one). Instead:
//   GET  -> webhook verification: hub.verify_token must equal WA_VERIFY_TOKEN.
//   POST -> X-Hub-Signature-256 must be a valid HMAC-SHA256 of the raw body with WA_APP_SECRET.
// Both fail closed: if the secret is not configured, the request is rejected.
//
// Multi-tenant routing: every change set carries Meta's phone_number_id (and the WABA id in entry.id).
// They are looked up in whatsapp_connections; the connection decides the tenant, and every write
// carries that connection, so one client's events can never land in another client's inbox.
//
// An event that CANNOT be routed (no phone number id, unknown number, a WABA id that does not match, a
// disconnected connection, a suspended client, or the legacy test number that failed to bind) is never
// silently dropped: it is QUARANTINED (kept for 7 days, readable only by the service role), recorded in the
// routing ledger with a reason and an event id, logged without any customer data, and can be replayed through
// this same code once the cause is fixed (webhook-replay function). If the quarantine cannot be written the
// request fails with 500, so Meta retries and nothing is lost.
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
import type { ConnectionStore } from "../_shared/connections.ts";

export interface WebhookEnv {
  verifyToken?: string; // WA_VERIFY_TOKEN
  appSecret?: string; // WA_APP_SECRET (the one platform app secret)
  /** WA_PHONE_ID: only used to bind the legacy test-number connection to its phone number id. */
  phoneId?: string;
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

/** The connection a webhook change set was routed to. */
export interface RoutedConnection {
  connectionId: string;
  tenantId: string;
  wabaId: string | null;
  status: string;
  tenantActive: boolean;
}

export type QuarantineReason =
  | "no_phone_number_id"
  | "unknown_phone_number_id"
  | "waba_mismatch"
  | "connection_inactive"
  | "tenant_suspended"
  | "legacy_bind_failed";

export interface RoutingEvent {
  eventId: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  field: string;
  connectionId: string | null;
  outcome: "routed" | "unrouted" | "inactive" | "mismatch" | "error";
  reason?: QuarantineReason | "unsupported_field";
  quarantineId?: string | null;
  detail?: string;
}

export interface QuarantineInput {
  eventId: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  field: string;
  reason: QuarantineReason;
  /** The change set exactly as Meta sent it (customer data: the store keeps it server-side only). */
  payload: unknown;
}

export interface QuarantinedChange {
  id: string;
  eventId: string;
  wabaId: string | null;
  field: string;
  payload: unknown;
  attempts: number;
}

export interface WebhookStore extends ConnectionStore {
  /** The connection that owns a Meta phone number id, or null. */
  resolveConnection(phoneNumberId: string): Promise<RoutedConnection | null>;
  /** Binds the legacy test-number connection (global WA_TOKEN) to its phone number id. True when bound now. */
  bindLegacyConnection(phoneNumberId: string, wabaId: string | null): Promise<boolean>;
  /** Routing ledger: outcome and reason only, never message content. */
  recordEvent(event: RoutingEvent): Promise<void>;
  /** Keeps an unroutable change set. Throws when it cannot be kept (the webhook then answers 500). Returns its id. */
  quarantine(change: QuarantineInput): Promise<string>;
  /** Pending quarantined change sets of one Phone Number ID (counts the attempt). */
  claimQuarantine(phoneNumberId: string, limit: number): Promise<QuarantinedChange[]>;
  /** Marks a replay done (the stored payload is erased) or failed. */
  finishQuarantine(id: string, success: boolean, error?: string): Promise<void>;
  /** Deletes expired quarantined payloads and old ledger rows. Optional; best effort. */
  purgeExpired?(): Promise<void>;
  /** Returns the new message id, or null when this wa_message_id is already stored. */
  ingestIncoming(message: IncomingMessage, connectionId: string): Promise<string | null>;
  /** Uploads the file and links it to the message. */
  saveMedia(messageId: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  setMessageError(messageId: string, error: string): Promise<void>;
  /** Returns true when a message row changed. */
  applyStatus(waMessageId: string, status: string, error: string | null, connectionId: string): Promise<boolean>;
  /** The customer reacted to a message ("" removes the reaction). True when the message exists. */
  applyReaction(waMessageId: string, emoji: string, connectionId: string): Promise<boolean>;
}

export interface WebhookDeps {
  env: WebhookEnv;
  store: WebhookStore;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  now?: () => number;
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

interface Tally {
  ok: true;
  stored: number;
  duplicates: number;
  statuses: number;
  reactions: number;
  ignored: number;
  quarantined: number;
}

const newTally = (): Tally => ({ ok: true, stored: 0, duplicates: 0, statuses: 0, reactions: 0, ignored: 0, quarantined: 0 });
const PURGE_EVERY_MS = 60 * 60 * 1000;
let lastPurgeAt = 0;

async function receive(req: Request, deps: WebhookDeps): Promise<Response> {
  const { env } = deps;
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

  const result = newTally();
  const root = asRecord(payload);
  if (root.object !== "whatsapp_business_account") {
    result.ignored++;
    return json(result);
  }

  for (const entry of asArray(root.entry)) {
    for (const change of asArray(asRecord(entry).changes)) {
      await processChange(deps, asRecord(entry).id, asRecord(change), result, { replay: false, eventId: crypto.randomUUID() });
    }
  }

  console.log(
    `whatsapp-webhook: stored=${result.stored} duplicates=${result.duplicates} statuses=${result.statuses} ` +
      `reactions=${result.reactions} ignored=${result.ignored} quarantined=${result.quarantined}`,
  );
  await maybePurge(deps);
  return json(result);
}

/** Retention: quarantined payloads expire after 7 days, ledger rows after 30. Best effort, at most hourly. */
async function maybePurge(deps: WebhookDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  if (!deps.store.purgeExpired || now - lastPurgeAt < PURGE_EVERY_MS) return;
  lastPurgeAt = now;
  try {
    await deps.store.purgeExpired();
  } catch (err) {
    logError("whatsapp-webhook: retention purge failed", err);
  }
}

export interface ProcessOptions {
  /** True when a stored change set is being replayed: an unroutable one stays in quarantine instead of being quarantined again. */
  replay: boolean;
  eventId: string;
}

/** What happened to one change set. */
export type ProcessResult = "processed" | "quarantined" | "still_unroutable" | "ignored";

/**
 * Routes and stores ONE change set (one entry of "changes"). Used by the webhook and by the replay of
 * quarantined events, so both take exactly the same path.
 */
export async function processChange(
  deps: WebhookDeps,
  entryId: unknown,
  changeRecord: Record<string, unknown>,
  result: Tally,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const { store } = deps;
  const value = asRecord(changeRecord.value);
  const phoneId = asRecord(value.metadata).phone_number_id;

  if (changeRecord.field !== "messages") {
    // Not an error and not customer data: a field we do not handle yet (Phase 3 adds the Coexistence ones). Counted and visible.
    result.ignored++;
    await ledger(deps, {
      eventId: options.eventId,
      phoneNumberId: typeof phoneId === "string" ? phoneId : null,
      wabaId: typeof entryId === "string" ? entryId : null,
      field: String(changeRecord.field),
      connectionId: null,
      outcome: "unrouted",
      reason: "unsupported_field",
      detail: "field is not handled",
    });
    return "ignored";
  }

  const routed = await routeChange(deps, phoneId, entryId, changeRecord.field, options.eventId);
  if (!routed.ok) {
    if (options.replay) return "still_unroutable"; // keep it in quarantine; the replayer reports it
    const quarantineId = await store.quarantine({
      eventId: options.eventId,
      phoneNumberId: routed.phoneId,
      wabaId: routed.wabaId,
      field: String(changeRecord.field),
      reason: routed.reason,
      payload: changeRecord,
    }); // throws when it cannot be kept -> 500 -> Meta retries: never lost
    await ledger(deps, {
      eventId: options.eventId,
      phoneNumberId: routed.phoneId,
      wabaId: routed.wabaId,
      field: String(changeRecord.field),
      connectionId: routed.connectionId,
      outcome: routed.outcome,
      reason: routed.reason,
      quarantineId,
      detail: routed.detail,
    });
    logRouting(routed.reason === "legacy_bind_failed" ? "error" : "warn", {
      event_id: options.eventId,
      outcome: "quarantined",
      reason: routed.reason,
      phone_number_id: routed.phoneId,
      connection_id: routed.connectionId,
      field: String(changeRecord.field),
    });
    result.quarantined++;
    return "quarantined";
  }

  const connection = routed.connection;
  const connectionId = connection.connectionId;
  await ledger(deps, {
    eventId: options.eventId,
    phoneNumberId: routed.phoneId,
    wabaId: routed.wabaId,
    field: String(changeRecord.field),
    connectionId,
    outcome: "routed",
  });
  logRouting("info", { event_id: options.eventId, outcome: "routed", connection_id: connectionId, field: String(changeRecord.field), replay: options.replay });

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
      if (await store.applyReaction(reaction.message_id, emoji, connectionId)) result.reactions++;
      else result.ignored++;
      continue;
    }

    const incoming = normalizeMessage(message, names);
    if (!incoming) {
      result.ignored++;
      continue;
    }
    const messageId = await store.ingestIncoming(incoming, connectionId);
    if (!messageId) {
      result.duplicates++;
      continue;
    }
    result.stored++;
    if (MEDIA_TYPES.has(incoming.type)) {
      await attachMedia(deps, messageId, incoming, asRecord(message[incoming.type]), connectionId);
    }
  }

  for (const rawStatus of asArray(value.statuses)) {
    const status = asRecord(rawStatus);
    if (typeof status.id !== "string" || typeof status.status !== "string" || !STATUSES.has(status.status)) {
      result.ignored++;
      continue;
    }
    const changed = await store.applyStatus(status.id, status.status, statusError(status), connectionId);
    if (changed) result.statuses++;
    else result.ignored++;
  }
  return "processed";
}

type RouteFailure = {
  ok: false;
  reason: QuarantineReason;
  outcome: RoutingEvent["outcome"];
  phoneId: string | null;
  wabaId: string | null;
  connectionId: string | null;
  detail: string;
};
type RouteSuccess = { ok: true; connection: RoutedConnection; phoneId: string; wabaId: string | null };

/**
 * Finds the connection for one change set. A failure carries the REASON; the caller quarantines the event.
 * Nothing here ever discards an event.
 */
async function routeChange(
  deps: WebhookDeps,
  rawPhoneId: unknown,
  rawWabaId: unknown,
  _field: unknown,
  _eventId: string,
): Promise<RouteSuccess | RouteFailure> {
  const { store, env } = deps;
  const phoneId = typeof rawPhoneId === "string" && rawPhoneId.length > 0 && rawPhoneId.length <= 64 ? rawPhoneId : null;
  const wabaId = typeof rawWabaId === "string" && rawWabaId.length <= 64 ? rawWabaId : null;
  const fail = (reason: QuarantineReason, outcome: RoutingEvent["outcome"], connectionId: string | null, detail: string): RouteFailure => ({
    ok: false,
    reason,
    outcome,
    phoneId,
    wabaId,
    connectionId,
    detail,
  });

  if (!phoneId) return fail("no_phone_number_id", "unrouted", null, "the change set has no phone_number_id");

  let connection = await store.resolveConnection(phoneId);
  let legacyBindFailed = false;
  // The legacy test number learns its phone number id the first time its own webhook arrives.
  if (!connection && env.phoneId && phoneId === env.phoneId) {
    if (await store.bindLegacyConnection(phoneId, wabaId)) connection = await store.resolveConnection(phoneId);
    else legacyBindFailed = true;
  }
  if (!connection) {
    return legacyBindFailed
      ? fail("legacy_bind_failed", "error", null, "WA_PHONE_ID matches this number but the legacy connection could not be bound")
      : fail("unknown_phone_number_id", "unrouted", null, "no connection has this phone number id");
  }
  if (connection.wabaId && wabaId && connection.wabaId !== wabaId) {
    return fail("waba_mismatch", "mismatch", connection.connectionId, "the WABA id does not match the connection");
  }
  if (!connection.tenantActive) return fail("tenant_suspended", "inactive", connection.connectionId, "the client is suspended");
  if (connection.status === "disconnected" || connection.status === "revoked") {
    return fail("connection_inactive", "inactive", connection.connectionId, `connection ${connection.status}`);
  }
  return { ok: true, connection, phoneId, wabaId };
}

/** The routing ledger must never fail the webhook. */
async function ledger(deps: WebhookDeps, event: RoutingEvent): Promise<void> {
  try {
    await deps.store.recordEvent(event);
  } catch (err) {
    logError("whatsapp-webhook: could not record the routing outcome", err);
  }
}

/**
 * One structured log line per routing decision. It carries ids and a reason, never message text,
 * customer phone numbers, names or payloads.
 */
function logRouting(level: "info" | "warn" | "error", fields: Record<string, unknown>): void {
  const line = JSON.stringify({ evt: "webhook.route", ...fields });
  if (level === "error") console.error(`ALERT ${line}`);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// --- Replay of quarantined events ------------------------------------------------------

export interface ReplaySummary {
  claimed: number;
  replayed: number;
  still_unroutable: number;
  failed: number;
  tally: Omit<Tally, "ok">;
}

/**
 * Feeds the quarantined events of one Phone Number ID back through the normal routing (admin action, after the
 * connection was fixed). An event that is still unroutable stays in quarantine; a processed one has its stored
 * payload erased. Duplicates are harmless (message ids are unique).
 */
export async function replayQuarantined(deps: WebhookDeps, phoneNumberId: string, limit = 100): Promise<ReplaySummary> {
  const rows = await deps.store.claimQuarantine(phoneNumberId, limit);
  const summary: ReplaySummary = {
    claimed: rows.length,
    replayed: 0,
    still_unroutable: 0,
    failed: 0,
    tally: { stored: 0, duplicates: 0, statuses: 0, reactions: 0, ignored: 0, quarantined: 0 },
  };
  for (const row of rows) {
    const tally = newTally();
    try {
      const outcome = await processChange(deps, row.wabaId, asRecord(row.payload), tally, { replay: true, eventId: row.eventId });
      if (outcome === "still_unroutable") {
        summary.still_unroutable++;
        await deps.store.finishQuarantine(row.id, false, "still unroutable");
        continue;
      }
      await deps.store.finishQuarantine(row.id, true);
      summary.replayed++;
      for (const key of Object.keys(summary.tally) as Array<keyof ReplaySummary["tally"]>) summary.tally[key] += tally[key];
    } catch (err) {
      summary.failed++;
      logError("whatsapp-webhook: replay of one quarantined event failed", err);
      try {
        await deps.store.finishQuarantine(row.id, false, err instanceof Error ? err.message.slice(0, 150) : "replay failed");
      } catch { /* the next replay will try again */ }
    }
  }
  return summary;
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
  connectionId: string,
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
    const bytes = await downloadMedia(deps, media.id, kind, connectionId);
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

async function downloadMedia(deps: WebhookDeps, mediaId: string, kind: MediaKind, connectionId: string): Promise<Uint8Array> {
  const { env } = deps;
  if (env.dryRun) return base64ToBytes(DRY_RUN_SAMPLES[kind]);
  // The file is fetched with the token of the connection that received it, never a shared one.
  const lookup = await deps.store.getCredentials(connectionId);
  if (!lookup.ok) throw new HttpError(500, "File could not be downloaded: WhatsApp is not configured for this account");

  const retry = { fetchFn: deps.fetchFn, sleep: deps.sleep };
  const auth = { headers: { Authorization: `Bearer ${lookup.credentials.token}` } };

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

// mark-read: tells WhatsApp that staff have read the customer's messages (the customer
// sees blue ticks) and, optionally, shows the "typing…" indicator to the customer.
//
// Cloud API: POST /<PHONE_NUMBER_ID>/messages
//   { "messaging_product": "whatsapp", "status": "read", "message_id": "<wamid>",
//     "typing_indicator": { "type": "text" } }          <- optional
// Marking one message as read also marks all earlier messages of the chat as read.
// The typing indicator disappears when we send a message or after 25 seconds.
//
// Request body: { "conversation_id": "<uuid>", "typing": true? }
// Response:     { "ok": true, "marked": true|false, "reason"?: "..." }
// This is best effort: a failure at Meta is reported in the response, never as an HTTP error,
// because staff must be able to read a chat even when Meta is unreachable.

import { bearerToken, corsHeaders, HttpError, json, logError, parseJsonObject, readBody } from "../_shared/http.ts";
import { fetchWithRetry, type FetchFn, graphUrl, type SleepFn } from "../_shared/graph.ts";
import { staffMessage } from "../_shared/wa_errors.ts";

export interface MarkReadEnv {
  token?: string;
  phoneId?: string;
  graphVersion: string;
  dryRun: boolean;
}

export interface MarkReadStore {
  getUserId(jwt: string): Promise<string | null>;
  getStaff(userId: string): Promise<{ disabled: boolean } | null>;
  getConversation(id: string): Promise<{ id: string; meta_read_wa_message_id: string | null } | null>;
  /** The newest incoming message of the conversation. */
  getLatestIncoming(conversationId: string): Promise<{ wa_message_id: string | null; created_at: string } | null>;
  /** Remembers which message was last marked as read at Meta. */
  setMetaRead(conversationId: string, waMessageId: string): Promise<void>;
}

export interface MarkReadDeps {
  env: MarkReadEnv;
  store: MarkReadStore;
  fetchFn?: FetchFn;
  sleep?: SleepFn;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000; // Meta: mark as read within 30 days of receipt

export function createMarkReadHandler(deps: MarkReadDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      return json(await markRead(req, deps), 200, corsHeaders);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status, corsHeaders);
      logError("mark-read failed", err);
      return json({ error: "Internal error" }, 500, corsHeaders);
    }
  };
}

async function markRead(req: Request, deps: MarkReadDeps): Promise<Record<string, unknown>> {
  const { env, store } = deps;
  const now = (deps.now ?? Date.now)();

  const jwt = bearerToken(req);
  const userId = jwt ? await store.getUserId(jwt) : null;
  if (!userId) throw new HttpError(401, "Not signed in", "unauthenticated");
  const staff = await store.getStaff(userId);
  if (!staff || staff.disabled) throw new HttpError(403, "This account is not allowed to do this", "forbidden");

  const input = parseJsonObject(await readBody(req, 4096));
  if (typeof input.conversation_id !== "string" || !UUID.test(input.conversation_id)) {
    throw new HttpError(400, "conversation_id must be a UUID", "invalid");
  }
  const typing = input.typing === true;

  const conversation = await store.getConversation(input.conversation_id);
  if (!conversation) throw new HttpError(404, "Conversation not found", "not_found");

  const latest = await store.getLatestIncoming(conversation.id);
  if (!latest?.wa_message_id) return { ok: true, marked: false, reason: "no incoming message" };
  if (now - Date.parse(latest.created_at) > THIRTY_DAYS_MS) {
    return { ok: true, marked: false, reason: "the last incoming message is older than 30 days" };
  }
  // Already marked and no typing indicator wanted: nothing to tell Meta.
  if (!typing && conversation.meta_read_wa_message_id === latest.wa_message_id) {
    return { ok: true, marked: false, reason: "already marked" };
  }

  if (!env.dryRun) {
    if (!env.token || !env.phoneId) return { ok: true, marked: false, reason: "WhatsApp is not configured on the server" };
    try {
      const response = await fetchWithRetry(
        graphUrl(env.graphVersion, `${env.phoneId}/messages`),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${env.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            status: "read",
            message_id: latest.wa_message_id,
            ...(typing ? { typing_indicator: { type: "text" } } : {}),
          }),
        },
        { fetchFn: deps.fetchFn, sleep: deps.sleep, attempts: 2 },
      );
      if (!response.ok) {
        let reason = `WhatsApp API error (HTTP ${response.status})`;
        try {
          const err = (await response.json())?.error;
          if (err) reason = staffMessage(err.code, err.error_data?.details ?? err.message);
        } catch {
          // not JSON
        }
        console.error(`mark-read: Meta refused (HTTP ${response.status})`);
        return { ok: true, marked: false, reason };
      }
      await response.body?.cancel();
    } catch (err) {
      logError("mark-read: Graph API call failed", err);
      return { ok: true, marked: false, reason: "Could not reach WhatsApp" };
    }
  }

  await store.setMetaRead(conversation.id, latest.wa_message_id);
  return { ok: true, marked: true, typing, dry_run: env.dryRun };
}

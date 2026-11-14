// The real implementation of the stores used by the handlers, backed by Supabase
// (service role). Only Edge Functions import this file.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { BUCKET } from "./media.ts";
import type { IncomingMessage, WebhookStore } from "../whatsapp-webhook/handler.ts";
import type { ConversationRow, MessageRow, NewOutgoing, SendStore, StaffRow } from "../send-whatsapp/handler.ts";
import type { AdminStaffRow, AdminStore } from "../admin-staff/handler.ts";

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not available");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Database errors are thrown with code and message only (no row data). */
function check<T>(result: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.code ?? ""} ${result.error.message}`);
  return result.data;
}

async function getUserId(db: SupabaseClient, jwt: string): Promise<string | null> {
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user.id;
}

async function getStaff(db: SupabaseClient, userId: string): Promise<AdminStaffRow | null> {
  return check(
    await db.from("staff").select("user_id, staff_id, display_name, role, disabled").eq("user_id", userId)
      .maybeSingle(),
    "load staff",
  );
}

export function webhookStore(db: SupabaseClient): WebhookStore {
  return {
    async ingestIncoming(m: IncomingMessage) {
      return check(
        await db.rpc("ingest_incoming_message", {
          p_wa_id: m.waId,
          p_customer_name: m.customerName,
          p_wa_message_id: m.waMessageId,
          p_type: m.type,
          p_body: m.body,
          p_media_mime: m.mediaMime,
          p_media_filename: m.mediaFilename,
          p_wa_timestamp: m.timestamp,
        }),
        "store incoming message",
      ) as string | null;
    },
    async saveMedia(messageId, path, bytes, mime) {
      const upload = await db.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
      if (upload.error) throw new Error(`upload file: ${upload.error.message}`);
      check(await db.from("wa_messages").update({ media_path: path }).eq("id", messageId), "link file");
    },
    async setMessageError(messageId, error) {
      check(await db.from("wa_messages").update({ error }).eq("id", messageId), "record file error");
    },
    async applyStatus(waMessageId, status, error) {
      return check(
        await db.rpc("apply_message_status", { p_wa_message_id: waMessageId, p_status: status, p_error: error }),
        "apply status",
      ) as boolean;
    },
  };
}

export function sendStore(db: SupabaseClient): SendStore {
  return {
    getUserId: (jwt) => getUserId(db, jwt),
    getStaff: (userId) => getStaff(db, userId) as Promise<StaffRow | null>,
    async getConversation(id) {
      return check(
        await db.from("conversations").select("id, wa_id, last_inbound_at").eq("id", id).maybeSingle(),
        "load conversation",
      ) as ConversationRow | null;
    },
    async countRecentSends(userId, sinceIso) {
      const { count, error } = await db.from("wa_messages").select("id", { count: "exact", head: true })
        .eq("sent_by", userId).gte("created_at", sinceIso);
      if (error) throw new Error(`count recent sends: ${error.code ?? ""} ${error.message}`);
      return count ?? 0;
    },
    async getFileInfo(path) {
      const { data, error } = await db.storage.from(BUCKET).info(path);
      if (error || !data) return null;
      return { size: data.size ?? Number.MAX_SAFE_INTEGER, mime: data.contentType ?? "" };
    },
    async createSignedUrl(path, expiresInSeconds) {
      const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
      if (error || !data) throw new Error(`sign file url: ${error?.message}`);
      return data.signedUrl;
    },
    async createOutgoing(m: NewOutgoing) {
      return check(
        await db.rpc("create_outgoing_message", {
          p_conversation_id: m.conversationId,
          p_sent_by: m.sentBy,
          p_type: m.type,
          p_body: m.body,
          p_media_path: m.mediaPath,
          p_media_mime: m.mediaMime,
          p_media_filename: m.mediaFilename,
        }),
        "store outgoing message",
      ) as MessageRow;
    },
    async finishOutgoing(id, result) {
      const update = result.status === "sent"
        ? { wa_message_id: result.waMessageId, status: "sent", error: null }
        : { status: "failed", error: result.error };
      return check(
        await db.from("wa_messages").update(update).eq("id", id).select("*").single(),
        "finish message",
      ) as MessageRow;
    },
  };
}

export function adminStore(db: SupabaseClient): AdminStore {
  return {
    getUserId: (jwt) => getUserId(db, jwt),
    getStaff: (userId) => getStaff(db, userId),
    async createAuthUser(email, password) {
      const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) {
        if (error.code === "email_exists" || error.status === 422) return null;
        throw new Error(`create user: ${error.code ?? error.status}`);
      }
      return data.user.id;
    },
    async deleteAuthUser(userId) {
      const { error } = await db.auth.admin.deleteUser(userId);
      if (error) throw new Error(`delete user: ${error.code ?? error.status}`);
    },
    async insertStaff(row) {
      return check(
        await db.from("staff").insert(row).select("user_id, staff_id, display_name, role, disabled").single(),
        "insert staff",
      ) as AdminStaffRow;
    },
    async setDisabled(userId, disabled) {
      return check(
        await db.from("staff").update({ disabled }).eq("user_id", userId)
          .select("user_id, staff_id, display_name, role, disabled").single(),
        "update staff",
      ) as AdminStaffRow;
    },
    async setBanned(userId, banned) {
      const { error } = await db.auth.admin.updateUserById(userId, { ban_duration: banned ? "876000h" : "none" });
      if (error) throw new Error(`ban user: ${error.code ?? error.status}`);
    },
    async setPassword(userId, password) {
      const { error } = await db.auth.admin.updateUserById(userId, { password });
      if (error) {
        throw new Error(`set password: ${error.code ?? error.status}`);
      }
    },
  };
}

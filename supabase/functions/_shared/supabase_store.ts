// The real implementation of the stores used by the handlers, backed by Supabase
// (service role). Only Edge Functions import this file.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { BUCKET } from "./media.ts";
import type {
  IncomingMessage,
  QuarantineInput,
  QuarantinedChange,
  RoutedConnection,
  RoutingEvent,
  WebhookStore,
} from "../whatsapp-webhook/handler.ts";
import type { ConnectionStore, CredentialLookup } from "./connections.ts";
import type {
  ConversationRow,
  MessageRef,
  MessageRow,
  NewOutgoing,
  SendStore,
  StaffRow,
} from "../send-whatsapp/handler.ts";
import type { MarkReadStore } from "../mark-read/handler.ts";
import type { AdminStaffRow, AdminStore, NewAccount } from "../admin-staff/handler.ts";
import type { ConnectionsAdminStore } from "../admin-connections/handler.ts";

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
    await db.from("staff").select("user_id, staff_id, display_name, role, disabled, must_change_password").eq("user_id", userId)
      .maybeSingle(),
    "load staff",
  );
}

/** The tenant a login currently belongs to (membership enabled and tenant active), or null. */
async function getActiveTenantId(db: SupabaseClient, userId: string): Promise<string | null> {
  const row = check(
    await db.from("tenant_memberships").select("tenant_id, tenants!inner(status)").eq("user_id", userId)
      .eq("disabled", false).eq("tenants.status", "active").maybeSingle(),
    "load tenant membership",
  ) as { tenant_id: string } | null;
  return row?.tenant_id ?? null;
}

/** Secrets the legacy test-number connection (credential_source = 'platform_env') still uses. */
export interface LegacyCredentials {
  token?: string; // WA_TOKEN
  phoneId?: string; // WA_PHONE_ID
}

/**
 * Credentials of a connection. Vault connections decrypt their token through the service-role-only
 * function get_connection_token; the legacy connection uses the global secrets. The result is held in
 * memory for the request only.
 */
export function connectionStore(db: SupabaseClient, legacy: LegacyCredentials = {}): ConnectionStore {
  return {
    async getCredentials(connectionId): Promise<CredentialLookup> {
      const conn = check(
        await db.from("whatsapp_connections")
          .select("id, tenant_id, phone_number_id, status, credential_source, tenants!inner(status)")
          .eq("id", connectionId).maybeSingle(),
        "load connection",
      ) as {
        id: string;
        tenant_id: string;
        phone_number_id: string | null;
        status: string;
        credential_source: string;
        tenants: { status: string } | { status: string }[];
      } | null;
      if (!conn) return { ok: false, reason: "not_found" };
      const tenantStatus = Array.isArray(conn.tenants) ? conn.tenants[0]?.status : conn.tenants?.status;
      if (tenantStatus !== "active" || conn.status === "disconnected" || conn.status === "revoked") {
        return { ok: false, reason: "inactive" };
      }
      let token: string | null | undefined;
      let phoneId: string | null | undefined;
      if (conn.credential_source === "platform_env") {
        token = legacy.token;
        phoneId = conn.phone_number_id ?? legacy.phoneId;
      } else {
        token = check(await db.rpc("get_connection_token", { p_connection_id: conn.id }), "read connection token") as
          | string
          | null;
        phoneId = conn.phone_number_id;
      }
      if (!token) return { ok: false, reason: "no_token" };
      if (!phoneId) return { ok: false, reason: "no_phone" };
      return { ok: true, credentials: { connectionId: conn.id, tenantId: conn.tenant_id, phoneId, token } };
    },
  };
}

export function webhookStore(db: SupabaseClient, legacy: LegacyCredentials = {}): WebhookStore {
  return {
    ...connectionStore(db, legacy),
    async resolveConnection(phoneNumberId): Promise<RoutedConnection | null> {
      const rows = check(await db.rpc("resolve_connection", { p_phone_number_id: phoneNumberId }), "resolve connection") as Array<{
        connection_id: string;
        tenant_id: string;
        waba_id: string | null;
        status: string;
        tenant_active: boolean;
      }>;
      const row = rows?.[0];
      if (!row) return null;
      return {
        connectionId: row.connection_id,
        tenantId: row.tenant_id,
        wabaId: row.waba_id,
        status: row.status,
        tenantActive: row.tenant_active,
      };
    },
    async bindLegacyConnection(phoneNumberId, wabaId) {
      const id = check(
        await db.rpc("bind_legacy_connection", { p_phone_number_id: phoneNumberId, p_waba_id: wabaId }),
        "bind legacy connection",
      );
      return id !== null && id !== undefined;
    },
    async recordEvent(e: RoutingEvent) {
      check(
        await db.rpc("record_webhook_event", {
          p_phone_number_id: e.phoneNumberId,
          p_waba_id: e.wabaId,
          p_field: e.field,
          p_connection_id: e.connectionId,
          p_outcome: e.outcome,
          p_detail: e.detail ?? null,
          p_event_id: e.eventId,
          p_reason: e.reason ?? null,
          p_quarantine_id: e.quarantineId ?? null,
        }),
        "record webhook event",
      );
    },
    async quarantine(c: QuarantineInput) {
      return check(
        await db.rpc("quarantine_webhook_change", {
          p_event_id: c.eventId,
          p_phone_number_id: c.phoneNumberId,
          p_waba_id: c.wabaId,
          p_field: c.field,
          p_reason: c.reason,
          p_payload: c.payload,
        }),
        "quarantine webhook change",
      ) as string;
    },
    async claimQuarantine(phoneNumberId: string, limit: number): Promise<QuarantinedChange[]> {
      const rows = check(
        await db.rpc("claim_quarantine", { p_phone_number_id: phoneNumberId, p_limit: limit }),
        "claim quarantine",
      ) as Array<{ id: string; event_id: string; waba_id: string | null; field: string; payload: unknown; replay_attempts: number }>;
      return (rows ?? []).map((r) => ({
        id: r.id,
        eventId: r.event_id,
        wabaId: r.waba_id,
        field: r.field,
        payload: r.payload,
        attempts: r.replay_attempts,
      }));
    },
    async finishQuarantine(id: string, success: boolean, error?: string) {
      check(
        await db.rpc("finish_quarantine_replay", { p_id: id, p_success: success, p_error: error ?? null }),
        "finish quarantine replay",
      );
    },
    async purgeExpired() {
      check(await db.rpc("purge_expired_webhook_data", {}), "purge expired webhook data");
    },
    async ingestIncoming(m: IncomingMessage, connectionId: string) {
      return check(
        await db.rpc("ingest_incoming", {
          p: {
            connection_id: connectionId,
            wa_id: m.waId,
            user_id: m.userId,
            customer_name: m.customerName,
            wa_message_id: m.waMessageId,
            type: m.type,
            body: m.body,
            media_mime: m.mediaMime,
            media_filename: m.mediaFilename,
            media_voice: m.mediaVoice,
            wa_timestamp: m.timestamp,
            reply_to: m.replyTo,
            forwarded: m.forwarded,
            location: m.location,
            contacts: m.contacts,
          },
        }),
        "store incoming message",
      ) as string | null;
    },
    async saveMedia(messageId, path, bytes, contentType) {
      const upload = await db.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
      if (upload.error) throw new Error(`upload file: ${upload.error.message}`);
      check(
        await db.from("wa_messages").update({ media_path: path, media_size: bytes.byteLength }).eq("id", messageId),
        "link file",
      );
    },
    async setMessageError(messageId, error) {
      check(await db.from("wa_messages").update({ error }).eq("id", messageId), "record file error");
    },
    async applyStatus(waMessageId, status, error, connectionId) {
      return check(
        await db.rpc("apply_message_status", {
          p_wa_message_id: waMessageId,
          p_status: status,
          p_error: error,
          p_connection_id: connectionId,
        }),
        "apply status",
      ) as boolean;
    },
    async applyReaction(waMessageId, emoji, connectionId) {
      return check(
        await db.rpc("apply_customer_reaction", { p_wa_message_id: waMessageId, p_emoji: emoji, p_connection_id: connectionId }),
        "apply reaction",
      ) as boolean;
    },
  };
}

export function sendStore(db: SupabaseClient, legacy: LegacyCredentials = {}): SendStore {
  return {
    ...connectionStore(db, legacy),
    getUserId: (jwt) => getUserId(db, jwt),
    async getStaff(userId) {
      const staff = await getStaff(db, userId);
      if (!staff) return null;
      // A login that still has to change its temporary password has no tenant here, exactly as in the database.
      const blocked = staff.disabled || staff.must_change_password;
      return { ...staff, tenant_id: blocked ? null : await getActiveTenantId(db, userId) } as StaffRow;
    },
    async getConversation(id) {
      return check(
        await db.from("conversations").select("id, tenant_id, connection_id, wa_id, last_inbound_at").eq("id", id)
          .maybeSingle(),
        "load conversation",
      ) as ConversationRow | null;
    },
    async getMessage(id) {
      return check(
        await db.from("wa_messages").select("id, conversation_id, wa_message_id").eq("id", id).maybeSingle(),
        "load message",
      ) as MessageRef | null;
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
    async downloadFile(path) {
      const { data, error } = await db.storage.from(BUCKET).download(path);
      if (error || !data) throw new Error(`download file: ${error?.message}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async createOutgoing(m: NewOutgoing) {
      return check(
        await db.rpc("create_outgoing", {
          p: {
            conversation_id: m.conversationId,
            sent_by: m.sentBy,
            type: m.type,
            body: m.body,
            media_path: m.mediaPath,
            media_mime: m.mediaMime,
            media_filename: m.mediaFilename,
            media_size: m.mediaSize,
            media_voice: m.mediaVoice,
            reply_to: m.replyTo,
          },
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
    async setBusinessReaction(messageId, emoji, staffId) {
      return check(
        await db.from("wa_messages")
          .update({ reaction_business: emoji, reaction_business_by: emoji ? staffId : null })
          .eq("id", messageId).select("*").single(),
        "store reaction",
      ) as MessageRow;
    },
  };
}

export function markReadStore(db: SupabaseClient, legacy: LegacyCredentials = {}): MarkReadStore {
  return {
    ...connectionStore(db, legacy),
    getUserId: (jwt) => getUserId(db, jwt),
    async getStaff(userId) {
      const staff = await getStaff(db, userId);
      if (!staff) return null;
      const blocked = staff.disabled || staff.must_change_password;
      return { disabled: staff.disabled, tenant_id: blocked ? null : await getActiveTenantId(db, userId) };
    },
    async getConversation(id) {
      return check(
        await db.from("conversations").select("id, tenant_id, connection_id, meta_read_wa_message_id").eq("id", id)
          .maybeSingle(),
        "load conversation",
      );
    },
    async getLatestIncoming(conversationId) {
      return check(
        await db.from("wa_messages").select("wa_message_id, created_at").eq("conversation_id", conversationId)
          .eq("direction", "in").order("created_at", { ascending: false }).limit(1).maybeSingle(),
        "load latest incoming message",
      );
    },
    async setMetaRead(conversationId, waMessageId) {
      check(
        await db.from("conversations").update({ meta_read_wa_message_id: waMessageId }).eq("id", conversationId),
        "remember read message",
      );
    },
  };
}

export function adminStore(db: SupabaseClient): AdminStore {
  return {
    getUserId: (jwt) => getUserId(db, jwt),
    getStaff: (userId) => getStaff(db, userId),
    async createAuthUser(email, password) {
      // The "must change" rule is NOT a user_metadata flag any more (users can write that): it is public.staff.must_change_password.
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
    async staffIdExists(staffId) {
      const row = check(await db.from("staff").select("user_id").eq("staff_id", staffId).maybeSingle(), "check staff id");
      return row !== null;
    },
    async createAccount(row: NewAccount) {
      return check(
        await db.rpc("create_client_account", {
          p_user_id: row.user_id,
          p_staff_id: row.staff_id,
          p_display_name: row.display_name,
          p_role: row.role,
          p_tenant_id: row.tenant_id,
          p_client_name: row.client_name,
          p_membership_role: row.membership_role,
          p_must_change_password: row.must_change_password,
        }),
        "create account",
      ) as AdminStaffRow & { tenant_id: string | null };
    },
    async getTenantId(userId) {
      const row = check(
        await db.from("tenant_memberships").select("tenant_id").eq("user_id", userId).maybeSingle(),
        "load tenant membership",
      ) as { tenant_id: string } | null;
      return row?.tenant_id ?? null;
    },
    async setDisabled(userId, disabled) {
      return check(
        await db.from("staff").update({ disabled }).eq("user_id", userId)
          .select("user_id, staff_id, display_name, role, disabled, must_change_password").single(),
        "update staff",
      ) as AdminStaffRow;
    },
    async setBanned(userId, banned) {
      const { error } = await db.auth.admin.updateUserById(userId, { ban_duration: banned ? "876000h" : "none" });
      if (error) throw new Error(`ban user: ${error.code ?? error.status}`);
    },
    async setPassword(userId, password, mustChangePassword) {
      // Set the requirement FIRST: from this moment the account cannot read anything, even with a still-valid session.
      if (mustChangePassword) check(await db.rpc("set_must_change_password", { p_user_id: userId, p_value: true }), "set password requirement");
      const { error } = await db.auth.admin.updateUserById(userId, { password });
      if (error) throw new Error(`set password: ${error.code ?? error.status}`);
    },
    async audit(entry) {
      check(
        await db.rpc("write_audit", {
          p_tenant_id: entry.tenantId,
          p_actor_user_id: entry.actorUserId,
          p_action: entry.action,
          p_target: entry.target,
          p_detail: entry.detail ?? {},
        }),
        "write audit log",
      );
    },
  };
}

export function connectionsAdminStore(db: SupabaseClient): ConnectionsAdminStore {
  return {
    getUserId: (jwt) => getUserId(db, jwt),
    getStaff: (userId) => getStaff(db, userId),
    async tenantExists(tenantId) {
      return check(await db.from("tenants").select("id").eq("id", tenantId).maybeSingle(), "load tenant") !== null;
    },
    async getConnection(id) {
      return check(
        await db.from("whatsapp_connections").select("id, tenant_id, credential_source, status, phone_number_id").eq("id", id)
          .maybeSingle(),
        "load connection",
      );
    },
    async createConnection(row) {
      return check(
        await db.from("whatsapp_connections").insert(row)
          .select("id, tenant_id, label, display_phone_number, waba_id, phone_number_id, status, credential_source")
          .single(),
        "create connection",
      ) as Record<string, unknown>;
    },
    async updateConnection(id, patch) {
      return check(
        await db.from("whatsapp_connections").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id)
          .select("id, tenant_id, label, display_phone_number, waba_id, phone_number_id, status, credential_source")
          .single(),
        "update connection",
      ) as Record<string, unknown>;
    },
    async storeToken(connectionId, token, expiresAt) {
      check(
        await db.rpc("store_connection_token", { p_connection_id: connectionId, p_token: token, p_expires_at: expiresAt }),
        "store connection token",
      );
    },
    async revokeToken(connectionId, status) {
      check(await db.rpc("revoke_connection_token", { p_connection_id: connectionId, p_status: status }), "revoke connection token");
    },
    async setState(connectionId, status, error) {
      check(await db.rpc("set_connection_state", { p_connection_id: connectionId, p_status: status, p_error: error }), "set state");
    },
    async audit(entry) {
      check(
        await db.rpc("write_audit", {
          p_tenant_id: entry.tenantId,
          p_actor_user_id: entry.actorUserId,
          p_action: entry.action,
          p_target: entry.target,
          p_detail: entry.detail ?? {},
        }),
        "write audit log",
      );
    },
  };
}

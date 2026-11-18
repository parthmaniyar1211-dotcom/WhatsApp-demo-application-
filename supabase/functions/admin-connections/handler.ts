// admin-connections: platform admin manages the WhatsApp connections of the clients (tenants).
//
// Requires the JWT of an active platform admin. Tokens never come back out of this function: it can store,
// rotate and delete them (Supabase Vault, via service-role-only database functions) but never read one.
//
// Request body (JSON), one of:
//   { "action": "create", "tenant_id": "<uuid>", "label": "Main number", "display_phone_number": "+91 ...",
//     "waba_id": "..."?, "phone_number_id": "..."? }
//   { "action": "update", "connection_id": "<uuid>", "label"?, "display_phone_number"?, "waba_id"?, "phone_number_id"? }
//   { "action": "set_token", "connection_id": "<uuid>", "token": "...", "expires_at": "<ISO date>"? }   (manual entry: disabled unless ALLOW_MANUAL_TOKEN=true)
//   { "action": "disconnect" | "revoke" | "reconnect", "connection_id": "<uuid>" }
//   { "action": "start_onboarding", "tenant_id": "<uuid>" }          (Embedded Signup: behind FEATURE_EMBEDDED_SIGNUP)
//
// Embedded Signup is the intended way to obtain a client's token (the client authorizes their own WhatsApp
// Business account in Meta's flow; the server exchanges the code). It needs an approved Meta Tech Provider
// app, which has NOT been verified, so it stays switched off. Manual token entry exists only for development
// and for the owner's own numbers, is off by default, and is audited (never the token itself).

import { bearerToken, corsHeaders, HttpError, json, logError, parseJsonObject, readBody } from "../_shared/http.ts";
import type { AdminStaffRow, AuditEntry } from "../admin-staff/handler.ts";

export interface ConnectionRecord {
  id: string;
  tenant_id: string;
  credential_source: string;
  status: string;
  phone_number_id: string | null;
}

export interface ConnectionsAdminStore {
  getUserId(jwt: string): Promise<string | null>;
  getStaff(userId: string): Promise<AdminStaffRow | null>;
  tenantExists(tenantId: string): Promise<boolean>;
  getConnection(id: string): Promise<ConnectionRecord | null>;
  createConnection(row: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateConnection(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Vault: create or replace this connection's secret. */
  storeToken(connectionId: string, token: string, expiresAt: string | null): Promise<void>;
  /** Vault: delete this connection's secret and set the status. */
  revokeToken(connectionId: string, status: "disconnected" | "revoked"): Promise<void>;
  setState(connectionId: string, status: string, error: string | null): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface ConnectionsAdminDeps {
  store: ConnectionsAdminStore;
  /** ALLOW_MANUAL_TOKEN=true */
  manualTokens: boolean;
  /** FEATURE_EMBEDDED_SIGNUP=true */
  embeddedSignup: boolean;
}

const MAX_BODY_BYTES = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^[0-9]{5,40}$/;

export function createConnectionsAdminHandler(deps: ConnectionsAdminDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      return await handle(req, deps);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status, corsHeaders);
      logError("admin-connections failed", err);
      return json({ error: "Internal error" }, 500, corsHeaders);
    }
  };
}

async function handle(req: Request, { store, manualTokens, embeddedSignup }: ConnectionsAdminDeps): Promise<Response> {
  const jwt = bearerToken(req);
  const callerId = jwt ? await store.getUserId(jwt) : null;
  if (!callerId) throw new HttpError(401, "Not signed in", "unauthenticated");
  const caller = await store.getStaff(callerId);
  if (!caller || caller.disabled || caller.role !== "admin") throw new HttpError(403, "Admin access required", "forbidden");
  if (caller.must_change_password) {
    throw new HttpError(403, "Choose your own password before using the administration functions", "password_change_required");
  }

  const input = parseJsonObject(await readBody(req, MAX_BODY_BYTES));

  switch (input.action) {
    case "create": {
      const tenantId = uuid(input.tenant_id, "tenant_id");
      if (!(await store.tenantExists(tenantId))) throw new HttpError(404, "Client not found", "not_found");
      const row = {
        tenant_id: tenantId,
        label: text(input.label, 80) ?? "",
        display_phone_number: text(input.display_phone_number, 40),
        waba_id: metaId(input.waba_id, "waba_id"),
        phone_number_id: metaId(input.phone_number_id, "phone_number_id"),
        credential_source: "vault",
        status: "pending",
        onboarding_method: "manual",
      };
      let connection;
      try {
        connection = await store.createConnection(row);
      } catch (err) {
        // unique index on phone_number_id: one number cannot be connected to two clients
        if (String((err as Error).message).includes("23505")) {
          throw new HttpError(409, "That phone number id is already connected to a client", "exists");
        }
        throw err;
      }
      await store.audit({ tenantId, actorUserId: callerId, action: "connection.create", target: String(connection.id) });
      return json({ connection }, 200, corsHeaders);
    }

    case "update": {
      const current = await load(store, input.connection_id);
      const patch: Record<string, unknown> = {};
      if (input.label !== undefined) patch.label = text(input.label, 80) ?? "";
      if (input.display_phone_number !== undefined) patch.display_phone_number = text(input.display_phone_number, 40);
      if (current.credential_source === "vault") {
        // The legacy test number's ids come from its own secrets and are not editable here.
        if (input.waba_id !== undefined) patch.waba_id = metaId(input.waba_id, "waba_id");
        if (input.phone_number_id !== undefined) patch.phone_number_id = metaId(input.phone_number_id, "phone_number_id");
      } else if (input.waba_id !== undefined || input.phone_number_id !== undefined) {
        throw new HttpError(400, "The legacy test number's ids cannot be edited", "invalid");
      }
      if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to update", "invalid");
      let connection;
      try {
        connection = await store.updateConnection(current.id, patch);
      } catch (err) {
        if (String((err as Error).message).includes("23505")) {
          throw new HttpError(409, "That phone number id is already connected to a client", "exists");
        }
        throw err;
      }
      await store.audit({
        tenantId: current.tenant_id,
        actorUserId: callerId,
        action: "connection.update",
        target: current.id,
        detail: { fields: Object.keys(patch) },
      });
      return json({ connection }, 200, corsHeaders);
    }

    case "set_token": {
      if (!manualTokens) {
        throw new HttpError(
          403,
          "Manual token entry is disabled. Tokens are obtained through Meta Embedded Signup.",
          "feature_disabled",
        );
      }
      const current = await load(store, input.connection_id);
      if (current.credential_source !== "vault") {
        throw new HttpError(400, "The legacy test number uses the platform secret, not a stored token", "invalid");
      }
      const token = typeof input.token === "string" ? input.token.trim() : "";
      if (token.length < 20 || token.length > 2048 || /\s/.test(token)) {
        throw new HttpError(400, "That does not look like an access token", "invalid");
      }
      let expiresAt: string | null = null;
      if (input.expires_at !== undefined && input.expires_at !== null) {
        const time = typeof input.expires_at === "string" ? Date.parse(input.expires_at) : NaN;
        if (!Number.isFinite(time) || time < Date.now()) throw new HttpError(400, "expires_at must be a future date", "invalid");
        expiresAt = new Date(time).toISOString();
      }
      const firstToken = current.status === "pending"; // decided before any change
      await store.storeToken(current.id, token, expiresAt);
      // Usable only when the number is known as well.
      await store.setState(current.id, current.phone_number_id ? "connected" : "pending", null);
      await store.audit({
        tenantId: current.tenant_id,
        actorUserId: callerId,
        action: firstToken ? "connection.token_set" : "connection.token_rotated",
        target: current.id,
        detail: { expires_at: expiresAt },
      });
      return json({ ok: true, status: current.phone_number_id ? "connected" : "pending" }, 200, corsHeaders);
    }

    case "disconnect": {
      const current = await load(store, input.connection_id);
      if (current.credential_source === "vault") await store.revokeToken(current.id, "disconnected");
      else await store.setState(current.id, "disconnected", null);
      await store.audit({ tenantId: current.tenant_id, actorUserId: callerId, action: "connection.disconnect", target: current.id });
      return json({ ok: true, status: "disconnected" }, 200, corsHeaders);
    }

    case "revoke": {
      const current = await load(store, input.connection_id);
      if (current.credential_source !== "vault") {
        throw new HttpError(
          400,
          "The legacy test number uses the platform secret WA_TOKEN. Remove or replace that secret in Supabase.",
          "invalid",
        );
      }
      await store.revokeToken(current.id, "revoked");
      await store.audit({ tenantId: current.tenant_id, actorUserId: callerId, action: "connection.revoke", target: current.id });
      return json({ ok: true, status: "revoked" }, 200, corsHeaders);
    }

    case "reconnect": {
      const current = await load(store, input.connection_id);
      if (current.status !== "disconnected" && current.status !== "error") {
        throw new HttpError(409, "Only a disconnected connection can be reconnected", "invalid");
      }
      // A Vault connection needs a new token (set_token or onboarding) before it is usable again.
      const status = current.credential_source === "platform_env" ? "connected" : "pending";
      await store.setState(current.id, status, null);
      await store.audit({ tenantId: current.tenant_id, actorUserId: callerId, action: "connection.reconnect", target: current.id });
      return json({ ok: true, status }, 200, corsHeaders);
    }

    case "start_onboarding": {
      uuid(input.tenant_id, "tenant_id");
      if (!embeddedSignup) {
        throw new HttpError(
          403,
          "Embedded Signup is not enabled. It needs an approved Meta Tech Provider app (not verified yet).",
          "feature_disabled",
        );
      }
      throw new HttpError(501, "Embedded Signup is not implemented in this version", "not_implemented");
    }

    default:
      throw new HttpError(400, "Unknown action", "invalid");
  }
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new HttpError(400, `${field} must be a UUID`, "invalid");
  return value;
}

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "Text fields must be strings", "invalid");
  const trimmed = value.trim().slice(0, max);
  return trimmed === "" ? null : trimmed;
}

function metaId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !META_ID.test(value.trim())) {
    throw new HttpError(400, `${field} must be the numeric id shown in Meta Business settings`, "invalid");
  }
  return value.trim();
}

async function load(store: ConnectionsAdminStore, id: unknown): Promise<ConnectionRecord> {
  const connection = await store.getConnection(uuid(id, "connection_id"));
  if (!connection) throw new HttpError(404, "Connection not found", "not_found");
  return connection;
}

// admin-staff: create client (staff) accounts, disable/enable them and reset passwords.
//
// Requires the JWT of an active PLATFORM ADMIN (staff.role = "admin"). This is the only place logins are
// created (public signup is off), and it runs with the service role on the server, so that key never
// reaches the web app or the APK.
//
// Every client gets a login that belongs to exactly one tenant. Creating a client creates its tenant in the
// same database transaction as its staff row and membership (create_client_account), so there is never a
// login without a tenant, or a tenant without an owner.
//
// Passwords: when the admin does not choose one, a random temporary password is generated and returned ONCE
// in the response. Either way the account is created with public.staff.must_change_password = true, which the
// DATABASE enforces: until the login completes complete-password-change it can read and do nothing (see
// supabase/migrations/20261119000000_password_change_enforcement.sql). Passwords never go to logs or to the audit log.
//
// Request body (JSON), one of:
//   { "action": "create", "client_name": "Acme Traders", "display_name": "Asha", "staff_id": "ACME01"?, "password": "..."? }
//   { "action": "create", "tenant_id": "<uuid>", "display_name": "Ravi" }            (another login of an existing client)
//   { "action": "create", "role": "admin", "staff_id": "OPS1" }                       (a platform admin, no tenant)
//   { "action": "set_disabled", "user_id": "<uuid>", "disabled": true }
//   { "action": "reset_password", "user_id": "<uuid>", "password": "..."? }

import { bearerToken, corsHeaders, HttpError, json, logError, parseJsonObject, readBody } from "../_shared/http.ts";

export interface AdminStaffRow {
  user_id: string;
  staff_id: string;
  display_name: string;
  role: string;
  disabled: boolean;
  /** True while the login still has an administrator-issued temporary password. */
  must_change_password: boolean;
}

export interface NewAccount {
  user_id: string;
  staff_id: string;
  display_name: string;
  role: "staff" | "admin";
  tenant_id: string | null;
  client_name: string | null;
  membership_role: "owner" | "agent";
  /** Always true for accounts created here: the first login must choose its own password. */
  must_change_password: boolean;
}

export interface AuditEntry {
  tenantId: string | null;
  actorUserId: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export interface AdminStore {
  getUserId(jwt: string): Promise<string | null>;
  getStaff(userId: string): Promise<AdminStaffRow | null>;
  /** Creates the auth user (email already confirmed). Returns its id, or null if the email is taken. */
  createAuthUser(email: string, password: string): Promise<string | null>;
  deleteAuthUser(userId: string): Promise<void>;
  staffIdExists(staffId: string): Promise<boolean>;
  /** Staff row + tenant (new or existing) + membership in one transaction. */
  createAccount(row: NewAccount): Promise<AdminStaffRow & { tenant_id: string | null }>;
  getTenantId(userId: string): Promise<string | null>;
  setDisabled(userId: string, disabled: boolean): Promise<AdminStaffRow>;
  /** Banned users cannot sign in or refresh their session. */
  setBanned(userId: string, banned: boolean): Promise<void>;
  /** Sets the password. With mustChangePassword the database requirement is set FIRST, so the account is locked out at once. */
  setPassword(userId: string, password: string, mustChangePassword: boolean): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface AdminDeps {
  store: AdminStore;
  emailDomain: string; // "company.demo": staff id EMP1001 logs in as emp1001@company.demo
  /** Injectable for tests. */
  randomBytes?: (n: number) => Uint8Array;
}

const MAX_BODY_BYTES = 8 * 1024;
const STAFF_ID = /^[A-Z0-9]{3,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// No 0/O/1/I/l, so a temporary password can be read out over the phone.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const defaultRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function generateFrom(alphabet: string, length: number, random: (n: number) => Uint8Array): string {
  // Rejection sampling: no modulo bias.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of random(length * 2)) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export function createAdminHandler(deps: AdminDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      return await handle(req, deps);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status, corsHeaders);
      logError("admin-staff failed", err);
      return json({ error: "Internal error" }, 500, corsHeaders);
    }
  };
}

async function handle(req: Request, { store, emailDomain, randomBytes }: AdminDeps): Promise<Response> {
  const random = randomBytes ?? defaultRandom;
  const jwt = bearerToken(req);
  const callerId = jwt ? await store.getUserId(jwt) : null;
  if (!callerId) throw new HttpError(401, "Not signed in", "unauthenticated");
  const caller = await store.getStaff(callerId);
  if (!caller || caller.disabled || caller.role !== "admin") {
    throw new HttpError(403, "Admin access required", "forbidden");
  }
  if (caller.must_change_password) {
    throw new HttpError(403, "Choose your own password before using the administration functions", "password_change_required");
  }

  const input = parseJsonObject(await readBody(req, MAX_BODY_BYTES));

  switch (input.action) {
    case "create": {
      const role = input.role === undefined || input.role === null ? "staff" : input.role;
      if (role !== "staff" && role !== "admin") throw new HttpError(400, "Role must be staff or admin", "invalid");
      const displayName = typeof input.display_name === "string" ? input.display_name.trim().slice(0, 80) : "";

      // Which tenant? A client account either creates its tenant or joins an existing one. Never both.
      const tenantId = input.tenant_id === undefined || input.tenant_id === null ? null : input.tenant_id;
      if (tenantId !== null && (typeof tenantId !== "string" || !UUID.test(tenantId))) {
        throw new HttpError(400, "tenant_id must be a UUID", "invalid");
      }
      const clientName = typeof input.client_name === "string" ? input.client_name.trim().slice(0, 120) : "";
      if (tenantId && clientName) {
        throw new HttpError(400, "Give either tenant_id or client_name, not both", "invalid");
      }
      if (role === "staff" && !tenantId && !clientName) {
        throw new HttpError(400, "A client name (new client) or tenant_id (existing client) is required", "invalid");
      }

      // Staff ID: chosen by the admin, or generated and checked for uniqueness.
      let staffId = typeof input.staff_id === "string" ? input.staff_id.trim().toUpperCase() : "";
      if (staffId) {
        if (!STAFF_ID.test(staffId)) {
          throw new HttpError(400, "Staff ID must be 3-20 letters or digits, for example EMP1001", "invalid");
        }
      } else {
        for (let attempt = 0; attempt < 10 && !staffId; attempt++) {
          const candidate = "CC" + generateFrom(ID_ALPHABET, 6, random);
          if (!(await store.staffIdExists(candidate))) staffId = candidate;
        }
        if (!staffId) throw new HttpError(500, "Could not generate a unique Staff ID", "internal");
      }

      const supplied = input.password !== undefined && input.password !== null;
      const password = supplied ? validPassword(input.password) : generateFrom(PASSWORD_ALPHABET, 16, random);

      const userId = await store.createAuthUser(`${staffId.toLowerCase()}@${emailDomain}`, password);
      if (!userId) throw new HttpError(409, `Staff ID ${staffId} already exists`, "exists");
      try {
        const account = await store.createAccount({
          user_id: userId,
          staff_id: staffId,
          display_name: displayName,
          role,
          tenant_id: tenantId as string | null,
          client_name: clientName || null,
          membership_role: tenantId ? "agent" : "owner",
          must_change_password: true,
        });
        await store.audit({
          tenantId: account.tenant_id,
          actorUserId: callerId,
          action: "staff.create",
          target: staffId,
          detail: { role, new_client: !!clientName },
        });
        console.log(`admin-staff: ${caller.staff_id} created ${staffId} (${role})`);
        // The generated password is shown to the admin exactly once; it is not stored anywhere readable.
        return json({ staff: account, ...(supplied ? {} : { temporary_password: password }) }, 200, corsHeaders);
      } catch (err) {
        await store.deleteAuthUser(userId); // do not leave a login without its staff row and tenant
        throw err;
      }
    }

    case "set_disabled": {
      const target = await targetStaff(store, input.user_id);
      if (typeof input.disabled !== "boolean") throw new HttpError(400, "disabled must be true or false", "invalid");
      if (target.user_id === callerId && input.disabled) {
        throw new HttpError(400, "You cannot disable your own account", "invalid");
      }
      // Order matters: when disabling, block data access (RLS) first, then block new sessions.
      const staff = await store.setDisabled(target.user_id, input.disabled);
      await store.setBanned(target.user_id, input.disabled);
      await store.audit({
        tenantId: await store.getTenantId(target.user_id),
        actorUserId: callerId,
        action: input.disabled ? "staff.disable" : "staff.enable",
        target: target.staff_id,
      });
      console.log(`admin-staff: ${caller.staff_id} set ${target.staff_id} disabled=${input.disabled}`);
      return json({ staff }, 200, corsHeaders);
    }

    case "reset_password": {
      const target = await targetStaff(store, input.user_id);
      const supplied = input.password !== undefined && input.password !== null;
      const password = supplied ? validPassword(input.password) : generateFrom(PASSWORD_ALPHABET, 16, random);
      await store.setPassword(target.user_id, password, true);
      await store.audit({
        tenantId: await store.getTenantId(target.user_id),
        actorUserId: callerId,
        action: "staff.reset_password",
        target: target.staff_id,
      });
      console.log(`admin-staff: ${caller.staff_id} reset the password of ${target.staff_id}`);
      return json({ staff: target, ...(supplied ? {} : { temporary_password: password }) }, 200, corsHeaders);
    }

    default:
      throw new HttpError(400, "Unknown action", "invalid");
  }
}

function validPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 72) {
    throw new HttpError(400, "Password must be 8-72 characters", "invalid");
  }
  return value;
}

async function targetStaff(store: AdminStore, userId: unknown): Promise<AdminStaffRow> {
  if (typeof userId !== "string" || !UUID.test(userId)) throw new HttpError(400, "user_id must be a UUID", "invalid");
  const staff = await store.getStaff(userId);
  if (!staff) throw new HttpError(404, "Staff member not found", "not_found");
  return staff;
}

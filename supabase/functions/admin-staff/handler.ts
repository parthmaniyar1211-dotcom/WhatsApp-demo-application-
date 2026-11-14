// admin-staff: create, disable/enable and reset passwords of staff logins.
//
// Requires the JWT of an active staff member with role "admin".
// This is the only place staff accounts are created (public signup is off), and it
// runs with the service role on the server, so that key never reaches the web app or APK.
//
// Request body (JSON), one of:
//   { "action": "create", "staff_id": "EMP1001", "password": "...", "display_name": "Asha", "role": "staff" }
//   { "action": "set_disabled", "user_id": "<uuid>", "disabled": true }
//   { "action": "reset_password", "user_id": "<uuid>", "password": "..." }

import { bearerToken, corsHeaders, HttpError, json, logError, parseJsonObject, readBody } from "../_shared/http.ts";

export interface AdminStaffRow {
  user_id: string;
  staff_id: string;
  display_name: string;
  role: string;
  disabled: boolean;
}

export interface AdminStore {
  getUserId(jwt: string): Promise<string | null>;
  getStaff(userId: string): Promise<AdminStaffRow | null>;
  /** Creates the auth user (email already confirmed). Returns its id, or null if the email is taken. */
  createAuthUser(email: string, password: string): Promise<string | null>;
  deleteAuthUser(userId: string): Promise<void>;
  insertStaff(row: Omit<AdminStaffRow, "disabled">): Promise<AdminStaffRow>;
  setDisabled(userId: string, disabled: boolean): Promise<AdminStaffRow>;
  /** Banned users cannot sign in or refresh their session. */
  setBanned(userId: string, banned: boolean): Promise<void>;
  setPassword(userId: string, password: string): Promise<void>;
}

export interface AdminDeps {
  store: AdminStore;
  emailDomain: string; // "company.demo": staff id EMP1001 logs in as emp1001@company.demo
}

const MAX_BODY_BYTES = 8 * 1024;
const STAFF_ID = /^[A-Z0-9]{3,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function handle(req: Request, { store, emailDomain }: AdminDeps): Promise<Response> {
  const jwt = bearerToken(req);
  const callerId = jwt ? await store.getUserId(jwt) : null;
  if (!callerId) throw new HttpError(401, "Not signed in", "unauthenticated");
  const caller = await store.getStaff(callerId);
  if (!caller || caller.disabled || caller.role !== "admin") {
    throw new HttpError(403, "Admin access required", "forbidden");
  }

  const input = parseJsonObject(await readBody(req, MAX_BODY_BYTES));

  switch (input.action) {
    case "create": {
      const staffId = typeof input.staff_id === "string" ? input.staff_id.trim().toUpperCase() : "";
      if (!STAFF_ID.test(staffId)) {
        throw new HttpError(400, "Staff ID must be 3-20 letters or digits, for example EMP1001", "invalid");
      }
      const password = validPassword(input.password);
      const displayName = typeof input.display_name === "string" ? input.display_name.trim().slice(0, 80) : "";
      const role = input.role === undefined || input.role === null ? "staff" : input.role;
      if (role !== "staff" && role !== "admin") throw new HttpError(400, "Role must be staff or admin", "invalid");

      const userId = await store.createAuthUser(`${staffId.toLowerCase()}@${emailDomain}`, password);
      if (!userId) throw new HttpError(409, `Staff ID ${staffId} already exists`, "exists");
      try {
        const staff = await store.insertStaff({ user_id: userId, staff_id: staffId, display_name: displayName, role });
        console.log(`admin-staff: ${caller.staff_id} created ${staffId} (${role})`);
        return json({ staff }, 200, corsHeaders);
      } catch (err) {
        await store.deleteAuthUser(userId); // do not leave a login without a staff row
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
      console.log(`admin-staff: ${caller.staff_id} set ${target.staff_id} disabled=${input.disabled}`);
      return json({ staff }, 200, corsHeaders);
    }

    case "reset_password": {
      const target = await targetStaff(store, input.user_id);
      await store.setPassword(target.user_id, validPassword(input.password));
      console.log(`admin-staff: ${caller.staff_id} reset the password of ${target.staff_id}`);
      return json({ staff: target }, 200, corsHeaders);
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

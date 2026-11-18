// complete-password-change: the ONLY way out of the "temporary password" lock (review finding F1).
//
// A login created or reset by an administrator has public.staff.must_change_password = true. While it is true the
// database gives that login no tenant, no data, no admin powers (current_tenant_ids / is_admin / is_active_staff are
// empty or false), whatever the state of its session. This function lets the login set its own password and lifts
// the lock, after verifying:
//   * the caller holds a VALID session (a JWT checked by Auth, verify_jwt is also on),
//   * the login exists, is not disabled, and really is flagged (otherwise "not_required": use the normal Change password),
//   * the session is FRESH: it was issued in the last 30 minutes, so an old stolen token cannot do this (they must
//     sign in again with the temporary password),
//   * the new password is 8-72 characters and is NOT the temporary password (tested by trying to sign in with it),
//   * attempts are rate limited per login.
// The server then sets the password itself (Auth admin API), clears the flag, signs the other sessions out, and writes an
// audit entry (never the password). The browser cannot clear the flag: staff has no client write privilege and the
// flag is not in user_metadata any more.
//
// Request:  { "new_password": "..." }        Response: { "ok": true }

import { bearerToken, corsHeaders, HttpError, json, logError, parseJsonObject, readBody } from "../_shared/http.ts";
import type { AuditEntry } from "../admin-staff/handler.ts";

export interface PasswordUser {
  id: string;
  email: string | null;
  /** Seconds since the epoch when the session's access token was issued (the "iat" claim), if known. */
  issuedAt: number | null;
}

export interface PasswordStaff {
  staff_id: string;
  disabled: boolean;
  must_change_password: boolean;
}

export interface PasswordStore {
  /** The user behind a valid access token, or null. */
  getUserFromJwt(jwt: string): Promise<PasswordUser | null>;
  getStaff(userId: string): Promise<PasswordStaff | null>;
  getTenantId(userId: string): Promise<string | null>;
  /** True when this password already signs the account in (so it is the current, temporary one). */
  passwordMatches(email: string, password: string): Promise<boolean>;
  setPassword(userId: string, password: string): Promise<void>;
  /** Lifts the database lock (public.staff.must_change_password = false). */
  clearMustChange(userId: string): Promise<void>;
  /** Ends all other sessions of this login (best effort). */
  signOutOthers(jwt: string): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface PasswordDeps {
  store: PasswordStore;
  now?: () => number;
}

export const MAX_SESSION_AGE_SECONDS = 30 * 60;
export const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, number[]>();

export function createPasswordHandler(deps: PasswordDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      return await complete(req, deps);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status, corsHeaders);
      logError("complete-password-change failed", err);
      return json({ error: "Internal error" }, 500, corsHeaders);
    }
  };
}

async function complete(req: Request, { store, now }: PasswordDeps): Promise<Response> {
  const nowMs = (now ?? Date.now)();
  const jwt = bearerToken(req);
  const user = jwt ? await store.getUserFromJwt(jwt) : null;
  if (!user || !jwt) throw new HttpError(401, "Not signed in", "unauthenticated");

  const staff = await store.getStaff(user.id);
  if (!staff || staff.disabled) throw new HttpError(403, "This account is not allowed to do this", "forbidden");
  if (!staff.must_change_password) {
    throw new HttpError(409, "Your password does not need to be changed here. Use Change password in the menu.", "not_required");
  }

  // Freshness: the person must have just signed in with the temporary password.
  if (user.issuedAt === null || nowMs / 1000 - user.issuedAt > MAX_SESSION_AGE_SECONDS) {
    throw new HttpError(401, "Sign in again with your temporary password, then choose your new password.", "reauth_required");
  }

  // Rate limit per login (in memory, per function instance; Auth rate-limits sign-ins as well).
  const recent = (attempts.get(user.id) ?? []).filter((t) => nowMs - t < ATTEMPT_WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.", "rate_limited");
  recent.push(nowMs);
  attempts.set(user.id, recent);

  const input = parseJsonObject(await readBody(req, 4096));
  const password = input.new_password;
  if (typeof password !== "string" || password.length < 8 || password.length > 72) {
    throw new HttpError(400, "Password must be 8-72 characters", "invalid");
  }
  if (!user.email) throw new HttpError(500, "Internal error", "internal");
  if (await store.passwordMatches(user.email, password)) {
    throw new HttpError(400, "Choose a password different from the temporary one", "same_as_temporary");
  }

  // 1. new password, 2. lift the lock. If step 2 fails the lock stays (safe); an admin can reset the password.
  await store.setPassword(user.id, password);
  let cleared = false;
  for (let attempt = 0; attempt < 3 && !cleared; attempt++) {
    try {
      await store.clearMustChange(user.id);
      cleared = true;
    } catch (err) {
      logError("complete-password-change: could not lift the lock", err);
    }
  }
  if (!cleared) throw new HttpError(500, "Your password was saved but the account could not be unlocked. Contact your administrator.", "finish_failed");

  try {
    await store.signOutOthers(jwt);
  } catch (err) {
    logError("complete-password-change: could not end the other sessions", err);
  }
  try {
    await store.audit({
      tenantId: await store.getTenantId(user.id),
      actorUserId: user.id,
      action: "staff.password_changed",
      target: staff.staff_id,
    });
  } catch (err) {
    logError("complete-password-change: audit failed", err); // the change itself succeeded
  }
  attempts.delete(user.id);
  console.log(`complete-password-change: ${staff.staff_id} chose a new password`);
  return json({ ok: true }, 200, corsHeaders);
}

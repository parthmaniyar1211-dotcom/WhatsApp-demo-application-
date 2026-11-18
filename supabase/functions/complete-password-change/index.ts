import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { serviceClient } from "../_shared/supabase_store.ts";
import { createPasswordHandler, type PasswordStore } from "./handler.ts";

const db = serviceClient();

/** The "iat" claim of an access token whose signature Auth has already verified. */
function issuedAt(jwt: string): number | null {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part.padEnd(part.length + (4 - (part.length % 4)) % 4, "=")));
    return typeof claims.iat === "number" ? claims.iat : null;
  } catch {
    return null;
  }
}

const store: PasswordStore = {
  async getUserFromJwt(jwt) {
    const { data, error } = await db.auth.getUser(jwt);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null, issuedAt: issuedAt(jwt) };
  },
  async getStaff(userId) {
    const { data, error } = await db.from("staff").select("staff_id, disabled, must_change_password").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(`load staff: ${error.code ?? ""} ${error.message}`);
    return data;
  },
  async getTenantId(userId) {
    const { data } = await db.from("tenant_memberships").select("tenant_id").eq("user_id", userId).maybeSingle();
    return (data as { tenant_id: string } | null)?.tenant_id ?? null;
  },
  async passwordMatches(email, password) {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anon) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not available");
    const probe = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await probe.auth.signInWithPassword({ email, password });
    if (!error && data.session) await probe.auth.signOut({ scope: "local" });
    return !error;
  },
  async setPassword(userId, password) {
    const { error } = await db.auth.admin.updateUserById(userId, { password });
    if (error) throw new Error(`set password: ${error.code ?? error.status}`);
  },
  async clearMustChange(userId) {
    const { error } = await db.rpc("set_must_change_password", { p_user_id: userId, p_value: false });
    if (error) throw new Error(`clear requirement: ${error.code ?? ""} ${error.message}`);
  },
  async signOutOthers(jwt) {
    const { error } = await db.auth.admin.signOut(jwt, "others");
    if (error) throw new Error(`sign out others: ${error.code ?? error.status}`);
  },
  async audit(entry) {
    const { error } = await db.rpc("write_audit", {
      p_tenant_id: entry.tenantId,
      p_actor_user_id: entry.actorUserId,
      p_action: entry.action,
      p_target: entry.target,
      p_detail: entry.detail ?? {},
    });
    if (error) throw new Error(`write audit log: ${error.code ?? ""} ${error.message}`);
  },
};

Deno.serve(createPasswordHandler({ store }));

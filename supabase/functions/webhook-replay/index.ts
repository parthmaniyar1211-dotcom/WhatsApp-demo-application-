import { waEnv } from "../_shared/env.ts";
import { serviceClient, webhookStore } from "../_shared/supabase_store.ts";
import { createReplayHandler } from "./handler.ts";

const db = serviceClient();
const env = waEnv();

Deno.serve(createReplayHandler({
  admin: {
    async getUserId(jwt) {
      const { data, error } = await db.auth.getUser(jwt);
      return error || !data.user ? null : data.user.id;
    },
    async getStaff(userId) {
      const { data, error } = await db.from("staff").select("staff_id, role, disabled, must_change_password").eq("user_id", userId).maybeSingle();
      if (error) throw new Error(`load staff: ${error.code ?? ""} ${error.message}`);
      return data;
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
  },
  webhook: { env, store: webhookStore(db, { token: env.token, phoneId: env.phoneId }) },
}));

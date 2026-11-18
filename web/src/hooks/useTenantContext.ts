import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { CONNECTION_COLUMNS } from "../lib/adminApi";
import { errorMessage } from "../lib/format";
import type { WhatsAppConnection } from "../lib/types";

export type TenantContext =
  | { state: "loading" }
  | { state: "none" } // signed in, but no active client account
  | { state: "ok"; tenantId: string; tenantName: string; connections: WhatsAppConnection[] }
  | { state: "error"; message: string };

/**
 * The client account (tenant) of the signed-in login and its WhatsApp connections. Both reads go through
 * row level security, so a login can only ever see its own. `reload` refreshes the connection status.
 */
export function useTenantContext(userId: string | null): { context: TenantContext; reload: () => void } {
  const [result, setResult] = useState<{ userId: string; context: TenantContext } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      let context: TenantContext;
      try {
        const membership = await supabase
          .from("tenant_memberships")
          .select("tenant_id, disabled")
          .eq("user_id", userId)
          .maybeSingle();
        if (membership.error) throw membership.error;
        // current_tenant_ids() is empty for a disabled login or a suspended client, so the tenant row is not visible then.
        const tenant = membership.data && !membership.data.disabled
          ? await supabase.from("tenants").select("id, name, status").eq("id", membership.data.tenant_id).maybeSingle()
          : null;
        if (tenant?.error) throw tenant.error;
        if (!tenant?.data || tenant.data.status !== "active") {
          context = { state: "none" };
        } else {
          const connections = await supabase
            .from("whatsapp_connections")
            .select(CONNECTION_COLUMNS)
            .eq("tenant_id", tenant.data.id)
            .order("created_at");
          if (connections.error) throw connections.error;
          context = {
            state: "ok",
            tenantId: tenant.data.id,
            tenantName: tenant.data.name,
            connections: (connections.data ?? []) as unknown as WhatsAppConnection[],
          };
        }
      } catch (err) {
        context = { state: "error", message: errorMessage(err) };
      }
      if (!cancelled) setResult({ userId, context });
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const context: TenantContext = result && result.userId === userId ? result.context : { state: "loading" };
  return { context, reload };
}

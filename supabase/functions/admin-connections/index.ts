import { connectionsAdminStore, serviceClient } from "../_shared/supabase_store.ts";
import { createConnectionsAdminHandler } from "./handler.ts";

const flag = (name: string) => Deno.env.get(name)?.trim().toLowerCase() === "true";

Deno.serve(createConnectionsAdminHandler({
  store: connectionsAdminStore(serviceClient()),
  manualTokens: flag("ALLOW_MANUAL_TOKEN"), // off unless explicitly "true"
  embeddedSignup: flag("FEATURE_EMBEDDED_SIGNUP"), // off until Meta Tech Provider approval is confirmed
}));

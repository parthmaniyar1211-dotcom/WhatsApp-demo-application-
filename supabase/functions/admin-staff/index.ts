import { adminStore, serviceClient } from "../_shared/supabase_store.ts";
import { createAdminHandler } from "./handler.ts";

Deno.serve(createAdminHandler({
  store: adminStore(serviceClient()),
  emailDomain: Deno.env.get("STAFF_EMAIL_DOMAIN")?.trim() || "company.demo",
}));

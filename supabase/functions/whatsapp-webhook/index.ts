import { waEnv } from "../_shared/env.ts";
import { serviceClient, webhookStore } from "../_shared/supabase_store.ts";
import { createWebhookHandler } from "./handler.ts";

const env = waEnv();
// WA_TOKEN / WA_PHONE_ID serve only the legacy test-number connection; every other connection uses its Vault token.
Deno.serve(createWebhookHandler({
  env,
  store: webhookStore(serviceClient(), { token: env.token, phoneId: env.phoneId }),
}));

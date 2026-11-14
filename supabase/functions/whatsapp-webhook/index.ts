import { waEnv } from "../_shared/env.ts";
import { serviceClient, webhookStore } from "../_shared/supabase_store.ts";
import { createWebhookHandler } from "./handler.ts";

Deno.serve(createWebhookHandler({ env: waEnv(), store: webhookStore(serviceClient()) }));

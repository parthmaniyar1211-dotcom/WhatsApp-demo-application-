import { waEnv } from "../_shared/env.ts";
import { sendStore, serviceClient } from "../_shared/supabase_store.ts";
import { createSendHandler } from "./handler.ts";

Deno.serve(createSendHandler({ env: waEnv(), store: sendStore(serviceClient()) }));

import { waEnv } from "../_shared/env.ts";
import { sendStore, serviceClient } from "../_shared/supabase_store.ts";
import { createSendHandler } from "./handler.ts";

const env = waEnv();
Deno.serve(createSendHandler({ env, store: sendStore(serviceClient(), { token: env.token, phoneId: env.phoneId }) }));

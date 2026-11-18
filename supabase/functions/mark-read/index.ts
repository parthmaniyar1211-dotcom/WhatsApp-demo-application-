import { waEnv } from "../_shared/env.ts";
import { markReadStore, serviceClient } from "../_shared/supabase_store.ts";
import { createMarkReadHandler } from "./handler.ts";

const env = waEnv();
Deno.serve(createMarkReadHandler({ env, store: markReadStore(serviceClient(), { token: env.token, phoneId: env.phoneId }) }));

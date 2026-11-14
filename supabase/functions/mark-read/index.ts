import { waEnv } from "../_shared/env.ts";
import { markReadStore, serviceClient } from "../_shared/supabase_store.ts";
import { createMarkReadHandler } from "./handler.ts";

Deno.serve(createMarkReadHandler({ env: waEnv(), store: markReadStore(serviceClient()) }));

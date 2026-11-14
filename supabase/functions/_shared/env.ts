// Reads the WhatsApp settings from Supabase secrets (never from the client).

export function waEnv() {
  const get = (name: string) => Deno.env.get(name)?.trim() || undefined;
  return {
    verifyToken: get("WA_VERIFY_TOKEN"),
    appSecret: get("WA_APP_SECRET"),
    token: get("WA_TOKEN"),
    phoneId: get("WA_PHONE_ID"),
    graphVersion: get("WA_GRAPH_VERSION") ?? "v24.0",
    // Off unless explicitly "true".
    dryRun: get("WA_DRY_RUN")?.toLowerCase() === "true",
  };
}

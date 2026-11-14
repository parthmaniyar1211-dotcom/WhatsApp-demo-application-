// Reads the WhatsApp settings from Supabase secrets (never from the client).

export function waEnv() {
  const get = (name: string) => Deno.env.get(name)?.trim() || undefined;
  return {
    verifyToken: get("WA_VERIFY_TOKEN"),
    appSecret: get("WA_APP_SECRET"),
    token: get("WA_TOKEN"),
    phoneId: get("WA_PHONE_ID"),
    // v26.0 is the current Graph API version (released 2026-07-29). Override without a deploy.
    graphVersion: get("WA_GRAPH_VERSION") ?? "v26.0",
    // "link" (default): Meta fetches files from a short-lived signed URL.
    // "upload": files are uploaded to Meta first and sent by media id.
    mediaMode: get("WA_MEDIA_MODE")?.toLowerCase() === "upload" ? "upload" as const : "link" as const,
    // Off unless explicitly "true".
    dryRun: get("WA_DRY_RUN")?.toLowerCase() === "true",
  };
}

// wa-diagnose: read-only health check of the WhatsApp setup, run INSIDE Supabase with the real secrets.
//
// Admin JWT required. Sends no WhatsApp message and stores nothing. The answer contains only
// pass/fail, names, public facts (expiry date, scopes, number's last 4 digits) - never a secret value.
// Every string in the answer is scrubbed of the configured secret values as a second safety net.

import { bearerToken, corsHeaders, json } from "../_shared/http.ts";
import { adminStore, serviceClient } from "../_shared/supabase_store.ts";
import { waEnv } from "../_shared/env.ts";

// Meta answers are untrusted JSON: read only what is needed.
// deno-lint-ignore no-explicit-any
type Meta = any;
type Row = { check: string; result: "PASS" | "FAIL" | "WARN" | "SKIP"; detail: string };

async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const store = adminStore(serviceClient());
  const jwt = bearerToken(req);
  const userId = jwt ? await store.getUserId(jwt) : null;
  const caller = userId ? await store.getStaff(userId) : null;
  if (!caller || caller.disabled || caller.role !== "admin") return json({ error: "Admin access required" }, 403, corsHeaders);

  const env = waEnv();
  const wabaId = Deno.env.get("WA_BUSINESS_ACCOUNT_ID")?.trim();
  const secrets = [env.token, env.appSecret, env.verifyToken].filter((s): s is string => !!s && s.length >= 4);
  const scrub = (text: string) => secrets.reduce((out, s) => out.split(s).join("[hidden]"), text).slice(0, 300);
  const rows: Row[] = [];
  const add = (check: string, result: Row["result"], detail: string) => rows.push({ check, result, detail: scrub(detail) });

  // 1. Configuration present
  for (const [name, value] of [
    ["WA_TOKEN", env.token], ["WA_PHONE_ID", env.phoneId], ["WA_APP_SECRET", env.appSecret],
    ["WA_VERIFY_TOKEN", env.verifyToken], ["WA_BUSINESS_ACCOUNT_ID", wabaId],
  ] as const) add(`Secret ${name}`, value ? "PASS" : name === "WA_BUSINESS_ACCOUNT_ID" ? "WARN" : "FAIL", value ? `set (${value.length} characters)` : "NOT SET");
  add("WA_DRY_RUN", env.dryRun ? "FAIL" : "PASS", env.dryRun ? "true: no real message is sent" : "false: real messages are sent");
  add("WA_GRAPH_VERSION", "PASS", `${env.graphVersion}, media mode ${env.mediaMode}`);

  const graph = async (path: string, token = env.token) => {
    const r = await fetch(`https://graph.facebook.com/${env.graphVersion}/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, body: await r.json().catch(() => ({})) as Meta };
  };
  const problem = (b: Meta, status: number) => `HTTP ${status}, Meta code ${b?.error?.code ?? "?"}: ${b?.error?.message ?? "unknown"}`;

  // 2. Token
  let appId: string | undefined;
  if (env.token) {
    const t = await graph(`debug_token?input_token=${encodeURIComponent(env.token)}`);
    const d = t.body?.data;
    if (t.status !== 200 || !d) add("WhatsApp token", "FAIL", problem(t.body, t.status));
    else {
      appId = String(d.app_id);
      const expires = d.expires_at ? new Date(d.expires_at * 1000) : null;
      const scopes: string[] = d.scopes ?? [];
      const ok = d.is_valid && scopes.includes("whatsapp_business_messaging");
      add("WhatsApp token", ok ? (expires ? "WARN" : "PASS") : "FAIL",
        `${d.is_valid ? "valid" : "INVALID"}, ${expires ? `expires ${expires.toISOString()} (temporary token)` : "never expires"}, ` +
        `messaging permission ${scopes.includes("whatsapp_business_messaging") ? "yes" : "NO"}, type ${d.type}`);
    }
    // 3. Phone number
    if (env.phoneId) {
      const p = await graph(`${env.phoneId}?fields=display_phone_number,verified_name,quality_rating,platform_type,status`);
      if (p.status === 200) {
        const last4 = String(p.body.display_phone_number ?? "").replace(/\D/g, "").slice(-4);
        add("Phone number ID", p.body.status === "CONNECTED" && p.body.platform_type === "CLOUD_API" ? "PASS" : "WARN",
          `number …${last4}, "${p.body.verified_name}", ${p.body.status}, ${p.body.platform_type}, quality ${p.body.quality_rating}`);
      } else add("Phone number ID", "FAIL", problem(p.body, p.status));
    }
    // 4. Business account: template + app subscription
    if (wabaId) {
      const t2 = await graph(`${wabaId}/message_templates?name=hello_world&fields=name,status,language`);
      const hw = (t2.body?.data ?? []).find((x: Meta) => x.language === "en_US");
      add("Template hello_world (en_US)", hw?.status === "APPROVED" ? "PASS" : "FAIL", t2.status === 200 ? `status ${hw?.status ?? "not found"}` : problem(t2.body, t2.status));
      const s = await graph(`${wabaId}/subscribed_apps`);
      const apps = (s.body?.data ?? []).map((a: Meta) => a.whatsapp_business_api_data?.id ?? a.id);
      add("Business account subscribed to the app", appId && apps.includes(appId) ? "PASS" : "WARN",
        s.status === 200 ? `${apps.length} app(s) subscribed${appId ? `, this app ${apps.includes(appId) ? "is" : "is NOT"} among them` : ""}` : problem(s.body, s.status));
    }
  }

  // 5. App secret is the real one (Meta accepts "<app id>|<app secret>" as an app access token) + webhook subscription
  if (appId && env.appSecret) {
    const a = await graph(`${appId}?fields=name`, `${appId}|${env.appSecret}`);
    add("WA_APP_SECRET is this app's secret", a.status === 200 ? "PASS" : "FAIL",
      a.status === 200 ? `accepted by Meta for app "${a.body.name}"` : `rejected by Meta (${problem(a.body, a.status)}): wrong secret or wrong app`);
    if (a.status === 200) {
      const sub = await graph(`${appId}/subscriptions`, `${appId}|${env.appSecret}`);
      const wa = (sub.body?.data ?? []).find((x: Meta) => x.object === "whatsapp_business_account");
      const expected = `${Deno.env.get("SUPABASE_URL")}/functions/v1/whatsapp-webhook`;
      const fields: string[] = (wa?.fields ?? []).map((f: Meta) => f.name);
      add("Meta webhook callback URL", wa?.callback_url === expected ? "PASS" : "FAIL",
        wa ? `${wa.callback_url === expected ? "matches this project" : `points to ${wa.callback_url}`}, active ${wa.active}` : "no whatsapp_business_account webhook configured in the Meta app");
      add("Meta webhook field 'messages'", fields.includes("messages") ? "PASS" : "FAIL", `subscribed fields: ${fields.join(", ") || "none"}`);
    }
  }

  // 6. The deployed webhook, called from here with the real secrets
  const hook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/whatsapp-webhook`;
  if (env.verifyToken && env.appSecret) {
    const v = (token: string) => fetch(`${hook}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=c4ll3nge`);
    const good = await v(env.verifyToken); const goodText = await good.text();
    add("Webhook GET with WA_VERIFY_TOKEN", good.status === 200 && goodText === "c4ll3nge" ? "PASS" : "FAIL", `HTTP ${good.status}`);
    const bad = await v("wrong-token"); await bad.text();
    add("Webhook GET with a wrong token", bad.status === 403 ? "PASS" : "FAIL", `HTTP ${bad.status} (expect 403)`);
    // A correctly signed body that is not a WhatsApp event: accepted and ignored, nothing is stored.
    const body = JSON.stringify({ object: "wa_diagnose", nonce: crypto.randomUUID() });
    const post = async (headers: Record<string, string>) => { const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }); await r.text(); return r.status; };
    const signed = await post({ "X-Hub-Signature-256": await hmacHex(body, env.appSecret) });
    add("Webhook POST signed with WA_APP_SECRET", signed === 200 ? "PASS" : "FAIL", `HTTP ${signed} (expect 200)`);
    const wrong = await post({ "X-Hub-Signature-256": await hmacHex(body, "not-the-secret") });
    add("Webhook POST with a wrong signature", wrong === 401 ? "PASS" : "FAIL", `HTTP ${wrong} (expect 401)`);
    const none = await post({});
    add("Webhook POST without signature", none === 401 ? "PASS" : "FAIL", `HTTP ${none} (expect 401)`);
  } else add("Webhook self-test", "SKIP", "WA_VERIFY_TOKEN or WA_APP_SECRET missing");

  return json({ rows, failed: rows.filter((r) => r.result === "FAIL").length }, 200, corsHeaders);
});

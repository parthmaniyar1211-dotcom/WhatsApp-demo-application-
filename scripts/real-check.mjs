#!/usr/bin/env node
// Live smoke test of the deployed project with your REAL WhatsApp credentials.
// It sends no WhatsApp message and stores nothing.
//
//   node scripts/real-check.mjs
//
// Values are read from the environment, from ~/wa-secrets.env (or the file named in
// WA_SECRETS_FILE) and from ./.env and ./web/.env. Needed:
//   SUPABASE_URL (or VITE_SUPABASE_URL)   the project the functions are deployed to
//   WA_VERIFY_TOKEN, WA_APP_SECRET        same values as `supabase secrets set`
//   WA_TOKEN, WA_PHONE_ID                 same values as `supabase secrets set`
// Optional:
//   WA_BUSINESS_ACCOUNT_ID                also checks the hello_world template and the webhook subscription
//   WA_GRAPH_VERSION                      default v26.0
//
// No secret is ever printed: only names, HTTP statuses and Meta's error codes.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadEnv, sign, supabaseUrl } from "./lib/meta.mjs";

const secretsFile = process.env.WA_SECRETS_FILE || resolve(homedir(), "wa-secrets.env");
if (existsSync(secretsFile)) process.loadEnvFile(secretsFile);
loadEnv();

const env = (name) => (process.env[name] ?? "").trim();
const webhookUrl = env("WEBHOOK_URL") || (supabaseUrl() ? `${supabaseUrl()}/functions/v1/whatsapp-webhook` : "");
const graphBase = (env("GRAPH_BASE_URL") || "https://graph.facebook.com").replace(/\/+$/, ""); // override is for tests only
const version = env("WA_GRAPH_VERSION") || "v26.0";

const required = { "SUPABASE_URL": webhookUrl, WA_VERIFY_TOKEN: env("WA_VERIFY_TOKEN"), WA_APP_SECRET: env("WA_APP_SECRET"), WA_TOKEN: env("WA_TOKEN"), WA_PHONE_ID: env("WA_PHONE_ID") };
const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.log(`SKIPPED: real-check needs your real credentials. Missing: ${missing.join(", ")}.`);
  console.log(`Put them in ${secretsFile} (one NAME=value per line) or in the environment, then run it again.`);
  process.exit(0);
}

// Never let a secret reach the terminal, even inside an unexpected error text.
const secrets = [env("WA_TOKEN"), env("WA_APP_SECRET"), env("WA_VERIFY_TOKEN")].filter((s) => s.length >= 4);
const redact = (text) => secrets.reduce((out, secret) => out.split(secret).join("[hidden]"), String(text)).slice(0, 160);

const rows = [];
const record = (check, ok, detail) => rows.push({ check, result: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", detail: redact(detail) });

const HINTS = {
  190: "WA_TOKEN is expired or invalid: copy a new token from Meta > WhatsApp > API Setup",
  0: "WA_TOKEN is invalid",
  10: "the token lacks a permission (whatsapp_business_messaging / whatsapp_business_management)",
  100: "WA_PHONE_ID is not a phone number ID this token can see (use the Phone number ID, not the phone number)",
  33: "WA_PHONE_ID does not exist or this token cannot see it",
  4: "rate limit: wait a minute",
};

async function attempt(check, run) {
  try {
    await run();
  } catch (err) {
    record(check, false, `request failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function graph(path) {
  const response = await fetch(`${graphBase}/${version}/${path}`, {
    headers: { Authorization: `Bearer ${env("WA_TOKEN")}` },
    signal: AbortSignal.timeout(20_000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // not JSON
  }
  const code = body?.error?.code;
  const problem = response.ok ? null : `HTTP ${response.status}, Meta error code ${code ?? "?"}: ${HINTS[code] ?? body?.error?.message ?? "unknown error"}`;
  return { response, body, problem };
}

// --- 1. The deployed webhook --------------------------------------------------

await attempt("Webhook verification (GET, correct token)", async () => {
  const challenge = randomBytes(8).toString("hex");
  const url = new URL(webhookUrl);
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", env("WA_VERIFY_TOKEN"));
  url.searchParams.set("hub.challenge", challenge);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  const ok = response.status === 200 && text === challenge;
  record(
    "Webhook verification (GET, correct token)",
    ok,
    ok ? "200, challenge echoed" : response.status === 403
      ? "403: WA_VERIFY_TOKEN here differs from the Supabase secret"
      : response.status === 401
      ? "401: deploy whatsapp-webhook with --no-verify-jwt"
      : response.status === 404
      ? "404: function not deployed, or SUPABASE_URL is wrong"
      : `HTTP ${response.status}`,
  );
});

await attempt("Webhook verification (GET, wrong token)", async () => {
  const url = new URL(webhookUrl);
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", "wrong-" + randomBytes(4).toString("hex"));
  url.searchParams.set("hub.challenge", "1");
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  await response.text();
  record("Webhook verification (GET, wrong token)", response.status === 403, `HTTP ${response.status} (expected 403)`);
});

await attempt("Webhook rejects an unsigned POST", async () => {
  const response = await fetch(webhookUrl, { method: "POST", body: "{}", signal: AbortSignal.timeout(20_000) });
  await response.text();
  record(
    "Webhook rejects an unsigned POST",
    response.status === 401,
    response.status === 503 ? "503: WA_APP_SECRET is not set in Supabase" : `HTTP ${response.status} (expected 401)`,
  );
});

await attempt("Webhook accepts WA_APP_SECRET signature", async () => {
  // A correctly signed body that is not a WhatsApp event: accepted (200) and ignored. Nothing is stored.
  const body = JSON.stringify({ object: "real_check", nonce: randomBytes(6).toString("hex") });
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body, env("WA_APP_SECRET")) },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  await response.text();
  record(
    "Webhook accepts WA_APP_SECRET signature",
    response.status === 200,
    response.status === 200
      ? "200: the secret here matches the Supabase secret"
      : response.status === 401
      ? "401: WA_APP_SECRET here differs from the Supabase secret"
      : `HTTP ${response.status}`,
  );
});

// --- 2. Meta: token and phone number (read-only calls) ----------------------------

await attempt("WA_TOKEN is valid and can read WA_PHONE_ID", async () => {
  const { response, body, problem } = await graph(
    `${encodeURIComponent(env("WA_PHONE_ID"))}?fields=display_phone_number,verified_name,quality_rating,platform_type`,
  );
  if (problem) return record("WA_TOKEN is valid and can read WA_PHONE_ID", false, problem);
  const number = String(body?.display_phone_number ?? "").replace(/\D/g, "");
  record(
    "WA_TOKEN is valid and can read WA_PHONE_ID",
    true,
    `number ending ...${number.slice(-4) || "????"}, name "${body?.verified_name ?? "?"}", quality ${body?.quality_rating ?? "?"}`,
  );
  const served = response.headers.get("facebook-api-version");
  record(
    `Graph API version ${version}`,
    !served || served === version,
    served ? (served === version ? "served as requested" : `Meta answered with ${served}: set WA_GRAPH_VERSION=${served}`) : "version header not returned",
  );
  record(
    "Phone number is a Cloud API number",
    body?.platform_type ? body.platform_type === "CLOUD_API" : null,
    body?.platform_type ? `platform_type ${body.platform_type}` : "platform_type not returned",
  );
});

const waba = env("WA_BUSINESS_ACCOUNT_ID");
if (!waba) {
  record("hello_world template is approved", null, "set WA_BUSINESS_ACCOUNT_ID to check");
  record("App is subscribed to the business account", null, "set WA_BUSINESS_ACCOUNT_ID to check");
} else {
  await attempt("hello_world template is approved", async () => {
    const { body, problem } = await graph(`${encodeURIComponent(waba)}/message_templates?name=hello_world&fields=name,status,language`);
    if (problem) return record("hello_world template is approved", false, problem);
    const template = (body?.data ?? []).find((t) => t.name === "hello_world" && t.language === "en_US");
    record(
      "hello_world template is approved",
      template?.status === "APPROVED",
      template ? `status ${template.status}` : "no hello_world template in en_US on this account",
    );
  });
  await attempt("App is subscribed to the business account", async () => {
    const { body, problem } = await graph(`${encodeURIComponent(waba)}/subscribed_apps`);
    if (problem) return record("App is subscribed to the business account", false, problem);
    const count = (body?.data ?? []).length;
    record("App is subscribed to the business account", count > 0, count > 0 ? `${count} app(s) subscribed` : "no app subscribed: webhooks will not arrive");
  });
}

// --- Result table ---------------------------------------------------------------

const width = Math.max(...rows.map((r) => r.check.length));
console.log(`\n${"CHECK".padEnd(width)}  RESULT  DETAIL`);
console.log(`${"-".repeat(width)}  ------  ------`);
for (const row of rows) console.log(`${row.check.padEnd(width)}  ${row.result.padEnd(6)}  ${row.detail}`);
const failed = rows.filter((r) => r.result === "FAIL").length;
console.log(
  failed === 0
    ? "\nALL CHECKS PASSED. Not checked here: whether WA_TOKEN / WA_PHONE_ID in Supabase equal these values, and WA_DRY_RUN (must be false for real messages)."
    : `\n${failed} check(s) FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);

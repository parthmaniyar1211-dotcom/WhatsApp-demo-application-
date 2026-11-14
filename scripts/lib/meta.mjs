// Shared code for the test harness: builds Meta-style webhook payloads, signs them
// exactly like Meta does (HMAC-SHA256 of the raw body with the app secret) and posts them.
// Node 20.12+ only, no dependencies.

import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Loads ./.env and ./web/.env (if present). Real environment variables win. */
export function loadEnv() {
  for (const file of [resolve(repoRoot, ".env"), resolve(repoRoot, "web/.env")]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function supabaseUrl() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  return url.replace(/\/+$/, "");
}

export function anonKey() {
  return process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
}

/** Settings for the harness. Exits with a clear message when something required is missing. */
export function harnessConfig({ needSecret = true, needVerifyToken = false } = {}) {
  loadEnv();
  const webhookUrl = process.env.WEBHOOK_URL ||
    (supabaseUrl() ? `${supabaseUrl()}/functions/v1/whatsapp-webhook` : "");
  const config = {
    webhookUrl,
    appSecret: process.env.WA_APP_SECRET || "",
    verifyToken: process.env.WA_VERIFY_TOKEN || "",
    phoneId: process.env.WA_PHONE_ID || "SIMULATED_PHONE_ID",
    from: process.env.SIM_FROM || "919800000001",
    name: process.env.SIM_NAME || "Test Customer",
  };
  const missing = [];
  if (!config.webhookUrl) missing.push("WEBHOOK_URL (or SUPABASE_URL)");
  if (needSecret && !config.appSecret) missing.push("WA_APP_SECRET");
  if (needVerifyToken && !config.verifyToken) missing.push("WA_VERIFY_TOKEN");
  if (missing.length) {
    console.error(`Missing: ${missing.join(", ")}. Set them in .env (see .env.example) or in the environment.`);
    process.exit(2);
  }
  return config;
}

export function newMessageId() {
  return `wamid.SIM.${Date.now()}.${randomBytes(6).toString("hex")}`;
}

function envelope(phoneId, value) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "SIMULATED_WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550000000", phone_number_id: phoneId },
          ...value,
        },
      }],
    }],
  };
}

export const INCOMING_KINDS = ["text", "image", "document", "audio", "video", "sticker", "location", "contacts"];

/**
 * Returns the payload object Meta would send for one incoming message.
 *   kind:     one of INCOMING_KINDS
 *   text:     message text, or the caption of an image / video / document
 *   filename: document file name
 *   replyTo:  wamid of the message the customer is replying to (quote)
 *   hoursAgo: pretend the customer sent it that long ago (default: now)
 */
export function incomingPayload({ kind, phoneId, from, name, id = newMessageId(), text, filename, replyTo, hoursAgo = 0 }) {
  // hoursAgo > 24 makes the conversation look like its 24-hour reply window is closed.
  const sentAt = Math.floor(Date.now() / 1000 - hoursAgo * 3600);
  const message = { from, id, timestamp: String(sentAt), type: kind };
  const media = (mime, extra = {}) => ({ id: "SIMULATED_MEDIA_ID", mime_type: mime, sha256: "simulated", ...extra });
  const caption = text ? { caption: text } : {};
  if (kind === "text") {
    message.text = { body: text ?? "Hello from the test harness" };
  } else if (kind === "image") {
    message.image = media("image/png", caption);
  } else if (kind === "video") {
    message.video = media("video/mp4", caption);
  } else if (kind === "audio") {
    message.audio = media("audio/ogg; codecs=opus", { voice: true });
  } else if (kind === "sticker") {
    message.sticker = media("image/webp", { animated: false });
  } else if (kind === "document") {
    message.document = media("application/pdf", { filename: filename ?? "test-document.pdf", ...caption });
  } else if (kind === "location") {
    message.location = {
      latitude: 19.076,
      longitude: 72.8777,
      name: text ?? "Gateway of India",
      address: "Apollo Bandar, Colaba, Mumbai",
    };
  } else if (kind === "contacts") {
    message.contacts = [{
      name: { formatted_name: text ?? "Ravi Kumar", first_name: "Ravi" },
      phones: [{ phone: "+91 98000 00042", wa_id: "919800000042", type: "CELL" }],
    }];
  } else {
    throw new Error(`Unknown kind: ${kind}`);
  }
  if (replyTo) message.context = { from: "15550000000", id: replyTo };
  return envelope(phoneId, { contacts: [{ profile: { name }, wa_id: from }], messages: [message] });
}

/** The customer reacts to a message (emoji "" or undefined removes the reaction, like Meta does). */
export function reactionPayload({ phoneId, from, name, messageId, emoji }) {
  const message = {
    from,
    id: newMessageId(),
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: "reaction",
    reaction: { message_id: messageId, ...(emoji ? { emoji } : {}) },
  };
  return envelope(phoneId, { contacts: [{ profile: { name }, wa_id: from }], messages: [message] });
}

/** status: "sent" | "delivered" | "read" | "played" | "failed" for an outgoing message id. */
export function statusPayload({ phoneId, to, messageId, status }) {
  const entry = { id: messageId, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: to };
  if (status === "failed") {
    entry.errors = [{
      code: 131026,
      title: "Message undeliverable",
      message: "Message undeliverable",
      error_data: { details: "Simulated failure from the test harness" },
      href: "https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/",
    }];
  }
  return envelope(phoneId, { statuses: [entry] });
}

export function sign(body, secret) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/** POSTs a payload to the webhook. Returns { status, json, text }. */
export async function postWebhook(url, payload, secret, { signature } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature ?? sign(body, secret) },
    body,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, json, text };
}

/** Signs in a staff user with the anon key (no service role needed). Returns an access token. */
export async function staffLogin() {
  const staffId = process.env.E2E_STAFF_ID;
  const password = process.env.E2E_PASSWORD;
  if (!staffId || !password || !supabaseUrl() || !anonKey()) return null;
  const response = await fetch(`${supabaseUrl()}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${staffId.trim().toLowerCase()}@company.demo`, password }),
  });
  if (!response.ok) throw new Error(`Staff login failed (HTTP ${response.status}). Check E2E_STAFF_ID / E2E_PASSWORD.`);
  return (await response.json()).access_token;
}

/** Reads rows through the REST API as a signed-in staff user (RLS applies). */
export async function restSelect(accessToken, pathAndQuery) {
  const response = await fetch(`${supabaseUrl()}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: anonKey(), Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`REST query failed (HTTP ${response.status})`);
  return await response.json();
}

export function pass(message) {
  console.log(`PASS  ${message}`);
}

export function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

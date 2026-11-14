#!/usr/bin/env node
// Does the same GET check Meta does when you press "Verify and save" in the app dashboard.
//
//   node scripts/verify-webhook.mjs
//
// Env: WEBHOOK_URL (or SUPABASE_URL), WA_VERIFY_TOKEN.

import { randomBytes } from "node:crypto";
import { fail, harnessConfig, pass } from "./lib/meta.mjs";

const config = harnessConfig({ needSecret: false, needVerifyToken: true });

async function verify(token) {
  const challenge = randomBytes(8).toString("hex");
  const url = new URL(config.webhookUrl);
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", token);
  url.searchParams.set("hub.challenge", challenge);
  const response = await fetch(url);
  return { status: response.status, body: await response.text(), challenge };
}

const good = await verify(config.verifyToken);
if (good.status === 200 && good.body === good.challenge) pass("correct verify token -> 200 and the challenge is echoed");
else fail(`correct verify token -> HTTP ${good.status} (expected 200 + challenge). Is WA_VERIFY_TOKEN the same on the server?`);

const bad = await verify("wrong-" + randomBytes(4).toString("hex"));
if (bad.status === 403) pass("wrong verify token -> HTTP 403");
else fail(`wrong verify token -> HTTP ${bad.status}, expected 403`);

#!/usr/bin/env node
// Sends the same message id twice (like a Meta retry) and checks it is stored once.
//
//   node scripts/simulate-duplicate.mjs
//
// The webhook's own counters are always checked. If E2E_PASSWORD and the
// anon key are set, the script also signs in and counts the rows in the database.

import { fail, harnessConfig, incomingPayload, newMessageId, pass, postWebhook, restSelect, staffLogin } from "./lib/meta.mjs";

const config = harnessConfig();
const id = newMessageId();
const payload = incomingPayload({
  kind: "text",
  phoneId: config.phoneId,
  from: config.from,
  name: config.name,
  id,
  text: "Duplicate delivery test",
});

const first = await postWebhook(config.webhookUrl, payload, config.appSecret);
const second = await postWebhook(config.webhookUrl, payload, config.appSecret);
console.log(`1st POST -> HTTP ${first.status} ${first.text}`);
console.log(`2nd POST -> HTTP ${second.status} ${second.text}`);

if (first.status === 200 && first.json?.stored === 1) pass("first delivery stored");
else fail("first delivery was not stored (check WA_APP_SECRET / WA_PHONE_ID)");

if (second.status === 200 && second.json?.stored === 0 && second.json?.duplicates === 1) {
  pass("second delivery recognised as duplicate");
} else {
  fail("second delivery was not treated as a duplicate");
}

const token = await staffLogin();
if (!token) {
  console.log("SKIP  database row count (set SUPABASE_URL, SUPABASE_ANON_KEY, E2E_PASSWORD to enable)");
} else {
  const rows = await restSelect(token, `wa_messages?select=id&wa_message_id=eq.${encodeURIComponent(id)}`);
  if (rows.length === 1) pass("exactly one row in wa_messages");
  else fail(`expected 1 row in wa_messages, found ${rows.length}`);
}

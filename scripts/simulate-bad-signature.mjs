#!/usr/bin/env node
// Checks that the webhook rejects requests that are not signed with the app secret.
//
//   node scripts/simulate-bad-signature.mjs
//
// Needs only WEBHOOK_URL (or SUPABASE_URL): the whole point is that no secret is known.

import { fail, harnessConfig, incomingPayload, pass, postWebhook, sign } from "./lib/meta.mjs";

const config = harnessConfig({ needSecret: false });
const payload = JSON.stringify(
  incomingPayload({ kind: "text", phoneId: config.phoneId, from: config.from, name: config.name, text: "forged" }),
);

const cases = [
  ["wrong secret", { "X-Hub-Signature-256": sign(payload, "definitely-not-the-secret") }],
  ["malformed signature", { "X-Hub-Signature-256": "sha256=1234" }],
  ["no signature header", {}],
];

for (const [label, headers] of cases) {
  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: payload,
  });
  await response.text();
  if (response.status === 401) pass(`${label} -> HTTP 401`);
  else if (response.status === 503) fail(`${label} -> HTTP 503: WA_APP_SECRET is not set on the server (still rejected, but set the secret)`);
  else fail(`${label} -> HTTP ${response.status}, expected 401`);
}

if (config.appSecret) {
  // A valid signature for a different body must not pass either.
  const tampered = await postWebhook(config.webhookUrl, payload + " ", config.appSecret, {
    signature: sign(payload, config.appSecret),
  });
  if (tampered.status === 401) pass("valid signature on a modified body -> HTTP 401");
  else fail(`valid signature on a modified body -> HTTP ${tampered.status}, expected 401`);
}

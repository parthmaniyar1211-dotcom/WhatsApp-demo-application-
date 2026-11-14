#!/usr/bin/env node
// Sends one simulated WhatsApp event to the webhook, signed like Meta signs it.
//
//   node scripts/simulate-incoming.mjs text "Hello, is my order ready?"
//   node scripts/simulate-incoming.mjs image "optional caption"
//   node scripts/simulate-incoming.mjs document "invoice.pdf"
//   node scripts/simulate-incoming.mjs status <wa_message_id> delivered|read|failed|sent
//
// Options: --from 919800000002   --name "Another Customer"   --id wamid.CUSTOM
//          --hours-ago 25   (pretend it was sent 25 hours ago: closes the 24-hour window
//                            if it is the customer's only message; use a new --from number)
// Env: WEBHOOK_URL (or SUPABASE_URL), WA_APP_SECRET, WA_PHONE_ID (must match the server's, if set there).
// Images/documents need WA_DRY_RUN=true on the server (the simulated media id does not exist at Meta).

import { harnessConfig, incomingPayload, postWebhook, statusPayload } from "./lib/meta.mjs";

const args = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) options[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
const [kind, first, second] = positional;

if (!["text", "image", "document", "status"].includes(kind)) {
  console.error("Usage: simulate-incoming.mjs text|image|document|status [...]  (see the top of this file)");
  process.exit(2);
}

const config = harnessConfig();
const from = options.from ?? config.from;
const name = options.name ?? config.name;

let payload;
if (kind === "status") {
  if (!first || !["sent", "delivered", "read", "failed"].includes(second)) {
    console.error("Usage: simulate-incoming.mjs status <wa_message_id> sent|delivered|read|failed");
    process.exit(2);
  }
  payload = statusPayload({ phoneId: config.phoneId, to: from, messageId: first, status: second });
} else {
  payload = incomingPayload({
    kind,
    phoneId: config.phoneId,
    from,
    name,
    id: options.id,
    hoursAgo: Number(options["hours-ago"] ?? 0) || 0,
    text: kind === "document" ? undefined : first,
    filename: kind === "document" ? first : undefined,
  });
}

const result = await postWebhook(config.webhookUrl, payload, config.appSecret);
console.log(`POST ${config.webhookUrl} -> HTTP ${result.status} ${result.text}`);

if (result.status !== 200) {
  console.error("FAIL  webhook did not return 200");
  if (result.status === 401) console.error("      WA_APP_SECRET here differs from the secret set on the server.");
  if (result.status === 503) console.error("      WA_APP_SECRET is not set on the server (supabase secrets set).");
  process.exit(1);
}
const counted = kind === "status" ? result.json?.statuses : result.json?.stored;
if (counted === 1) {
  console.log(`PASS  ${kind} accepted${kind === "status" ? "" : ` (message id ${payload.entry[0].changes[0].value.messages[0].id})`}`);
} else if (kind !== "status" && result.json?.duplicates === 1) {
  console.log("PASS  accepted as a duplicate (this id was already stored)");
} else {
  console.error("FAIL  the webhook accepted the request but ignored the event.");
  console.error(
    kind === "status"
      ? "      No outgoing message has that wa_message_id, or its status is already further along."
      : "      WA_PHONE_ID here probably differs from WA_PHONE_ID set on the server.",
  );
  process.exit(1);
}

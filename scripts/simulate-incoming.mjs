#!/usr/bin/env node
// Sends one simulated WhatsApp event to the webhook, signed like Meta signs it.
//
//   node scripts/simulate-incoming.mjs text "Hello, is my order ready?"
//   node scripts/simulate-incoming.mjs image "optional caption"
//   node scripts/simulate-incoming.mjs video "optional caption"
//   node scripts/simulate-incoming.mjs document "invoice.pdf"
//   node scripts/simulate-incoming.mjs audio            (a voice note)
//   node scripts/simulate-incoming.mjs sticker
//   node scripts/simulate-incoming.mjs location "Place name"
//   node scripts/simulate-incoming.mjs contacts "Contact name"
//   node scripts/simulate-incoming.mjs reaction <wa_message_id> 👍      (no emoji = remove the reaction)
//   node scripts/simulate-incoming.mjs status <wa_message_id> delivered|read|played|failed|sent
//
// Options: --from 919800000002   --name "Another Customer"   --id wamid.CUSTOM
//          --reply-to <wa_message_id>   (the customer quotes that message)
//          --hours-ago 25   (pretend it was sent 25 hours ago: closes the 24-hour window
//                            if it is the customer's only message; use a new --from number)
// Env: WEBHOOK_URL (or SUPABASE_URL), WA_APP_SECRET, WA_PHONE_ID (must match the server's, if set there).
// Media kinds need WA_DRY_RUN=true on the server (the simulated media id does not exist at Meta).

import {
  harnessConfig,
  INCOMING_KINDS,
  incomingPayload,
  postWebhook,
  reactionPayload,
  statusPayload,
} from "./lib/meta.mjs";

const args = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) options[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
const [kind, first, second] = positional;
const STATUSES = ["sent", "delivered", "read", "played", "failed"];

if (![...INCOMING_KINDS, "reaction", "status"].includes(kind)) {
  console.error(`Usage: simulate-incoming.mjs ${[...INCOMING_KINDS, "reaction", "status"].join("|")} [...]  (see the top of this file)`);
  process.exit(2);
}

const config = harnessConfig();
const from = options.from ?? config.from;
const name = options.name ?? config.name;

let payload;
let counter = "stored";
if (kind === "status") {
  if (!first || !STATUSES.includes(second)) {
    console.error(`Usage: simulate-incoming.mjs status <wa_message_id> ${STATUSES.join("|")}`);
    process.exit(2);
  }
  payload = statusPayload({ phoneId: config.phoneId, to: from, messageId: first, status: second });
  counter = "statuses";
} else if (kind === "reaction") {
  if (!first) {
    console.error("Usage: simulate-incoming.mjs reaction <wa_message_id> [emoji]");
    process.exit(2);
  }
  payload = reactionPayload({ phoneId: config.phoneId, from, name, messageId: first, emoji: second });
  counter = "reactions";
} else {
  payload = incomingPayload({
    kind,
    phoneId: config.phoneId,
    from,
    name,
    id: options.id,
    hoursAgo: Number(options["hours-ago"] ?? 0) || 0,
    replyTo: options["reply-to"],
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
if (result.json?.[counter] === 1) {
  const id = counter === "stored" ? ` (message id ${payload.entry[0].changes[0].value.messages[0].id})` : "";
  console.log(`PASS  ${kind} accepted${id}`);
} else if (counter === "stored" && result.json?.duplicates === 1) {
  console.log("PASS  accepted as a duplicate (this id was already stored)");
} else {
  console.error("FAIL  the webhook accepted the request but ignored the event.");
  console.error(
    counter === "statuses"
      ? "      No outgoing message has that wa_message_id, or its status is already further along."
      : counter === "reactions"
      ? "      No message has that wa_message_id."
      : "      WA_PHONE_ID here probably differs from WA_PHONE_ID set on the server.",
  );
  process.exit(1);
}

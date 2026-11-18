#!/usr/bin/env node
// End-to-end check of the multi-tenant isolation against a LOCAL Supabase stack
// (supabase start + supabase functions serve, with WA_DRY_RUN=true and ALLOW_MANUAL_TOKEN=true):
//
//   node scripts/verify-multi-tenant-local.mjs
//
// It drives the real Auth, PostgREST, Storage, Realtime, Vault and Edge Functions with real logins:
// two new clients (tenants) are created through the admin function, each with its own connection, and the
// script then tries to cross the boundary in every way a client could. It REFUSES to run against anything
// but localhost, and it deletes everything it created when it ends.
//
// Needs (in the environment, never printed): SUPABASE_URL, SUPABASE_ANON_KEY, LOCAL_SERVICE_ROLE_KEY,
// WA_APP_SECRET, E2E_STAFF_ID / E2E_PASSWORD of the LOCAL platform admin.

import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const ANON = process.env.SUPABASE_ANON_KEY || "";
const SERVICE = process.env.LOCAL_SERVICE_ROLE_KEY || "";
const APP_SECRET = process.env.WA_APP_SECRET || "";
const ADMIN_ID = (process.env.E2E_STAFF_ID || "ADMIN1").toLowerCase();
const ADMIN_PW = process.env.E2E_PASSWORD || "";

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) {
  console.error(`Refusing to run: SUPABASE_URL must be a local stack (127.0.0.1 / localhost), got "${URL_ ? new URL(URL_).host : ""}".`);
  process.exit(2);
}
for (const [name, value] of Object.entries({ SUPABASE_ANON_KEY: ANON, LOCAL_SERVICE_ROLE_KEY: SERVICE, WA_APP_SECRET: APP_SECRET, E2E_PASSWORD: ADMIN_PW })) {
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
}

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else {
    failed++;
    failures.push(`${name}${detail ? ` -> ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}

async function http(path, { method = "GET", token, body, headers = {}, raw = false } = {}) {
  const response = await fetch(`${URL_}${path}`, {
    method,
    headers: {
      apikey: ANON,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: response.status, json, text };
}

const service = (path, opts = {}) => http(path, { ...opts, token: SERVICE, headers: { apikey: SERVICE, ...(opts.headers || {}) } });

async function login(email, password) {
  const r = await http("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
  if (r.status !== 200) return { ok: false, status: r.status };
  return { ok: true, token: r.json.access_token, user: r.json.user };
}

const fn = (name, token, body) => http(`/functions/v1/${name}`, { method: "POST", token, body });
const rest = (token, path, opts = {}) => http(`/rest/v1/${path}`, { token, ...opts });
const rpc = (token, name, body = {}) => http(`/rest/v1/rpc/${name}`, { method: "POST", token, body });

function webhookBody(phoneId, wabaId, value) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: wabaId, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: phoneId }, ...value } }] }],
  });
}
async function webhook(phoneId, wabaId, value, { signature } = {}) {
  const body = webhookBody(phoneId, wabaId, value);
  const sig = signature ?? "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
  const r = await fetch(`${URL_}/functions/v1/whatsapp-webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* */ }
  return { status: r.status, json };
}
const textIn = (from, id, body) => ({ contacts: [{ profile: { name: "Cust " + from.slice(-4) }, wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }] });
const imageIn = (from, id) => ({ contacts: [{ profile: { name: "Cust" }, wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "image", image: { id: "SIM_MEDIA", mime_type: "image/png" } }] });

const run = randomBytes(3).toString("hex");
const created = { tenants: [], users: [], connections: [] };
let UNKNOWN_PHONE = "";
const PHONE_A = "9" + String(Date.now()).slice(-9) + "1"; // numeric phone number ids (Meta format)
const PHONE_B = "9" + String(Date.now()).slice(-9) + "2";
const WABA_A = "8" + String(Date.now()).slice(-9) + "1";
const WABA_B = "8" + String(Date.now()).slice(-9) + "2";
const FAKE_TOKEN_A = `EAAfaketokenA${run}${"a".repeat(30)}`;
const FAKE_TOKEN_B = `EAAfaketokenB${run}${"b".repeat(30)}`;

try {
  console.log(`Target: ${new URL(URL_).host} (local)\n`);

  // ---- Platform admin ----------------------------------------------------------------------
  const admin = await login(`${ADMIN_ID}@company.demo`, ADMIN_PW);
  check("platform admin can sign in", admin.ok, `HTTP ${admin.status}`);
  if (!admin.ok) throw new Error("cannot continue without the admin");

  const mk = async (label) => {
    const r = await fn("admin-staff", admin.token, { action: "create", client_name: `ZZ Test ${label} ${run}`, display_name: `Owner ${label}` });
    if (r.status === 200) {
      created.users.push(r.json.staff.user_id);
      created.tenants.push(r.json.staff.tenant_id);
    }
    return r;
  };
  const ra = await mk("A");
  const rb = await mk("B");
  check("admin creates client A with a generated Staff ID and one-time temporary password", ra.status === 200 && /^CC[A-Z2-9]{6}$/.test(ra.json?.staff?.staff_id) && ra.json?.temporary_password?.length === 16, `HTTP ${ra.status}`);
  check("admin creates client B", rb.status === 200);
  const A = { staffId: ra.json.staff.staff_id, userId: ra.json.staff.user_id, tenantId: ra.json.staff.tenant_id, pw: ra.json.temporary_password };
  const B = { staffId: rb.json.staff.staff_id, userId: rb.json.staff.user_id, tenantId: rb.json.staff.tenant_id, pw: rb.json.temporary_password };
  check("the two clients are different tenants", A.tenantId !== B.tenantId);

  const staffNotAdmin = await login(`${A.staffId.toLowerCase()}@company.demo`, A.pw);
  check("client A signs in with the temporary password", staffNotAdmin.ok);
  const lockedRows = await rest(staffNotAdmin.token, "conversations?select=id");
  check("first login is LOCKED by the database: no data until the password is changed (F1)", lockedRows.status === 200 && lockedRows.json?.length === 0);
  const lockedSend = await fn("send-whatsapp", staffNotAdmin.token, { conversation_id: "00000000-0000-4000-8000-000000000000", text: "x" });
  check("a locked login cannot send", lockedSend.status >= 400);
  // The only way out: the server-side function. Then sign in again with the new password.
  for (const [client, tok] of [[A, staffNotAdmin.token], [B, (await login(`${B.staffId.toLowerCase()}@company.demo`, B.pw)).token]]) {
    const newPw = "Own-" + randomBytes(6).toString("hex") + "!A1";
    const done = await fn("complete-password-change", tok, { new_password: newPw });
    check(`client ${client === A ? "A" : "B"} completes the password change on the server`, done.status === 200, `HTTP ${done.status}`);
    client.pw = newPw;
  }
  const la = await login(`${A.staffId.toLowerCase()}@company.demo`, A.pw);
  A.token = la.token;
  const lb = await login(`${B.staffId.toLowerCase()}@company.demo`, B.pw);
  B.token = lb.token;
  check("client A signs in with the new password", la.ok);
  check("client B signs in with the new password", lb.ok);

  check("a client cannot call the admin functions",
    (await fn("admin-staff", A.token, { action: "create", client_name: "evil" })).status === 403 &&
    (await fn("admin-connections", A.token, { action: "create", tenant_id: B.tenantId })).status === 403);
  check("unauthenticated calls to the admin functions are refused", (await fn("admin-staff", null, { action: "create" })).status === 401);

  // ---- Connections (Vault) -----------------------------------------------------------------
  const ca = await fn("admin-connections", admin.token, { action: "create", tenant_id: A.tenantId, label: "A number", waba_id: WABA_A, phone_number_id: PHONE_A });
  const cb = await fn("admin-connections", admin.token, { action: "create", tenant_id: B.tenantId, label: "B number", waba_id: WABA_B, phone_number_id: PHONE_B });
  check("admin creates a connection for each client", ca.status === 200 && cb.status === 200, `${ca.status}/${cb.status}`);
  A.conn = ca.json?.connection?.id;
  B.conn = cb.json?.connection?.id;
  created.connections.push(A.conn, B.conn);
  const dup = await fn("admin-connections", admin.token, { action: "create", tenant_id: B.tenantId, waba_id: WABA_B, phone_number_id: PHONE_A });
  check("the same phone number id cannot be attached to a second client", dup.status === 409, `HTTP ${dup.status}`);

  const ta = await fn("admin-connections", admin.token, { action: "set_token", connection_id: A.conn, token: FAKE_TOKEN_A });
  const tb = await fn("admin-connections", admin.token, { action: "set_token", connection_id: B.conn, token: FAKE_TOKEN_B });
  check("tokens are stored (Vault) and never echoed", ta.status === 200 && tb.status === 200 && !ta.text.includes(FAKE_TOKEN_A) && !tb.text.includes(FAKE_TOKEN_B));
  const getTok = (id) => service("/rest/v1/rpc/get_connection_token", { method: "POST", body: { p_connection_id: id } });
  const ga = await getTok(A.conn);
  const gb = await getTok(B.conn);
  check("the service role (Edge Functions) can decrypt each connection's own token", ga.json === FAKE_TOKEN_A && gb.json === FAKE_TOKEN_B);
  check("clients cannot decrypt tokens (RPC refused)", (await rpc(A.token, "get_connection_token", { p_connection_id: A.conn })).status >= 400 && (await rpc(A.token, "get_connection_token", { p_connection_id: B.conn })).status >= 400);
  check("admin cannot decrypt tokens either", (await rpc(admin.token, "get_connection_token", { p_connection_id: A.conn })).status >= 400);
  const colA = await rest(A.token, "whatsapp_connections?select=vault_secret_id");
  const starA = await rest(A.token, "whatsapp_connections?select=*");
  check("clients cannot read the Vault reference column (nor select *)", colA.status >= 400 && starA.status >= 400, `${colA.status}/${starA.status}`);
  const connsA = await rest(A.token, "whatsapp_connections?select=id,status,label,phone_number_id");
  check("client A sees only its own connection, as connected", connsA.status === 200 && connsA.json.length === 1 && connsA.json[0].id === A.conn && connsA.json[0].status === "connected");
  check("the token text is nowhere in what clients can read", !JSON.stringify(connsA.json).includes("EAAfaketoken"));

  // ---- Chats and webhook routing -----------------------------------------------------------
  const custA = "9198000" + run.replace(/\D/g, "0").slice(0, 3).padEnd(3, "0") + "01";
  const startA = await rpc(A.token, "start_conversation", { p_phone: custA, p_name: "Customer of A" });
  const startB = await rpc(B.token, "start_conversation", { p_phone: custA, p_name: "Customer of B" }); // SAME number
  check("both clients can add the same customer number (separate chats)", startA.status === 200 && startB.status === 200 && startA.json.id !== startB.json.id && startA.json.tenant_id === A.tenantId && startB.json.tenant_id === B.tenantId && startA.json.connection_id === A.conn);
  A.conv = startA.json.id;
  B.conv = startB.json.id;

  const bad = await webhook(PHONE_A, WABA_A, textIn(custA, `wamid.T.${run}.bad`, "x"), { signature: "sha256=" + "0".repeat(64) });
  check("webhook with a wrong signature is rejected", bad.status === 401);
  const inA = await webhook(PHONE_A, WABA_A, textIn(custA, `wamid.T.${run}.a1`, "secret-of-A"));
  const inB = await webhook(PHONE_B, WABA_B, textIn(custA, `wamid.T.${run}.b1`, "secret-of-B"));
  check("webhooks are routed by phone number id: each is stored once", inA.json?.stored === 1 && inB.json?.stored === 1, JSON.stringify([inA.json, inB.json]));
  // F8: an event for a number nobody owns is QUARANTINED (kept), never silently dropped.
  UNKNOWN_PHONE = "9" + String(Date.now()).slice(-9) + "7";
  const unknown = await webhook(UNKNOWN_PHONE, WABA_A, textIn(custA, `wamid.T.${run}.u1`, "nobody-sees-this-text"));
  check("an unknown phone number id is acknowledged, stores nothing and is QUARANTINED", unknown.status === 200 && unknown.json?.stored === 0 && unknown.json?.quarantined === 1, JSON.stringify(unknown.json));
  const quar = await service(`/rest/v1/webhook_quarantine?phone_number_id=eq.${UNKNOWN_PHONE}&select=reason,payload,replayed_at`);
  check("the quarantined event is kept with its reason", quar.json?.length === 1 && quar.json[0].reason === "unknown_phone_number_id" && quar.json[0].payload != null);
  const ledgerRow = await service(`/rest/v1/webhook_events?phone_number_id=eq.${UNKNOWN_PHONE}&select=outcome,reason,event_id,quarantine_id`);
  check("the routing ledger records outcome, reason, event id and quarantine id", ledgerRow.json?.[0]?.outcome === "unrouted" && ledgerRow.json[0].reason === "unknown_phone_number_id" && !!ledgerRow.json[0].event_id && !!ledgerRow.json[0].quarantine_id);
  check("clients cannot read the quarantine", (await rest(A.token, "webhook_quarantine?select=id")).json?.length === 0 || (await rest(A.token, "webhook_quarantine?select=id")).status >= 400);
  const diag = await rpc(admin.token, "admin_routing_diagnostics");
  const diagText = JSON.stringify(diag.json);
  check("admin diagnostics list the unknown Phone Number ID as pending", diag.status === 200 && diag.json?.unrouted_phone_numbers?.some((u) => u.phone_number_id === UNKNOWN_PHONE && u.pending === 1));
  check("diagnostics contain no message text and no customer number", !diagText.includes("nobody-sees-this-text") && !diagText.includes(custA));
  check("a client cannot read routing diagnostics", (await rpc(A.token, "admin_routing_diagnostics")).status >= 400);
  check("a client cannot replay", (await fn("webhook-replay", A.token, { phone_number_id: UNKNOWN_PHONE })).status === 403);
  const early = await fn("webhook-replay", admin.token, { phone_number_id: UNKNOWN_PHONE });
  check("replay while still unroutable loses nothing", early.status === 200 && early.json?.still_unroutable === 1 && early.json?.replayed === 0, JSON.stringify(early.json));
  // The admin attaches the number to client A, then replays.
  const attach = await fn("admin-connections", admin.token, { action: "create", tenant_id: A.tenantId, label: "A second number", waba_id: WABA_A, phone_number_id: UNKNOWN_PHONE });
  created.connections.push(attach.json?.connection?.id);
  const done = await fn("webhook-replay", admin.token, { phone_number_id: UNKNOWN_PHONE });
  check("after the number is attached, replay stores the event once", done.status === 200 && done.json?.replayed === 1 && done.json?.tally?.stored === 1, JSON.stringify(done.json));
  const after = await service(`/rest/v1/wa_messages?body=eq.nobody-sees-this-text&select=tenant_id,conversations!wa_messages_conversation_tenant_fkey(connection_id)`);
  check("the replayed message belongs to the tenant and connection that own the number", after.json?.length === 1 && after.json[0].tenant_id === A.tenantId && after.json[0].conversations?.connection_id === attach.json?.connection?.id, JSON.stringify(after.json));
  const erased = await service(`/rest/v1/webhook_quarantine?phone_number_id=eq.${UNKNOWN_PHONE}&select=payload,replayed_at`);
  check("the quarantined payload is erased after a successful replay", erased.json?.[0]?.payload == null && !!erased.json?.[0]?.replayed_at);
  const again = await fn("webhook-replay", admin.token, { phone_number_id: UNKNOWN_PHONE });
  check("a second replay finds nothing (no duplicates)", again.json?.claimed === 0);
  const mismatch = await webhook(PHONE_A, WABA_B, textIn(custA, `wamid.T.${run}.m1`, "wrong waba"));
  check("a WABA id that does not match the connection is refused and quarantined", mismatch.status === 200 && mismatch.json?.stored === 0 && mismatch.json?.quarantined === 1);
  const replay = await webhook(PHONE_B, WABA_B, textIn(custA, `wamid.T.${run}.a1`, "replay of A's id on B"));
  check("replaying A's message id on B's number does not copy or change it", replay.json?.stored === 0 && replay.json?.duplicates === 1);

  const mA = await rest(A.token, `wa_messages?select=body,tenant_id&conversation_id=eq.${A.conv}`);
  const mB = await rest(B.token, `wa_messages?select=body,tenant_id&conversation_id=eq.${B.conv}`);
  check("A reads only A's message, B only B's", mA.json?.length === 1 && mA.json[0].body === "secret-of-A" && mB.json?.length === 1 && mB.json[0].body === "secret-of-B");

  // ---- IDOR / cross-tenant attacks over the real REST API ---------------------------------
  const evil = [];
  evil.push(["read B's conversation by id", (await rest(A.token, `conversations?id=eq.${B.conv}`)).json?.length === 0]);
  evil.push(["read B's messages by conversation id", (await rest(A.token, `wa_messages?conversation_id=eq.${B.conv}`)).json?.length === 0]);
  evil.push(["read B's messages by tenant id", (await rest(A.token, `wa_messages?tenant_id=eq.${B.tenantId}`)).json?.length === 0]);
  evil.push(["list all conversations: only own tenant", (await rest(A.token, "conversations?select=tenant_id")).json?.every((c) => c.tenant_id === A.tenantId)]);
  evil.push(["PATCH B's conversation is refused", (await rest(A.token, `conversations?id=eq.${B.conv}`, { method: "PATCH", body: { contact_name: "HACK" } })).status >= 400]);
  evil.push(["DELETE B's conversation is refused", (await rest(A.token, `conversations?id=eq.${B.conv}`, { method: "DELETE" })).status >= 400]);
  evil.push(["INSERT a conversation straight into B's tenant is refused", (await rest(A.token, "conversations", { method: "POST", body: { tenant_id: B.tenantId, connection_id: B.conn, wa_id: "1234567" } })).status >= 400]);
  evil.push(["INSERT a message straight into A's tenant is refused", (await rest(A.token, "wa_messages", { method: "POST", body: { tenant_id: A.tenantId, conversation_id: A.conv, direction: "in", type: "text", status: "received" } })).status >= 400]);
  evil.push(["mark_conversation_read on B's chat is refused", (await rpc(A.token, "mark_conversation_read", { p_conversation_id: B.conv })).status >= 400]);
  evil.push(["rename_contact on B's chat changes nothing", (await rpc(A.token, "rename_contact", { p_conversation_id: B.conv, p_name: "HACKED" })).status < 500]);
  evil.push(["B's contact name is untouched", (await rest(B.token, `conversations?id=eq.${B.conv}&select=contact_name`)).json?.[0]?.contact_name === "Customer of B"]);
  const bMsgId = mB.json?.length ? (await rest(B.token, `wa_messages?conversation_id=eq.${B.conv}&select=id`)).json[0].id : null;
  evil.push(["delete_message_for_me on B's message is refused", (await rpc(A.token, "delete_message_for_me", { p_message_id: bMsgId })).status >= 400]);
  evil.push(["set_message_flags (star) on B's message is refused", (await rpc(A.token, "set_message_flags", { p_message_id: bMsgId, p_starred: true, p_hidden: false })).status >= 400]);
  evil.push(["search cannot find B's text", ((await rpc(A.token, "search_messages", { p_query: "secret-of-B" })).json ?? []).length === 0]);
  evil.push(["search finds A's own text", ((await rpc(A.token, "search_messages", { p_query: "secret-of-A" })).json ?? []).length === 1]);
  evil.push(["B's staff row is invisible to A", (await rest(A.token, `staff?staff_id=eq.${B.staffId}`)).json?.length === 0]);
  evil.push(["other tenants are invisible", (await rest(A.token, "tenants?select=id")).json?.every((t) => t.id === A.tenantId)]);
  evil.push(["memberships of other tenants are invisible", (await rest(A.token, `tenant_memberships?tenant_id=eq.${B.tenantId}`)).json?.length === 0]);
  evil.push(["audit log is invisible to a client", (await rest(A.token, "audit_logs")).json?.length === 0]);
  evil.push(["webhook ledger is invisible to a client", (await rest(A.token, "webhook_events")).json?.length === 0]);
  evil.push(["admin report RPCs are refused", (await rpc(A.token, "admin_overview")).status >= 400 && (await rpc(A.token, "admin_tenant_summary")).status >= 400]);
  evil.push(["service-only RPCs are refused", (await rpc(A.token, "ingest_incoming", { p: {} })).status >= 400 && (await rpc(A.token, "resolve_connection", { p_phone_number_id: PHONE_B })).status >= 400]);
  evil.push(["a forged tenant_id in start_conversation is ignored (tenant comes from the login)", (await rpc(A.token, "start_conversation", { p_phone: "919811122233", p_name: "x", p_tenant_id: B.tenantId })).status >= 400]);
  const anon = await http("/rest/v1/conversations?select=id");
  evil.push(["anonymous (anon key only) reads nothing", anon.status >= 400 || (Array.isArray(anon.json) && anon.json.length === 0)]);
  for (const [name, ok] of evil) check(`attack: ${name}`, ok === true);

  // ---- Sending (dry run) -------------------------------------------------------------------
  const sendA = await fn("send-whatsapp", A.token, { conversation_id: A.conv, text: "reply from A" });
  check("A can send in its own chat (dry run)", sendA.status === 200 && sendA.json?.message?.status === "sent", `HTTP ${sendA.status} ${sendA.text.slice(0, 120)}`);
  const sendCross = await fn("send-whatsapp", B.token, { conversation_id: A.conv, text: "B writes into A's chat" });
  check("B cannot send into A's chat (404, nothing stored)", sendCross.status === 404);
  const sendTpl = await fn("send-whatsapp", B.token, { conversation_id: A.conv, template: "hello_world" });
  check("B cannot send a template into A's chat", sendTpl.status === 404);
  const rd = await fn("mark-read", B.token, { conversation_id: A.conv });
  check("B cannot mark A's chat read", rd.status === 404);
  const leak = await rest(A.token, `wa_messages?conversation_id=eq.${A.conv}&select=body,sent_by`);
  check("A's chat holds A's incoming message and A's reply, nothing from B", leak.json?.length === 2 && !leak.json.some((m) => m.body?.includes("B writes")));

  // ---- Storage -----------------------------------------------------------------------------
  const img = await webhook(PHONE_A, WABA_A, imageIn(custA, `wamid.T.${run}.img`));
  check("an incoming photo is stored for A (dry run sample)", img.json?.stored === 1);
  const imgRow = (await rest(A.token, `wa_messages?conversation_id=eq.${A.conv}&type=eq.image&select=media_path`)).json?.[0];
  check("the file path was recorded", !!imgRow?.media_path, JSON.stringify(imgRow));
  const sign = (token) => http(`/storage/v1/object/sign/files/${imgRow.media_path}`, { method: "POST", token, body: { expiresIn: 60 } });
  const sA = await sign(A.token);
  const sB = await sign(B.token);
  const sAnon = await http(`/storage/v1/object/sign/files/${imgRow.media_path}`, { method: "POST", body: { expiresIn: 60 } });
  check("A can sign a URL for its own incoming file", sA.status === 200 && !!sA.json?.signedURL, `HTTP ${sA.status}`);
  check("B cannot sign a URL for A's file", sB.status >= 400, `HTTP ${sB.status}`);
  check("an anonymous caller cannot sign a URL", sAnon.status >= 400);
  const dl = await http(`/storage/v1/object/authenticated/files/${imgRow.media_path}`, { token: B.token });
  check("B cannot download A's file directly", dl.status >= 400);
  const up = (token, uid) => http(`/storage/v1/object/files/outgoing/${uid}/t-${run}.png`, { method: "POST", token, headers: { "Content-Type": "image/png" }, body: Buffer.from("89504e470d0a1a0a", "hex"), raw: true });
  const upA = await up(A.token, A.userId);
  const upCross = await up(B.token, A.userId);
  check("A can upload into its own outgoing folder", upA.status === 200, `HTTP ${upA.status} ${upA.text.slice(0, 80)}`);
  check("B cannot upload into A's outgoing folder", upCross.status >= 400, `HTTP ${upCross.status}`);
  const readOwn = await http(`/storage/v1/object/sign/files/outgoing/${A.userId}/t-${run}.png`, { method: "POST", token: B.token, body: { expiresIn: 60 } });
  check("B cannot sign A's pending upload", readOwn.status >= 400);

  // ---- Realtime ----------------------------------------------------------------------------
  try {
    const sdk = resolve(process.cwd(), "web/node_modules/@supabase/supabase-js");
    if (!existsSync(sdk)) throw new Error("web dependencies are not installed");
    const { createClient } = await import(`${sdk}/dist/index.mjs`);
    const seen = { A: [], B: [] };
    // Sign in through the client, exactly like the web app does, so Realtime joins with the user's own role.
    const listener = (label, email, password) => {
      const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 10 } } });
      return new Promise((ok, no) => {
        client.auth.signInWithPassword({ email, password }).then(({ error }) => {
          if (error) return no(new Error(`realtime sign-in failed: ${error.message}`));
          client.channel(`rt-${label}-${run}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "wa_messages" }, (p) => {
            seen[label].push(p.new?.body ?? `<no body ${JSON.stringify(p.errors ?? [])}>`);
          }).subscribe((s) => s === "SUBSCRIBED" && ok(client));
        });
      });
    };
    const cliA = await listener("A", `${A.staffId.toLowerCase()}@company.demo`, A.pw);
    const cliB = await listener("B", `${B.staffId.toLowerCase()}@company.demo`, B.pw);
    await new Promise((r) => setTimeout(r, 1500));
    const live = await webhook(PHONE_A, WABA_A, textIn(custA, `wamid.T.${run}.rt1`, "live-for-A"));
    check("the live message was stored", live.json?.stored === 1);
    // Positive control first: wait (up to 10 s) until A has it, then give B the same time to (wrongly) get it.
    for (let i = 0; i < 20 && !seen.A.includes("live-for-A"); i++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 2000));
    check("Realtime delivers A's new message to A", seen.A.includes("live-for-A"), JSON.stringify(seen));
    check("Realtime delivers NOTHING at all (not even an empty event) to the other tenant", seen.B.length === 0, JSON.stringify(seen));
    const liveB = await webhook(PHONE_B, WABA_B, textIn(custA, `wamid.T.${run}.rt2`, "live-for-B"));
    for (let i = 0; i < 20 && !seen.B.includes("live-for-B"); i++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 1500));
    check("Realtime delivers B's message to B and not to A", liveB.json?.stored === 1 && JSON.stringify(seen.B) === '["live-for-B"]' && JSON.stringify(seen.A) === '["live-for-A"]', JSON.stringify(seen));
    await cliA.removeAllChannels();
    await cliB.removeAllChannels();
  } catch (e) {
    check("Realtime isolation test could run", false, e.message);
  }

  // ---- Admin oversight ---------------------------------------------------------------------
  const ov = await rpc(admin.token, "admin_overview");
  check("admin overview returns counts", ov.status === 200 && typeof ov.json?.tenants === "number" && "messages_24h" in ov.json);
  const sum = await rpc(admin.token, "admin_tenant_summary");
  const rowA = sum.json?.find((t) => t.tenant_id === A.tenantId);
  check("admin tenant summary shows per-client counts only", !!rowA && rowA.connections_connected === 1 && rowA.messages_24h_in >= 2 && !("body" in rowA));
  check("admin can list connections of all clients", (await rest(admin.token, "whatsapp_connections?select=id")).json?.length >= 3);
  check("admin does NOT read the message content of clients", (await rest(admin.token, `wa_messages?tenant_id=eq.${A.tenantId}`)).json?.length === 0);

  // ---- Connection lifecycle ----------------------------------------------------------------
  const dis = await fn("admin-connections", admin.token, { action: "disconnect", connection_id: A.conn });
  check("admin disconnects A's number", dis.status === 200);
  const afterDis = await webhook(PHONE_A, WABA_A, textIn(custA, `wamid.T.${run}.d1`, "to a disconnected number"));
  check("a disconnected number's webhook is acknowledged but stores nothing", afterDis.status === 200 && afterDis.json?.stored === 0);
  check("its token was deleted from Vault", (await getTok(A.conn)).json === null);
  check("B's token is untouched", (await getTok(B.conn)).json === FAKE_TOKEN_B);
  const ev = await rest(admin.token, `webhook_events?connection_id=eq.${A.conn}&outcome=eq.inactive&select=outcome`);
  check("the routing ledger recorded the refused event (admin only)", ev.json?.length >= 1);
  await fn("admin-connections", admin.token, { action: "reconnect", connection_id: A.conn });
  await fn("admin-connections", admin.token, { action: "set_token", connection_id: A.conn, token: FAKE_TOKEN_A + "-rotated" });
  const rot = await getTok(A.conn);
  check("reconnect + new token works (rotation)", rot.json === FAKE_TOKEN_A + "-rotated");
  const back = await webhook(PHONE_A, WABA_A, textIn(custA, `wamid.T.${run}.d2`, "back online"));
  check("the number receives messages again", back.json?.stored === 1);
  const flag = await fn("admin-connections", admin.token, { action: "start_onboarding", tenant_id: A.tenantId });
  check("Embedded Signup is behind its feature flag (refused)", flag.status === 403 && flag.json?.code === "feature_disabled");

  // ---- Suspension and disabling ------------------------------------------------------------
  await rpc(admin.token, "admin_set_tenant_status", { p_tenant_id: B.tenantId, p_status: "suspended" });
  check("suspended tenant B reads nothing immediately", (await rest(B.token, "conversations?select=id")).json?.length === 0);
  check("suspended tenant B cannot send", (await fn("send-whatsapp", B.token, { conversation_id: B.conv, text: "x" })).status === 403);
  const susp = await webhook(PHONE_B, WABA_B, textIn(custA, `wamid.T.${run}.s1`, "while suspended"));
  check("and its webhook is acknowledged but stores nothing", susp.status === 200 && susp.json?.stored === 0);
  await rpc(admin.token, "admin_set_tenant_status", { p_tenant_id: B.tenantId, p_status: "active" });
  check("reactivated tenant B reads again", (await rest(B.token, "conversations?select=id")).json?.length === 1);

  const off = await fn("admin-staff", admin.token, { action: "set_disabled", user_id: A.userId, disabled: true });
  check("admin disables client A", off.status === 200);
  check("A's still-valid token now reads nothing", (await rest(A.token, "conversations?select=id")).json?.length === 0);
  const sendOff = await fn("send-whatsapp", A.token, { conversation_id: A.conv, text: "x" });
  check("A can no longer send (refused: 401 banned session or 403 disabled)", sendOff.status === 401 || sendOff.status === 403, `HTTP ${sendOff.status}`);
  check("A cannot sign in again", !(await login(`${A.staffId.toLowerCase()}@company.demo`, A.pw)).ok);
  await fn("admin-staff", admin.token, { action: "set_disabled", user_id: A.userId, disabled: false });
  const reset = await fn("admin-staff", admin.token, { action: "reset_password", user_id: A.userId });
  check("admin resets A's password: new temporary password, old one stops working", reset.status === 200 && reset.json?.temporary_password?.length === 16 && !(await login(`${A.staffId.toLowerCase()}@company.demo`, A.pw)).ok);
  const relog = await login(`${A.staffId.toLowerCase()}@company.demo`, reset.json.temporary_password);
  check("A signs in with the new temporary password", relog.ok);
  check("...and is locked again by the database until it chooses its own password (F1)", (await rest(relog.token, "conversations?select=id")).json?.length === 0);
  const stillAdminOk = await fn("admin-staff", admin.token, { action: "set_disabled", user_id: A.userId, disabled: false });
  void stillAdminOk;

  // ---- Audit log ---------------------------------------------------------------------------
  const audit = await rest(admin.token, `audit_logs?select=action,target,detail,tenant_id&order=id.desc&limit=60`);
  const actions = new Set((audit.json ?? []).map((a) => a.action));
  for (const a of ["staff.create", "connection.create", "connection.token_set", "connection.disconnect", "connection.reconnect", "tenant.set_status", "staff.disable", "staff.enable", "staff.reset_password"]) {
    check(`audit log has ${a}`, actions.has(a));
  }
  const auditText = JSON.stringify(audit.json);
  check("audit log contains no password or token", !auditText.includes("EAAfaketoken") && !auditText.includes(A.pw) && !auditText.includes(reset.json.temporary_password));
  check("clients still cannot change audit rows", (await rest(A.token, "audit_logs", { method: "DELETE" })).status >= 400);
} catch (error) {
  failed++;
  failures.push(`script error: ${error.message}`);
  console.error("FAIL  script error:", error.message);
} finally {
  // Remove everything this run created (local database only).
  try {
    for (const t of created.tenants) {
      await service(`/rest/v1/webhook_events?connection_id=in.(${created.connections.filter(Boolean).join(",") || "00000000-0000-0000-0000-000000000000"})`, { method: "DELETE" });
      await service(`/rest/v1/conversations?tenant_id=eq.${t}`, { method: "DELETE" });
    }
    for (const c of created.connections.filter(Boolean)) {
      await service("/rest/v1/rpc/revoke_connection_token", { method: "POST", body: { p_connection_id: c, p_status: "revoked" } });
      await service(`/rest/v1/whatsapp_connections?id=eq.${c}`, { method: "DELETE" });
    }
    await service(`/rest/v1/webhook_quarantine?phone_number_id=in.(${[PHONE_A, PHONE_B, UNKNOWN_PHONE].filter(Boolean).join(",")})`, { method: "DELETE" });
    for (const t of created.tenants) await service(`/rest/v1/tenants?id=eq.${t}`, { method: "DELETE" });
    for (const u of created.users) {
      await service(`/rest/v1/push_devices?user_id=eq.${u}`, { method: "DELETE" });
      await http(`/auth/v1/admin/users/${u}`, { method: "DELETE", token: SERVICE, headers: { apikey: SERVICE } });
    }
    console.log("\nCleanup: test clients, connections, chats and logins removed.");
  } catch (e) {
    console.log("\nCleanup warning:", e.message);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log("Failures:\n - " + failures.join("\n - "));
  process.exit(failed ? 1 : 0);
}

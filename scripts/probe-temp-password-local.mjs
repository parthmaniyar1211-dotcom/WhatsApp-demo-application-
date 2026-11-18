#!/usr/bin/env node
// Phase 2.1 regression probe for review finding F1 (docs/PHASE2_1_SECURITY_REPORT.md):
// a login with an administrator-issued temporary password must not reach application data until it has completed
// the server-side password change. Runs against the LOCAL stack only (supabase start + functions serve) with real
// Auth, PostgREST, RPC and Edge Functions, and removes everything it created.
//
// Needs (never printed): SUPABASE_URL, SUPABASE_ANON_KEY, LOCAL_SERVICE_ROLE_KEY.
// Exit code 0 = every check held, 1 = a bypass was found.
const U = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, SVC = process.env.LOCAL_SERVICE_ROLE_KEY;
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(U) || !ANON || !SVC) {
  console.error("Refusing: needs a LOCAL SUPABASE_URL and keys.");
  process.exit(2);
}
const h = (k, t) => ({ apikey: k, Authorization: "Bearer " + (t || k), "Content-Type": "application/json" });
const j = async (p, o = {}) => {
  const r = await fetch(U + p, o);
  const t = await r.text();
  let x = null;
  try { x = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, json: x };
};
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failed++;
};
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const cleanup = { users: [], tenants: [] };

async function makeUser(role, tenantId, clientName) {
  const id = "PRB" + rnd(), email = id.toLowerCase() + "@company.demo", pw = "Temp-" + rnd() + rnd() + "x9";
  const created = await j("/auth/v1/admin/users", { method: "POST", headers: h(SVC), body: JSON.stringify({ email, password: pw, email_confirm: true }) });
  const uid = created.json.id;
  cleanup.users.push(uid);
  const acc = await j("/rest/v1/rpc/create_client_account", {
    method: "POST", headers: h(SVC),
    body: JSON.stringify({ p_user_id: uid, p_staff_id: id, p_display_name: "probe", p_role: role, p_tenant_id: tenantId ?? null, p_client_name: clientName ?? null }),
  });
  if (acc.json?.tenant_id) cleanup.tenants.push(acc.json.tenant_id);
  return { id, uid, email, pw, tenant: acc.json?.tenant_id, mustChange: acc.json?.must_change_password };
}
const signIn = async (u, pw = u.pw) => (await j("/auth/v1/token?grant_type=password", { method: "POST", headers: h(ANON), body: JSON.stringify({ email: u.email, password: pw }) })).json;

try {
  // A client with a real conversation in it, so "no rows" really means "blocked" and not "empty tenant".
  const c = await makeUser("staff", null, "ZZ probe client");
  check("new account is created with the server-side lock set", c.mustChange === true);
  const conn = await j("/rest/v1/whatsapp_connections", { method: "POST", headers: { ...h(SVC), Prefer: "return=representation" }, body: JSON.stringify({ tenant_id: c.tenant, label: "probe", credential_source: "vault", status: "pending", onboarding_method: "manual", phone_number_id: "9" + Date.now() }) });
  const connection = conn.json?.[0]?.id;
  await j("/rest/v1/conversations", { method: "POST", headers: h(SVC), body: JSON.stringify({ tenant_id: c.tenant, connection_id: connection, wa_id: "919800077777", contact_name: "Probe customer" }) });

  const login = await signIn(c);
  const tok = login.access_token;
  check("temporary password signs in (the login itself works)", !!tok);

  const rows = await j("/rest/v1/conversations?select=id", { headers: h(ANON, tok) });
  check("F1.1 locked session reads NO conversations", rows.status === 200 && Array.isArray(rows.json) && rows.json.length === 0, `HTTP ${rows.status}, rows=${rows.json?.length}`);
  const conns = await j("/rest/v1/whatsapp_connections?select=id", { headers: h(ANON, tok) });
  check("F1.1 locked session reads NO connections", Array.isArray(conns.json) && conns.json.length === 0);
  const own = await j("/rest/v1/staff?select=must_change_password&user_id=eq." + c.uid, { headers: h(ANON, tok) });
  check("locked session can read its own staff row (so the app can show the password screen)", own.json?.[0]?.must_change_password === true);

  const start = await j("/rest/v1/rpc/start_conversation", { method: "POST", headers: h(ANON, tok), body: JSON.stringify({ p_phone: "919800099999", p_name: "x" }) });
  check("F1.1 locked session cannot start a conversation", start.status >= 400, `HTTP ${start.status}`);

  const flip = await j("/auth/v1/user", { method: "PUT", headers: h(ANON, tok), body: JSON.stringify({ data: { must_change_password: false } }) });
  void flip;
  const afterFlip = await j("/rest/v1/conversations?select=id", { headers: h(ANON, tok) });
  check("F1.2 writing user_metadata does not unlock", afterFlip.json?.length === 0);
  const patch = await j("/rest/v1/staff?user_id=eq." + c.uid, { method: "PATCH", headers: { ...h(ANON, tok), Prefer: "return=representation" }, body: JSON.stringify({ must_change_password: false }) });
  const still = await j("/rest/v1/staff?select=must_change_password&user_id=eq." + c.uid, { headers: h(SVC) });
  check("F1.2 PATCH on staff cannot clear the flag", patch.status >= 400 && still.json?.[0]?.must_change_password === true, `HTTP ${patch.status}`);
  const rpc = await j("/rest/v1/rpc/set_must_change_password", { method: "POST", headers: h(ANON, tok), body: JSON.stringify({ p_user_id: c.uid, p_value: false }) });
  check("F1.2 set_must_change_password is not callable by the login", rpc.status >= 400, `HTTP ${rpc.status}`);
  const app = await j("/auth/v1/user", { method: "PUT", headers: h(ANON, tok), body: JSON.stringify({ app_metadata: { role: "admin" } }) });
  check("F1.3 client cannot write app_metadata", app.status === 403 || app.status === 422, `HTTP ${app.status}`);
  const plain = await j("/auth/v1/user", { method: "PUT", headers: h(ANON, tok), body: JSON.stringify({ password: "Another-pass-" + rnd() }) });
  const stillAfterPw = await j("/rest/v1/conversations?select=id", { headers: h(ANON, tok) });
  check("F1.4 changing the password with Auth's own endpoint does NOT unlock (only the server function does)", stillAfterPw.json?.length === 0, `auth HTTP ${plain.status}`);

  const send = await j("/functions/v1/send-whatsapp", { method: "POST", headers: h(ANON, tok), body: JSON.stringify({ conversation_id: "00000000-0000-4000-8000-000000000000", text: "hi" }) });
  check("F1.5 locked session cannot send", send.status >= 400, `HTTP ${send.status}`);

  // The secure flow. The password above may have changed through Auth, so use a fresh account for it.
  const d = await makeUser("staff", null, "ZZ probe client two");
  const dl = await signIn(d);
  const wrong = await j("/functions/v1/complete-password-change", { method: "POST", headers: h(ANON, dl.access_token), body: JSON.stringify({ new_password: d.pw }) });
  check("F1.6 reusing the temporary password is refused", wrong.status === 400 && wrong.json?.code === "same_as_temporary", `HTTP ${wrong.status}`);
  const short = await j("/functions/v1/complete-password-change", { method: "POST", headers: h(ANON, dl.access_token), body: JSON.stringify({ new_password: "short" }) });
  check("F1.6 a short password is refused", short.status === 400);
  const noAuth = await j("/functions/v1/complete-password-change", { method: "POST", headers: h(ANON), body: JSON.stringify({ new_password: "Brand-new-" + rnd() }) });
  check("F1.6 anonymous caller is refused", noAuth.status === 401 || noAuth.status === 403, `HTTP ${noAuth.status}`);
  const newPw = "Brand-new-" + rnd() + "!";
  const done = await j("/functions/v1/complete-password-change", { method: "POST", headers: h(ANON, dl.access_token), body: JSON.stringify({ new_password: newPw }) });
  check("F1.7 the server accepts a valid new password", done.status === 200 && done.json?.ok === true, `HTTP ${done.status}`);
  const flagNow = await j("/rest/v1/staff?select=must_change_password&user_id=eq." + d.uid, { headers: h(SVC) });
  check("F1.7 the lock is lifted by the server", flagNow.json?.[0]?.must_change_password === false);
  const relogin = await signIn(d, newPw);
  check("F1.7 the new password signs in", !!relogin.access_token);
  const oldLogin = await signIn(d, d.pw);
  check("F1.7 the temporary password no longer works", !oldLogin.access_token);
  const second = await j("/functions/v1/complete-password-change", { method: "POST", headers: h(ANON, relogin.access_token), body: JSON.stringify({ new_password: "Yet-another-" + rnd() }) });
  check("F1.8 a normal login cannot use the unlock function again", second.status === 409, `HTTP ${second.status}`);

  // A temporary-password ADMIN gets no admin power either.
  const a = await makeUser("admin");
  const al = await signIn(a);
  const overview = await j("/rest/v1/rpc/admin_overview", { method: "POST", headers: h(ANON, al.access_token), body: "{}" });
  check("F1.9 locked admin cannot call admin RPCs", overview.status >= 400, `HTTP ${overview.status}`);
  const adm = await j("/functions/v1/admin-staff", { method: "POST", headers: h(ANON, al.access_token), body: JSON.stringify({ action: "create", client_name: "Should not exist" }) });
  check("F1.9 locked admin cannot create accounts", adm.status === 403, `HTTP ${adm.status} ${adm.json?.code ?? ""}`);
  const diag = await j("/rest/v1/rpc/admin_routing_diagnostics", { method: "POST", headers: h(ANON, al.access_token), body: "{}" });
  check("F1.9 locked admin cannot read routing diagnostics", diag.status >= 400, `HTTP ${diag.status}`);
} finally {
  for (const t of cleanup.tenants) {
    await j("/rest/v1/audit_logs?tenant_id=eq." + t, { method: "DELETE", headers: h(SVC) }); // insert-only for clients, cleanable by the service role locally
    await j("/rest/v1/wa_messages?tenant_id=eq." + t, { method: "DELETE", headers: h(SVC) });
    await j("/rest/v1/conversations?tenant_id=eq." + t, { method: "DELETE", headers: h(SVC) });
    await j("/rest/v1/whatsapp_connections?tenant_id=eq." + t, { method: "DELETE", headers: h(SVC) });
  }
  for (const u of cleanup.users) await j("/auth/v1/admin/users/" + u, { method: "DELETE", headers: h(SVC) });
  for (const t of cleanup.tenants) await j("/rest/v1/tenants?id=eq." + t, { method: "DELETE", headers: h(SVC) });
  console.log("cleaned up");
}
console.log(failed === 0 ? "\nALL F1 CHECKS HELD" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

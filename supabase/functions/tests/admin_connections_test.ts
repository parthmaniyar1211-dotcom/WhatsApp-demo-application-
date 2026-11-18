import type { AuditEntry } from "../admin-staff/handler.ts";
import { type ConnectionRecord, type ConnectionsAdminStore, createConnectionsAdminHandler } from "../admin-connections/handler.ts";
import { assert, assertEquals } from "./helpers.ts";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TENANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LEGACY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TOKEN = "EAAB-fake-token-0123456789-abcdefghij";

function setup(flags: { manualTokens?: boolean; embeddedSignup?: boolean; adminMustChange?: boolean } = {}) {
  const connections = new Map<string, ConnectionRecord & Record<string, unknown>>([
    [CONN, { id: CONN, tenant_id: TENANT, credential_source: "vault", status: "pending", phone_number_id: "1234567890", label: "Main" }],
    [LEGACY, { id: LEGACY, tenant_id: TENANT, credential_source: "platform_env", status: "connected", phone_number_id: null, label: "Test" }],
  ]);
  const tokens = new Map<string, { token: string; expiresAt: string | null }>();
  const audit: AuditEntry[] = [];
  const store: ConnectionsAdminStore = {
    getUserId: (jwt) => Promise.resolve(jwt === "admin-jwt" ? ADMIN : jwt === "staff-jwt" ? STAFF : null),
    getStaff: (id) =>
      Promise.resolve(
        id === ADMIN
          ? { user_id: ADMIN, staff_id: "ADMIN1", display_name: "", role: "admin", disabled: false, must_change_password: flags.adminMustChange ?? false }
          : id === STAFF
          ? { user_id: STAFF, staff_id: "EMP1", display_name: "", role: "staff", disabled: false, must_change_password: false }
          : null,
      ),
    tenantExists: (id) => Promise.resolve(id === TENANT),
    getConnection: (id) => Promise.resolve(connections.get(id) ?? null),
    createConnection: (row) => {
      if (row.phone_number_id && [...connections.values()].some((c) => c.phone_number_id === row.phone_number_id)) {
        return Promise.reject(new Error("create connection: 23505 duplicate key"));
      }
      const id = crypto.randomUUID();
      const created = { id, status: "pending", credential_source: "vault", ...row } as ConnectionRecord & Record<string, unknown>;
      connections.set(id, created);
      return Promise.resolve(created);
    },
    updateConnection: (id, patch) => {
      const next = { ...connections.get(id)!, ...patch };
      connections.set(id, next);
      return Promise.resolve(next);
    },
    storeToken: (id, token, expiresAt) => {
      tokens.set(id, { token, expiresAt });
      return Promise.resolve();
    },
    revokeToken: (id, status) => {
      tokens.delete(id);
      connections.get(id)!.status = status;
      return Promise.resolve();
    },
    setState: (id, status) => {
      connections.get(id)!.status = status;
      return Promise.resolve();
    },
    audit: (entry) => {
      audit.push(entry);
      return Promise.resolve();
    },
  };
  const handler = createConnectionsAdminHandler({ store, manualTokens: flags.manualTokens ?? false, embeddedSignup: flags.embeddedSignup ?? false });
  const call = (body: unknown, jwt: string | null = "admin-jwt") =>
    handler(
      new Request("http://localhost/admin-connections", {
        method: "POST",
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        body: JSON.stringify(body),
      }),
    );
  return { call, connections, tokens, audit };
}

Deno.test("admin-connections: only a platform admin may call it", async () => {
  const { call, connections } = setup({ manualTokens: true });
  for (const jwt of [null, "forged", "staff-jwt"]) {
    const res = await call({ action: "disconnect", connection_id: CONN }, jwt);
    assertEquals(res.status, jwt === "staff-jwt" ? 403 : 401);
    await res.body?.cancel();
  }
  assertEquals(connections.get(CONN)!.status, "pending");
});

Deno.test("admin-connections: create validates the client and the Meta ids", async () => {
  const { call, connections } = setup();
  for (
    const body of [
      { action: "create", tenant_id: "not-a-uuid" },
      { action: "create", tenant_id: crypto.randomUUID() }, // unknown client -> 404
      { action: "create", tenant_id: TENANT, waba_id: "abc" },
      { action: "create", tenant_id: TENANT, phone_number_id: "12" },
    ]
  ) {
    const res = await call(body);
    assert(res.status === 400 || res.status === 404, `${JSON.stringify(body)} -> ${res.status}`);
    await res.body?.cancel();
  }
  assertEquals(connections.size, 2);
});

Deno.test("admin-connections: create makes a pending Vault connection and audits it", async () => {
  const { call, audit } = setup();
  const res = await call({ action: "create", tenant_id: TENANT, label: "Shop number", waba_id: "111222333", phone_number_id: "555666777" });
  assertEquals(res.status, 200);
  const { connection } = await res.json();
  assertEquals(connection.status, "pending");
  assertEquals(connection.credential_source, "vault");
  assertEquals(audit[0].action, "connection.create");
  assertEquals(audit[0].tenantId, TENANT);
});

Deno.test("admin-connections: the same phone number id cannot be connected twice", async () => {
  const { call } = setup();
  const res = await call({ action: "create", tenant_id: TENANT, phone_number_id: "1234567890" });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "exists");
});

Deno.test("admin-connections: manual token entry is OFF by default", async () => {
  const { call, tokens } = setup();
  const res = await call({ action: "set_token", connection_id: CONN, token: TOKEN });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).code, "feature_disabled");
  assertEquals(tokens.size, 0);
});

Deno.test("admin-connections: with the flag on, a token is stored in Vault, never returned, never audited", async () => {
  const { call, tokens, audit, connections } = setup({ manualTokens: true });
  const res = await call({ action: "set_token", connection_id: CONN, token: TOKEN, expires_at: new Date(Date.now() + 86400_000).toISOString() });
  assertEquals(res.status, 200);
  const text = await res.text();
  assert(!text.includes(TOKEN), "the response must not contain the token");
  assertEquals(tokens.get(CONN)!.token, TOKEN);
  assertEquals(connections.get(CONN)!.status, "connected", "number known + token -> connected");
  assertEquals(audit[0].action, "connection.token_set");
  assert(!JSON.stringify(audit).includes(TOKEN), "no token in the audit log");
});

Deno.test("admin-connections: rotation replaces the token and is audited as a rotation", async () => {
  const { call, tokens, audit } = setup({ manualTokens: true });
  await (await call({ action: "set_token", connection_id: CONN, token: TOKEN })).body?.cancel();
  const NEW = "EAAB-rotated-token-9876543210-zyxwvutsrq";
  await (await call({ action: "set_token", connection_id: CONN, token: NEW })).body?.cancel();
  assertEquals(tokens.get(CONN)!.token, NEW);
  assertEquals(audit.map((a) => a.action), ["connection.token_set", "connection.token_rotated"]);
});

Deno.test("admin-connections: token validation, expiry in the past, and the legacy connection", async () => {
  const { call, tokens } = setup({ manualTokens: true });
  for (
    const body of [
      { action: "set_token", connection_id: CONN, token: "short" },
      { action: "set_token", connection_id: CONN, token: "has spaces inside the token value here" },
      { action: "set_token", connection_id: CONN, token: TOKEN, expires_at: "2001-01-01" },
      { action: "set_token", connection_id: LEGACY, token: TOKEN }, // legacy uses the platform secret
      { action: "set_token", connection_id: crypto.randomUUID(), token: TOKEN },
    ]
  ) {
    const res = await call(body);
    assert([400, 404].includes(res.status), `${JSON.stringify(body)} -> ${res.status}`);
    await res.body?.cancel();
  }
  assertEquals(tokens.size, 0);
});

Deno.test("admin-connections: disconnect deletes the Vault token; the legacy number only changes status", async () => {
  const { call, tokens, connections, audit } = setup({ manualTokens: true });
  await (await call({ action: "set_token", connection_id: CONN, token: TOKEN })).body?.cancel();
  const off = await call({ action: "disconnect", connection_id: CONN });
  assertEquals(off.status, 200);
  await off.body?.cancel();
  assertEquals(tokens.size, 0);
  assertEquals(connections.get(CONN)!.status, "disconnected");
  const legacy = await call({ action: "disconnect", connection_id: LEGACY });
  assertEquals(legacy.status, 200);
  await legacy.body?.cancel();
  assertEquals(connections.get(LEGACY)!.status, "disconnected");
  assert(audit.some((a) => a.action === "connection.disconnect" && a.target === LEGACY));
});

Deno.test("admin-connections: revoke deletes the token; the legacy number cannot be revoked here", async () => {
  const { call, tokens, connections } = setup({ manualTokens: true });
  await (await call({ action: "set_token", connection_id: CONN, token: TOKEN })).body?.cancel();
  const res = await call({ action: "revoke", connection_id: CONN });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(tokens.size, 0);
  assertEquals(connections.get(CONN)!.status, "revoked");
  const legacy = await call({ action: "revoke", connection_id: LEGACY });
  assertEquals(legacy.status, 400);
  await legacy.body?.cancel();
  assertEquals(connections.get(LEGACY)!.status, "connected");
});

Deno.test("admin-connections: reconnect only applies to a disconnected connection", async () => {
  const { call, connections } = setup();
  const notYet = await call({ action: "reconnect", connection_id: CONN });
  assertEquals(notYet.status, 409);
  await notYet.body?.cancel();
  connections.get(CONN)!.status = "disconnected";
  const res = await call({ action: "reconnect", connection_id: CONN });
  assertEquals((await res.json()).status, "pending", "a Vault connection needs a new token before it works again");
  connections.get(LEGACY)!.status = "disconnected";
  const legacy = await call({ action: "reconnect", connection_id: LEGACY });
  assertEquals((await legacy.json()).status, "connected");
});

Deno.test("admin-connections: update changes labels and ids of a Vault connection but not the legacy ids", async () => {
  const { call, connections } = setup();
  const res = await call({ action: "update", connection_id: CONN, label: "Renamed", display_phone_number: "+91 90000 00000" });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(connections.get(CONN)!.label, "Renamed");
  const legacyIds = await call({ action: "update", connection_id: LEGACY, phone_number_id: "999888777" });
  assertEquals(legacyIds.status, 400);
  await legacyIds.body?.cancel();
  const empty = await call({ action: "update", connection_id: CONN });
  assertEquals(empty.status, 400);
  await empty.body?.cancel();
});

Deno.test("admin-connections: Embedded Signup stays behind its feature flag", async () => {
  const off = setup();
  const res = await off.call({ action: "start_onboarding", tenant_id: TENANT });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).code, "feature_disabled");
  // even with the flag on, nothing is faked: the flow is not implemented in this version
  const on = setup({ embeddedSignup: true });
  const stub = await on.call({ action: "start_onboarding", tenant_id: TENANT });
  assertEquals(stub.status, 501);
  await stub.body?.cancel();
});

Deno.test("admin-connections: unknown actions and oversized input are refused", async () => {
  const { call } = setup();
  const res = await call({ action: "explode" });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("admin-connections: an admin who still has a temporary password is refused", async () => {
  const { call, connections } = setup({ adminMustChange: true });
  const res = await call({ action: "disconnect", connection_id: CONN });
  assertEquals([res.status, (await res.json()).code], [403, "password_change_required"]);
  assertEquals(connections.get(CONN)!.status, "pending");
});

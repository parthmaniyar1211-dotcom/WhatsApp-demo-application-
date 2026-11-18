import { type AdminStaffRow, type AdminStore, type AuditEntry, createAdminHandler, generateFrom } from "../admin-staff/handler.ts";
import { assert, assertEquals } from "./helpers.ts";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TENANT_OF_STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function setup(options: { failInsert?: boolean; randomBytes?: (n: number) => Uint8Array } = {}) {
  const staff = new Map<string, AdminStaffRow>([
    [ADMIN, { user_id: ADMIN, staff_id: "ADMIN1", display_name: "Admin", role: "admin", disabled: false, must_change_password: false }],
    [STAFF, { user_id: STAFF, staff_id: "EMP1001", display_name: "Asha", role: "staff", disabled: false, must_change_password: false }],
  ]);
  const tenantOf = new Map<string, string>([[STAFF, TENANT_OF_STAFF]]);
  const tenants = new Map<string, string>([[TENANT_OF_STAFF, "Existing client"]]);
  const accounts: Array<{ user_id: string; tenant_id: string | null; membership_role: string; client_name: string | null }> = [];
  const users = new Map<string, { email: string; password: string; banned: boolean; mustChange: boolean }>();
  const audit: AuditEntry[] = [];
  const store: AdminStore = {
    getUserId: (jwt) => Promise.resolve(jwt === "admin-jwt" ? ADMIN : jwt === "staff-jwt" ? STAFF : null),
    getStaff: (id) => Promise.resolve(staff.get(id) ?? null),
    createAuthUser: (email, password) => {
      for (const u of users.values()) if (u.email === email) return Promise.resolve(null);
      const id = crypto.randomUUID();
      users.set(id, { email, password, banned: false, mustChange: false });
      return Promise.resolve(id);
    },
    deleteAuthUser: (id) => {
      users.delete(id);
      return Promise.resolve();
    },
    staffIdExists: (staffId) => Promise.resolve([...staff.values()].some((s) => s.staff_id === staffId)),
    createAccount: (row) => {
      if (options.failInsert) return Promise.reject(new Error("insert failed"));
      let tenantId = row.tenant_id;
      if (!tenantId && row.client_name) {
        tenantId = crypto.randomUUID();
        tenants.set(tenantId, row.client_name);
      }
      if (tenantId && !tenants.has(tenantId)) return Promise.reject(new Error("tenant not found"));
      const full = { user_id: row.user_id, staff_id: row.staff_id, display_name: row.display_name, role: row.role, disabled: false, must_change_password: row.must_change_password };
      staff.set(row.user_id, full);
      if (tenantId) tenantOf.set(row.user_id, tenantId);
      const created = users.get(row.user_id);
      if (created) created.mustChange = row.must_change_password;
      accounts.push({ user_id: row.user_id, tenant_id: tenantId, membership_role: row.membership_role, client_name: row.client_name });
      return Promise.resolve({ ...full, tenant_id: tenantId });
    },
    getTenantId: (id) => Promise.resolve(tenantOf.get(id) ?? null),
    setDisabled: (id, disabled) => {
      const row = staff.get(id)!;
      row.disabled = disabled;
      return Promise.resolve(row);
    },
    setBanned: (id, banned) => {
      const user = users.get(id);
      if (user) user.banned = banned;
      return Promise.resolve();
    },
    setPassword: (id, password, mustChange) => {
      const user = users.get(id);
      users.set(id, { email: user?.email ?? "", password, banned: user?.banned ?? false, mustChange });
      return Promise.resolve();
    },
    audit: (entry) => {
      audit.push(entry);
      return Promise.resolve();
    },
  };
  const handler = createAdminHandler({ store, emailDomain: "company.demo", randomBytes: options.randomBytes });
  const call = (body: unknown, jwt: string | null = "admin-jwt") =>
    handler(
      new Request("http://localhost/admin-staff", {
        method: "POST",
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        body: JSON.stringify(body),
      }),
    );
  return { call, staff, users, tenants, accounts, audit, tenantOf };
}

const NEW_CLIENT = { client_name: "Acme Traders" };

Deno.test("admin-staff: unauthenticated is 401, non-admin is 403", async () => {
  const { call, users } = setup();
  const body = { action: "create", staff_id: "EMP2000", password: "password123", ...NEW_CLIENT };
  const anonymous = await call(body, null);
  assertEquals(anonymous.status, 401);
  await anonymous.body?.cancel();
  const staff = await call(body, "staff-jwt");
  assertEquals(staff.status, 403);
  await staff.body?.cancel();
  assertEquals(users.size, 0);
});

Deno.test("admin-staff: disabled admin is 403", async () => {
  const { call, staff } = setup();
  staff.get(ADMIN)!.disabled = true;
  const res = await call({ action: "create", staff_id: "EMP2000", password: "password123", ...NEW_CLIENT });
  assertEquals(res.status, 403);
  await res.body?.cancel();
});

Deno.test("admin-staff: create maps EMP1002 to emp1002@company.demo and creates the client's tenant", async () => {
  const { call, users, staff, tenants, accounts } = setup();
  const res = await call({ action: "create", staff_id: " emp1002 ", password: "password123", display_name: "Ravi", ...NEW_CLIENT });
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.staff.staff_id, "EMP1002");
  assertEquals(data.staff.role, "staff");
  assertEquals([...users.values()][0].email, "emp1002@company.demo");
  assert(staff.has(data.staff.user_id));
  assert(data.staff.tenant_id, "the account belongs to a tenant");
  assertEquals(tenants.get(data.staff.tenant_id), "Acme Traders");
  assertEquals(accounts[0].membership_role, "owner");
  assertEquals("temporary_password" in data, false, "a password the admin chose is not echoed back");
  assertEquals([...users.values()][0].mustChange, true, "the first login must change the password");
});

Deno.test("admin-staff: without a password a random temporary one is generated and returned once", async () => {
  const { call, users } = setup();
  const res = await call({ action: "create", ...NEW_CLIENT });
  assertEquals(res.status, 200);
  const data = await res.json();
  assert(/^CC[A-Z2-9]{6}$/.test(data.staff.staff_id), `generated Staff ID ${data.staff.staff_id}`);
  assert(typeof data.temporary_password === "string" && data.temporary_password.length === 16);
  assert(/^[A-Za-z2-9]+$/.test(data.temporary_password), "no look-alike characters (0, O, 1, l, I)");
  const user = [...users.values()][0];
  assertEquals(user.password, data.temporary_password);
  assertEquals(user.mustChange, true);
});

Deno.test("admin-staff: generated Staff IDs are unique even when a candidate is taken", async () => {
  // First candidate is "CC" + AAAAAA (all bytes 0 -> first alphabet char), which EXISTS; the next is different.
  const queue = [new Uint8Array(12), new Uint8Array(12).fill(1), new Uint8Array(32).fill(2)];
  const { call, staff } = setup({ randomBytes: () => queue.shift() ?? new Uint8Array(32).fill(3) });
  staff.set("x", { user_id: "x", staff_id: "CCAAAAAA", display_name: "", role: "staff", disabled: false, must_change_password: false });
  const res = await call({ action: "create", password: "password123", ...NEW_CLIENT });
  assertEquals(res.status, 200);
  const data = await res.json();
  assert(data.staff.staff_id !== "CCAAAAAA");
});

Deno.test("admin-staff: generator has no modulo bias and only uses the alphabet", () => {
  const out = generateFrom("AB", 50, (n) => new Uint8Array(n).map((_, i) => (i * 37) % 256));
  assertEquals(out.length, 50);
  assert(/^[AB]+$/.test(out));
});

Deno.test("admin-staff: a staff login needs a client name or an existing tenant, never both", async () => {
  const { call, users } = setup();
  for (
    const body of [
      { action: "create", staff_id: "EMP6000", password: "password123" },
      { action: "create", staff_id: "EMP6000", password: "password123", tenant_id: crypto.randomUUID(), client_name: "X" },
      { action: "create", staff_id: "EMP6000", password: "password123", tenant_id: "not-a-uuid" },
    ]
  ) {
    const res = await call(body);
    assertEquals(res.status, 400, JSON.stringify(body));
    await res.body?.cancel();
  }
  assertEquals(users.size, 0);
});

Deno.test("admin-staff: another login for an existing client joins its tenant as an agent", async () => {
  const { call, accounts } = setup();
  const res = await call({ action: "create", staff_id: "EMP7000", password: "password123", tenant_id: TENANT_OF_STAFF });
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.staff.tenant_id, TENANT_OF_STAFF);
  assertEquals(accounts[0].membership_role, "agent");
  const unknown = await call({ action: "create", staff_id: "EMP7001", password: "password123", tenant_id: crypto.randomUUID() });
  assertEquals(unknown.status, 500, "an unknown tenant is refused by the database");
  await unknown.body?.cancel();
});

Deno.test("admin-staff: a platform admin can be created without a tenant", async () => {
  const { call, accounts } = setup();
  const res = await call({ action: "create", staff_id: "OPS1", password: "password123", role: "admin" });
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.staff.role, "admin");
  assertEquals(data.staff.tenant_id, null);
  assertEquals(accounts[0].tenant_id, null);
});

Deno.test("admin-staff: create validates id, password and role", async () => {
  const { call, users } = setup();
  for (
    const body of [
      { action: "create", staff_id: "a b", password: "password123", ...NEW_CLIENT },
      { action: "create", staff_id: "EMP1@x", password: "password123", ...NEW_CLIENT },
      { action: "create", staff_id: "EMP3000", password: "short", ...NEW_CLIENT },
      { action: "create", staff_id: "EMP3000", password: "password123", role: "owner", ...NEW_CLIENT },
      { action: "nope" },
    ]
  ) {
    const res = await call(body);
    assertEquals(res.status, 400, JSON.stringify(body));
    await res.body?.cancel();
  }
  assertEquals(users.size, 0);
});

Deno.test("admin-staff: duplicate staff id is 409", async () => {
  const { call } = setup();
  const first = await call({ action: "create", staff_id: "EMP4000", password: "password123", ...NEW_CLIENT });
  assertEquals(first.status, 200);
  await first.body?.cancel();
  const second = await call({ action: "create", staff_id: "emp4000", password: "password123", ...NEW_CLIENT });
  assertEquals(second.status, 409);
  await second.body?.cancel();
});

Deno.test("admin-staff: auth user is removed again when the account (staff row + tenant) cannot be created", async () => {
  const { call, users, audit } = setup({ failInsert: true });
  const res = await call({ action: "create", staff_id: "EMP5000", password: "password123", ...NEW_CLIENT });
  assertEquals(res.status, 500);
  await res.body?.cancel();
  assertEquals(users.size, 0);
  assertEquals(audit.length, 0, "a failed creation leaves no audit entry claiming success");
});

Deno.test("admin-staff: disable and enable", async () => {
  const { call, staff } = setup();
  const off = await call({ action: "set_disabled", user_id: STAFF, disabled: true });
  assertEquals(off.status, 200);
  await off.body?.cancel();
  assertEquals(staff.get(STAFF)!.disabled, true);
  const on = await call({ action: "set_disabled", user_id: STAFF, disabled: false });
  assertEquals(on.status, 200);
  await on.body?.cancel();
  assertEquals(staff.get(STAFF)!.disabled, false);
});

Deno.test("admin-staff: an admin cannot disable themselves", async () => {
  const { call, staff } = setup();
  const res = await call({ action: "set_disabled", user_id: ADMIN, disabled: true });
  assertEquals(res.status, 400);
  await res.body?.cancel();
  assertEquals(staff.get(ADMIN)!.disabled, false);
});

Deno.test("admin-staff: reset password (chosen by the admin)", async () => {
  const { call, users } = setup();
  const res = await call({ action: "reset_password", user_id: STAFF, password: "new-password-1" });
  assertEquals(res.status, 200);
  assertEquals("temporary_password" in (await res.json()), false);
  assertEquals(users.get(STAFF)!.password, "new-password-1");
  assertEquals(users.get(STAFF)!.mustChange, true, "a reset password is temporary too");
  const weak = await call({ action: "reset_password", user_id: STAFF, password: "123" });
  assertEquals(weak.status, 400);
  await weak.body?.cancel();
  const unknown = await call({ action: "reset_password", user_id: crypto.randomUUID(), password: "new-password-1" });
  assertEquals(unknown.status, 404);
  await unknown.body?.cancel();
});

Deno.test("admin-staff: reset password without a password generates a temporary one, returned once", async () => {
  const { call, users } = setup();
  const res = await call({ action: "reset_password", user_id: STAFF });
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.temporary_password.length, 16);
  assertEquals(users.get(STAFF)!.password, data.temporary_password);
});

Deno.test("admin-staff: every administrative action is audited with its client, and passwords never are", async () => {
  const { call, audit } = setup();
  const created = await (await call({ action: "create", staff_id: "EMP8000", password: "very-secret-pw-1", ...NEW_CLIENT })).json();
  await (await call({ action: "set_disabled", user_id: STAFF, disabled: true })).body?.cancel();
  await (await call({ action: "set_disabled", user_id: STAFF, disabled: false })).body?.cancel();
  await (await call({ action: "reset_password", user_id: STAFF, password: "another-secret-2" })).body?.cancel();
  assertEquals(audit.map((a) => a.action), ["staff.create", "staff.disable", "staff.enable", "staff.reset_password"]);
  assertEquals(audit[0].tenantId, created.staff.tenant_id);
  assertEquals(audit[1].tenantId, TENANT_OF_STAFF);
  assert(audit.every((a) => a.actorUserId === ADMIN));
  const everything = JSON.stringify(audit);
  assert(!everything.includes("very-secret-pw-1") && !everything.includes("another-secret-2"), "no password in the audit log");
});

Deno.test("admin-staff: an admin who still has a temporary password is refused, nothing is created", async () => {
  const { call, staff, accounts } = setup();
  staff.get(ADMIN)!.must_change_password = true;
  const res = await call({ action: "create", client_name: "Acme" });
  assertEquals([res.status, (await res.json()).code], [403, "password_change_required"]);
  assertEquals(accounts.length, 0);
});

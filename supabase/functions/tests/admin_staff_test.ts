import { type AdminStaffRow, type AdminStore, createAdminHandler } from "../admin-staff/handler.ts";
import { assert, assertEquals } from "./helpers.ts";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup(options: { failInsert?: boolean } = {}) {
  const staff = new Map<string, AdminStaffRow>([
    [ADMIN, { user_id: ADMIN, staff_id: "ADMIN1", display_name: "Admin", role: "admin", disabled: false }],
    [STAFF, { user_id: STAFF, staff_id: "EMP1001", display_name: "Asha", role: "staff", disabled: false }],
  ]);
  const users = new Map<string, { email: string; password: string; banned: boolean }>();
  const store: AdminStore = {
    getUserId: (jwt) => Promise.resolve(jwt === "admin-jwt" ? ADMIN : jwt === "staff-jwt" ? STAFF : null),
    getStaff: (id) => Promise.resolve(staff.get(id) ?? null),
    createAuthUser: (email, password) => {
      for (const u of users.values()) if (u.email === email) return Promise.resolve(null);
      const id = crypto.randomUUID();
      users.set(id, { email, password, banned: false });
      return Promise.resolve(id);
    },
    deleteAuthUser: (id) => {
      users.delete(id);
      return Promise.resolve();
    },
    insertStaff: (row) => {
      if (options.failInsert) return Promise.reject(new Error("insert failed"));
      const full = { ...row, disabled: false };
      staff.set(row.user_id, full);
      return Promise.resolve(full);
    },
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
    setPassword: (id, password) => {
      users.set(id, { email: users.get(id)?.email ?? "", password, banned: false });
      return Promise.resolve();
    },
  };
  const handler = createAdminHandler({ store, emailDomain: "company.demo" });
  const call = (body: unknown, jwt: string | null = "admin-jwt") =>
    handler(
      new Request("http://localhost/admin-staff", {
        method: "POST",
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        body: JSON.stringify(body),
      }),
    );
  return { call, staff, users };
}

Deno.test("admin-staff: unauthenticated is 401, non-admin is 403", async () => {
  const { call, users } = setup();
  const body = { action: "create", staff_id: "EMP2000", password: "password123" };
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
  const res = await call({ action: "create", staff_id: "EMP2000", password: "password123" });
  assertEquals(res.status, 403);
  await res.body?.cancel();
});

Deno.test("admin-staff: create maps EMP1002 to emp1002@company.demo", async () => {
  const { call, users, staff } = setup();
  const res = await call({ action: "create", staff_id: " emp1002 ", password: "password123", display_name: "Ravi" });
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.staff.staff_id, "EMP1002");
  assertEquals(data.staff.role, "staff");
  assertEquals([...users.values()][0].email, "emp1002@company.demo");
  assert(staff.has(data.staff.user_id));
});

Deno.test("admin-staff: create validates id, password and role", async () => {
  const { call, users } = setup();
  for (
    const body of [
      { action: "create", staff_id: "a b", password: "password123" },
      { action: "create", staff_id: "EMP1@x", password: "password123" },
      { action: "create", staff_id: "EMP3000", password: "short" },
      { action: "create", staff_id: "EMP3000", password: "password123", role: "owner" },
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
  const first = await call({ action: "create", staff_id: "EMP4000", password: "password123" });
  assertEquals(first.status, 200);
  await first.body?.cancel();
  const second = await call({ action: "create", staff_id: "emp4000", password: "password123" });
  assertEquals(second.status, 409);
  await second.body?.cancel();
});

Deno.test("admin-staff: auth user is removed again when the staff row cannot be created", async () => {
  const { call, users } = setup({ failInsert: true });
  const res = await call({ action: "create", staff_id: "EMP5000", password: "password123" });
  assertEquals(res.status, 500);
  await res.body?.cancel();
  assertEquals(users.size, 0);
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

Deno.test("admin-staff: reset password", async () => {
  const { call, users } = setup();
  const res = await call({ action: "reset_password", user_id: STAFF, password: "new-password-1" });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(users.get(STAFF)!.password, "new-password-1");
  const weak = await call({ action: "reset_password", user_id: STAFF, password: "123" });
  assertEquals(weak.status, 400);
  await weak.body?.cancel();
  const unknown = await call({ action: "reset_password", user_id: crypto.randomUUID(), password: "new-password-1" });
  assertEquals(unknown.status, 404);
  await unknown.body?.cancel();
});

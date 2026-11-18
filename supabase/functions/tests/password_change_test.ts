import { createPasswordHandler, MAX_ATTEMPTS, type PasswordStaff, type PasswordStore, type PasswordUser } from "../complete-password-change/handler.ts";
import { createReplayHandler, type ReplayStaff } from "../webhook-replay/handler.ts";
import type { WebhookDeps } from "../whatsapp-webhook/handler.ts";
import { assert, assertEquals } from "./helpers.ts";

const NOW = 1_800_000_000_000;
const TEMP = "TempPass1234abcd";

function setup(opts: { staff?: Partial<PasswordStaff> | null; iatAgeSeconds?: number | null; failClear?: boolean } = {}) {
  const state = { password: TEMP, mustChange: true, clearCalls: 0, signedOut: 0, audit: [] as Array<Record<string, unknown>> };
  const user: PasswordUser = {
    id: "u1",
    email: "emp1@company.demo",
    issuedAt: opts.iatAgeSeconds === null ? null : NOW / 1000 - (opts.iatAgeSeconds ?? 60),
  };
  const store: PasswordStore = {
    getUserFromJwt: (jwt) => Promise.resolve(jwt === "jwt" ? { ...user, id: "u" + crypto.randomUUID() } : null),
    getStaff: () =>
      Promise.resolve(
        opts.staff === null ? null : { staff_id: "EMP1", disabled: false, must_change_password: state.mustChange, ...opts.staff },
      ),
    getTenantId: () => Promise.resolve("t1"),
    passwordMatches: (_e, p) => Promise.resolve(p === state.password),
    setPassword: (_id, p) => {
      state.password = p;
      return Promise.resolve();
    },
    clearMustChange: () => {
      state.clearCalls++;
      if (opts.failClear) return Promise.reject(new Error("db down"));
      state.mustChange = false;
      return Promise.resolve();
    },
    signOutOthers: () => {
      state.signedOut++;
      return Promise.resolve();
    },
    audit: (e) => {
      state.audit.push(e as unknown as Record<string, unknown>);
      return Promise.resolve();
    },
  };
  const handler = createPasswordHandler({ store, now: () => NOW });
  const call = (body: unknown, jwt: string | null = "jwt") =>
    handler(new Request("http://x/complete-password-change", {
      method: "POST",
      body: JSON.stringify(body),
      headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
    }));
  return { state, call };
}

Deno.test("password change: needs a valid session", async () => {
  const { call } = setup();
  assertEquals((await call({ new_password: "BrandNewPass9" }, null)).status, 401);
  assertEquals((await call({ new_password: "BrandNewPass9" }, "bad")).status, 401);
});

Deno.test("password change: a flagged login sets its own password, the lock is lifted, others are signed out, audit has no password", async () => {
  const { state, call } = setup();
  const res = await call({ new_password: "BrandNewPass9" });
  assertEquals(res.status, 200);
  assertEquals([state.password, state.mustChange, state.signedOut], ["BrandNewPass9", false, 1]);
  assertEquals(state.audit.length, 1);
  assert(!JSON.stringify(state.audit).includes("BrandNewPass9"), "password must not be audited");
});

Deno.test("password change: the temporary password cannot be reused", async () => {
  const { state, call } = setup();
  const res = await call({ new_password: TEMP });
  assertEquals([res.status, (await res.json()).code], [400, "same_as_temporary"]);
  assertEquals(state.mustChange, true);
});

Deno.test("password change: short and long passwords are refused and the lock stays", async () => {
  const { state, call } = setup();
  assertEquals((await call({ new_password: "short" })).status, 400);
  assertEquals((await call({ new_password: "x".repeat(73) })).status, 400);
  assertEquals((await call({})).status, 400);
  assertEquals(state.mustChange, true);
});

Deno.test("password change: a stale or undated session must sign in again", async () => {
  for (const age of [31 * 60, null]) {
    const { state, call } = setup({ iatAgeSeconds: age });
    const res = await call({ new_password: "BrandNewPass9" });
    assertEquals([res.status, (await res.json()).code], [401, "reauth_required"]);
    assertEquals(state.mustChange, true);
  }
});

Deno.test("password change: unflagged, disabled or unknown logins cannot use it", async () => {
  const a = setup();
  a.state.mustChange = false;
  assertEquals((await a.call({ new_password: "BrandNewPass9" })).status, 409);
  assertEquals((await setup({ staff: { disabled: true } }).call({ new_password: "BrandNewPass9" })).status, 403);
  assertEquals((await setup({ staff: null }).call({ new_password: "BrandNewPass9" })).status, 403);
});

Deno.test("password change: if the lock cannot be lifted the caller is told, and the lock stays", async () => {
  const { state, call } = setup({ failClear: true });
  const res = await call({ new_password: "BrandNewPass9" });
  assertEquals([res.status, (await res.json()).code], [500, "finish_failed"]);
  assertEquals([state.mustChange, state.clearCalls], [true, 3]);
});

Deno.test("password change: attempts are rate limited per login", async () => {
  const store: PasswordStore = {
    getUserFromJwt: () => Promise.resolve({ id: "rate-user", email: "r@company.demo", issuedAt: NOW / 1000 - 5 }),
    getStaff: () => Promise.resolve({ staff_id: "R1", disabled: false, must_change_password: true }),
    getTenantId: () => Promise.resolve(null),
    passwordMatches: () => Promise.resolve(true), // never succeeds
    setPassword: () => Promise.resolve(),
    clearMustChange: () => Promise.resolve(),
    signOutOthers: () => Promise.resolve(),
    audit: () => Promise.resolve(),
  };
  const handler = createPasswordHandler({ store, now: () => NOW });
  const go = () =>
    handler(new Request("http://x", { method: "POST", body: JSON.stringify({ new_password: "whatever123" }), headers: { authorization: "Bearer j" } }));
  for (let i = 0; i < MAX_ATTEMPTS; i++) assertEquals((await go()).status, 400);
  assertEquals((await go()).status, 429);
});

// --- webhook-replay ---------------------------------------------------------------------------

function replaySetup(staff: ReplayStaff | null) {
  const claimed: string[] = [];
  const webhook = {
    env: { verifyToken: "v", appSecret: "s", phoneId: "P", graphVersion: "v26.0", dryRun: false },
    store: {
      claimQuarantine: (phone: string) => {
        claimed.push(phone);
        return Promise.resolve([]);
      },
    },
  } as unknown as WebhookDeps;
  const handler = createReplayHandler({
    admin: {
      getUserId: (jwt) => Promise.resolve(jwt === "jwt" ? "a1" : null),
      getStaff: () => Promise.resolve(staff),
      audit: () => Promise.resolve(),
    },
    webhook,
  });
  const call = (body: unknown, jwt: string | null = "jwt") =>
    handler(new Request("http://x/webhook-replay", { method: "POST", body: JSON.stringify(body), headers: jwt ? { authorization: `Bearer ${jwt}` } : {} }));
  return { call, claimed };
}

Deno.test("webhook-replay: only an active admin without a pending password change may replay", async () => {
  const ok: ReplayStaff = { staff_id: "A", role: "admin", disabled: false, must_change_password: false };
  assertEquals((await replaySetup(ok).call({ phone_number_id: "123" }, null)).status, 401);
  assertEquals((await replaySetup({ ...ok, role: "staff" }).call({ phone_number_id: "123" })).status, 403);
  assertEquals((await replaySetup({ ...ok, disabled: true }).call({ phone_number_id: "123" })).status, 403);
  const locked = await replaySetup({ ...ok, must_change_password: true }).call({ phone_number_id: "123" });
  assertEquals([locked.status, (await locked.json()).code], [403, "password_change_required"]);
  const good = replaySetup(ok);
  assertEquals((await good.call({ phone_number_id: "bad id!" })).status, 400);
  assertEquals((await good.call({ phone_number_id: "123", limit: 9999 })).status, 400);
  const res = await good.call({ phone_number_id: "123" });
  assertEquals(res.status, 200);
  assertEquals(good.claimed, ["123"]);
});

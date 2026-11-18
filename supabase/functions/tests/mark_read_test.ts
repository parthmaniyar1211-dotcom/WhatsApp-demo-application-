import { createMarkReadHandler, type MarkReadEnv, type MarkReadStore } from "../mark-read/handler.ts";
import type { CredentialLookup } from "../_shared/connections.ts";
import { assertEquals, fakeFetch, noSleep } from "./helpers.ts";

const CONV = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";
const CONN = "55555555-5555-4555-8555-555555555555";
const NOW = Date.parse("2026-11-14T12:00:00Z");

function setup(options: {
  env?: Partial<MarkReadEnv>;
  disabled?: boolean;
  alreadyRead?: string | null;
  latest?: { wa_message_id: string | null; created_at: string } | null;
  responses?: Array<Response | Error>;
  tenant?: string | null;
  conversationTenant?: string;
  credentials?: CredentialLookup;
} = {}) {
  const saved: string[] = [];
  const store: MarkReadStore = {
    getUserId: (jwt) => Promise.resolve(jwt === "good-jwt" ? "user-1" : null),
    getStaff: () => Promise.resolve({ disabled: options.disabled ?? false, tenant_id: options.tenant === undefined ? TENANT : options.tenant }),
    getCredentials: (connectionId) =>
      Promise.resolve(
        options.credentials ??
          { ok: true as const, credentials: { connectionId, tenantId: TENANT, phoneId: "PHONE1", token: "graph-token" } },
      ),
    getConversation: (id) =>
      Promise.resolve(
        id === CONV
          ? { id, tenant_id: options.conversationTenant ?? TENANT, connection_id: CONN, meta_read_wa_message_id: options.alreadyRead ?? null }
          : null,
      ),
    getLatestIncoming: () =>
      Promise.resolve(
        options.latest === undefined
          ? { wa_message_id: "wamid.LATEST", created_at: new Date(NOW - 60_000).toISOString() }
          : options.latest,
      ),
    setMetaRead: (_id, waMessageId) => {
      saved.push(waMessageId);
      return Promise.resolve();
    },
  };
  const { fetchFn, calls } = fakeFetch(options.responses ?? []);
  const handler = createMarkReadHandler({
    env: { graphVersion: "v26.0", dryRun: false, ...options.env },
    store,
    fetchFn,
    sleep: noSleep,
    now: () => NOW,
  });
  const call = (body: unknown, jwt: string | null = "good-jwt") =>
    handler(
      new Request("http://localhost/mark-read", {
        method: "POST",
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        body: JSON.stringify(body),
      }),
    );
  return { call, calls, saved };
}

Deno.test("mark-read: sends status=read for the newest incoming message", async () => {
  const { call, calls, saved } = setup({ responses: [Response.json({ success: true })] });
  const res = await call({ conversation_id: CONV });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, marked: true, typing: false, dry_run: false });
  assertEquals(calls[0].url, "https://graph.facebook.com/v26.0/PHONE1/messages");
  assertEquals(JSON.parse(calls[0].init!.body as string), {
    messaging_product: "whatsapp",
    status: "read",
    message_id: "wamid.LATEST",
  });
  assertEquals(saved, ["wamid.LATEST"]);
});

Deno.test("mark-read: typing=true adds the typing indicator", async () => {
  const { call, calls } = setup({ responses: [Response.json({ success: true })], alreadyRead: "wamid.LATEST" });
  const res = await call({ conversation_id: CONV, typing: true });
  assertEquals((await res.json()).typing, true);
  assertEquals(JSON.parse(calls[0].init!.body as string).typing_indicator, { type: "text" });
});

Deno.test("mark-read: nothing is sent when already marked, when there is no message, or when it is too old", async () => {
  const already = setup({ alreadyRead: "wamid.LATEST" });
  assertEquals((await (await already.call({ conversation_id: CONV })).json()).marked, false);
  const none = setup({ latest: null });
  assertEquals((await (await none.call({ conversation_id: CONV })).json()).marked, false);
  const old = setup({ latest: { wa_message_id: "wamid.OLD", created_at: new Date(NOW - 31 * 86400_000).toISOString() } });
  assertEquals((await (await old.call({ conversation_id: CONV })).json()).marked, false);
  assertEquals(already.calls.length + none.calls.length + old.calls.length, 0);
});

Deno.test("mark-read: dry run records the read without calling Meta", async () => {
  const { call, calls, saved } = setup({ env: { dryRun: true } });
  const res = await call({ conversation_id: CONV });
  assertEquals((await res.json()).dry_run, true);
  assertEquals(calls.length, 0);
  assertEquals(saved, ["wamid.LATEST"]);
});

Deno.test("mark-read: a Meta error is reported but never fails the request", async () => {
  const { call, saved } = setup({
    responses: [Response.json({ error: { message: "Session has expired", code: 190 } }, { status: 401 })],
  });
  const res = await call({ conversation_id: CONV });
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.marked, false);
  assertEquals(data.reason, "WhatsApp access token has expired or is invalid. An admin must set a new WA_TOKEN. (code 190)");
  assertEquals(saved.length, 0);
});

Deno.test("mark-read: auth and input checks", async () => {
  const { call } = setup();
  const anonymous = await call({ conversation_id: CONV }, null);
  assertEquals(anonymous.status, 401);
  await anonymous.body?.cancel();
  const invalid = await call({ conversation_id: "x" });
  assertEquals(invalid.status, 400);
  await invalid.body?.cancel();
  const missing = await call({ conversation_id: "99999999-9999-4999-8999-999999999999" });
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
  const disabled = setup({ disabled: true });
  const refused = await disabled.call({ conversation_id: CONV });
  assertEquals(refused.status, 403);
  await refused.body?.cancel();
});

Deno.test("mark-read: another tenant's conversation is 'not found' and Meta is not called", async () => {
  const { call, calls, saved } = setup({ conversationTenant: "99999999-9999-4999-8999-999999999999" });
  const res = await call({ conversation_id: CONV });
  assertEquals(res.status, 404);
  await res.body?.cancel();
  assertEquals(calls.length, 0);
  assertEquals(saved, []);
});

Deno.test("mark-read: a login without an active tenant is 403", async () => {
  const { call, calls } = setup({ tenant: null });
  const res = await call({ conversation_id: CONV });
  assertEquals(res.status, 403);
  await res.body?.cancel();
  assertEquals(calls.length, 0);
});

Deno.test("mark-read: uses the connection's own credentials", async () => {
  const { call, calls } = setup({
    responses: [Response.json({ success: true })],
    credentials: { ok: true, credentials: { connectionId: CONN, tenantId: TENANT, phoneId: "TENANT_PHONE_9", token: "tenant-token-9" } },
  });
  const res = await call({ conversation_id: CONV });
  assertEquals((await res.json()).marked, true);
  assertEquals(calls[0].url, "https://graph.facebook.com/v26.0/TENANT_PHONE_9/messages");
  assertEquals((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer tenant-token-9");
});

Deno.test("mark-read: a disconnected number never blocks reading (reported, not an error)", async () => {
  const { call, calls, saved } = setup({ credentials: { ok: false, reason: "inactive" } });
  const res = await call({ conversation_id: CONV });
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.marked, false);
  assertEquals(calls.length, 0);
  assertEquals(saved, []);
});

import { createMarkReadHandler, type MarkReadEnv, type MarkReadStore } from "../mark-read/handler.ts";
import { assertEquals, fakeFetch, noSleep } from "./helpers.ts";

const CONV = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-14T12:00:00Z");

function setup(options: {
  env?: Partial<MarkReadEnv>;
  disabled?: boolean;
  alreadyRead?: string | null;
  latest?: { wa_message_id: string | null; created_at: string } | null;
  responses?: Array<Response | Error>;
} = {}) {
  const saved: string[] = [];
  const store: MarkReadStore = {
    getUserId: (jwt) => Promise.resolve(jwt === "good-jwt" ? "user-1" : null),
    getStaff: () => Promise.resolve({ disabled: options.disabled ?? false }),
    getConversation: (id) =>
      Promise.resolve(id === CONV ? { id, meta_read_wa_message_id: options.alreadyRead ?? null } : null),
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
    env: { token: "graph-token", phoneId: "PHONE1", graphVersion: "v26.0", dryRun: false, ...options.env },
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
  const { call, calls, saved } = setup({ env: { dryRun: true, token: undefined } });
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

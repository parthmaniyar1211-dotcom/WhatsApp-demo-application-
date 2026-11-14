import {
  type ConversationRow,
  createSendHandler,
  type MessageRow,
  RATE_LIMIT_MAX,
  type SendEnv,
  type SendStore,
  type StaffRow,
} from "../send-whatsapp/handler.ts";
import { assert, assertEquals, fakeFetch, noSleep } from "./helpers.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-14T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

interface Options {
  env?: Partial<SendEnv>;
  staff?: StaffRow | null;
  conversation?: ConversationRow | null;
  recentSends?: number;
  file?: { size: number; mime: string } | null;
  responses?: Array<Response | Error>;
}

function setup(options: Options = {}) {
  const rows: MessageRow[] = [];
  const signedUrls: string[] = [];
  const staff = options.staff === undefined
    ? { user_id: USER, staff_id: "EMP1001", role: "staff", disabled: false }
    : options.staff;
  const conversation = options.conversation === undefined
    ? { id: CONV, wa_id: "919800000001", last_inbound_at: hoursAgo(1) }
    : options.conversation;
  const store: SendStore = {
    getUserId: (jwt) => Promise.resolve(jwt === "good-jwt" ? USER : null),
    getStaff: () => Promise.resolve(staff),
    getConversation: (id) => Promise.resolve(conversation && conversation.id === id ? conversation : null),
    countRecentSends: () => Promise.resolve(options.recentSends ?? 0),
    getFileInfo: () => Promise.resolve(options.file === undefined ? { size: 1000, mime: "image/jpeg" } : options.file),
    createSignedUrl: (path, seconds) => {
      const url = `https://project.supabase.co/storage/v1/object/sign/files/${path}?token=t&exp=${seconds}`;
      signedUrls.push(url);
      return Promise.resolve(url);
    },
    createOutgoing: (m) => {
      const row: MessageRow = {
        id: crypto.randomUUID(),
        conversation_id: m.conversationId,
        direction: "out",
        type: m.type,
        body: m.body,
        media_path: m.mediaPath,
        media_mime: m.mediaMime,
        media_filename: m.mediaFilename,
        status: "sending",
        sent_by: m.sentBy,
        wa_message_id: null,
        error: null,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    finishOutgoing: (id, result) => {
      const row = rows.find((r) => r.id === id)!;
      row.status = result.status;
      row.wa_message_id = result.waMessageId ?? null;
      row.error = result.error ?? null;
      return Promise.resolve(row);
    },
  };
  const { fetchFn, calls } = fakeFetch(options.responses ?? []);
  const handler = createSendHandler({
    env: { token: "graph-token", phoneId: "PHONE1", graphVersion: "v24.0", dryRun: false, ...options.env },
    store,
    fetchFn,
    sleep: noSleep,
    now: () => NOW,
  });
  return { handler, rows, calls, signedUrls };
}

function request(body: unknown, jwt: string | null = "good-jwt") {
  return new Request("http://localhost/send-whatsapp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const graphOk = () => Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.REAL1" }] });

Deno.test("unauthenticated: no token is 401", async () => {
  const { handler, rows } = setup();
  const res = await handler(request({ conversation_id: CONV, text: "hi" }, null));
  assertEquals(res.status, 401);
  assertEquals((await res.json()).code, "unauthenticated");
  assertEquals(rows.length, 0);
});

Deno.test("unauthenticated: invalid token is 401", async () => {
  const { handler } = setup();
  const res = await handler(request({ conversation_id: CONV, text: "hi" }, "forged"));
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("signed-in user without a staff row is 403", async () => {
  const { handler } = setup({ staff: null });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 403);
  await res.body?.cancel();
});

Deno.test("disabled staff is 403", async () => {
  const { handler, rows } = setup({ staff: { user_id: USER, staff_id: "EMP1001", role: "staff", disabled: true } });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 403);
  await res.body?.cancel();
  assertEquals(rows.length, 0);
});

Deno.test("empty message is 400", async () => {
  const { handler, rows, calls } = setup();
  for (const body of [{ conversation_id: CONV }, { conversation_id: CONV, text: "" }, { conversation_id: CONV, text: "  \n " }]) {
    const res = await handler(request(body));
    assertEquals(res.status, 400);
    assertEquals((await res.json()).code, "empty");
  }
  assertEquals(rows.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("invalid input is 400", async () => {
  const { handler } = setup();
  const cases: unknown[] = [
    "{not json",
    [],
    { conversation_id: "abc", text: "hi" },
    { conversation_id: CONV, text: 5 },
    { conversation_id: CONV, text: "x".repeat(4097) },
    { conversation_id: CONV, template: "other_template" },
    { conversation_id: CONV, template: "hello_world", text: "extra" },
    { conversation_id: CONV, media_path: "incoming/919800000001/x.jpg" },
    { conversation_id: CONV, media_path: "outgoing/33333333-3333-4333-8333-333333333333/x.jpg" },
    { conversation_id: CONV, media_path: `outgoing/${USER}/../x.jpg` },
  ];
  for (const body of cases) {
    const res = await handler(request(body));
    assertEquals(res.status, 400, JSON.stringify(body).slice(0, 60));
    await res.body?.cancel();
  }
});

Deno.test("unknown conversation is 404", async () => {
  const { handler } = setup({ conversation: null });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("closed 24h window: text is refused with 409 and nothing is sent", async () => {
  const { handler, rows, calls } = setup({
    conversation: { id: CONV, wa_id: "919800000001", last_inbound_at: hoursAgo(25) },
  });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "window_closed");
  assertEquals(rows.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("closed 24h window: customer never wrote is also closed", async () => {
  const { handler } = setup({ conversation: { id: CONV, wa_id: "919800000001", last_inbound_at: null } });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 409);
  await res.body?.cancel();
});

Deno.test("closed 24h window: template is still allowed", async () => {
  const { handler, rows, calls } = setup({
    conversation: { id: CONV, wa_id: "919800000001", last_inbound_at: hoursAgo(48) },
    responses: [graphOk()],
  });
  const res = await handler(request({ conversation_id: CONV, template: "hello_world" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(rows[0].type, "template");
  assertEquals(rows[0].body, "hello_world");
  const sent = JSON.parse(calls[0].init!.body as string);
  assertEquals(sent.template, { name: "hello_world", language: { code: "en_US" } });
});

Deno.test("dry run success: no call to Meta, fake id, status sent", async () => {
  const { handler, rows, calls } = setup({ env: { dryRun: true, token: undefined, phoneId: undefined } });
  const res = await handler(request({ conversation_id: CONV, text: " hello there " }));
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.dry_run, true);
  assertEquals(data.message.status, "sent");
  assert(String(data.message.wa_message_id).startsWith("wamid.DRYRUN."));
  assertEquals(rows[0].body, "hello there");
  assertEquals(rows[0].sent_by, USER);
  assertEquals(calls.length, 0);
});

Deno.test("real send: text goes to the Graph API with the bearer token", async () => {
  const { handler, rows, calls } = setup({ responses: [graphOk()] });
  const res = await handler(request({ conversation_id: CONV, text: "hello" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(calls[0].url, "https://graph.facebook.com/v24.0/PHONE1/messages");
  assertEquals((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer graph-token");
  assertEquals(JSON.parse(calls[0].init!.body as string), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "919800000001",
    type: "text",
    text: { body: "hello", preview_url: false },
  });
  assertEquals(rows[0].status, "sent");
  assertEquals(rows[0].wa_message_id, "wamid.REAL1");
});

Deno.test("real send: image uses a short-lived signed URL", async () => {
  const { handler, rows, calls, signedUrls } = setup({ responses: [graphOk()] });
  const path = `outgoing/${USER}/photo.jpg`;
  const res = await handler(request({ conversation_id: CONV, media_path: path, text: "see this" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(rows[0].type, "image");
  assertEquals(rows[0].media_path, path);
  const sent = JSON.parse(calls[0].init!.body as string);
  assertEquals(sent.type, "image");
  assertEquals(sent.image, { link: signedUrls[0], caption: "see this" });
  assert(signedUrls[0].endsWith("exp=600"));
});

Deno.test("real send: PDF is sent as a document with its file name", async () => {
  const { handler, rows, calls } = setup({ file: { size: 5000, mime: "application/pdf" }, responses: [graphOk()] });
  const res = await handler(
    request({ conversation_id: CONV, media_path: `outgoing/${USER}/abc.pdf`, filename: "Quote 12.pdf" }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(rows[0].type, "document");
  assertEquals(rows[0].media_filename, "Quote 12.pdf");
  const sent = JSON.parse(calls[0].init!.body as string);
  assertEquals(sent.document.filename, "Quote 12.pdf");
});

Deno.test("file checks: too large, wrong type, missing", async () => {
  const path = `outgoing/${USER}/file.bin`;
  const big = setup({ file: { size: 10 * 1024 * 1024 + 1, mime: "image/jpeg" } });
  const r1 = await big.handler(request({ conversation_id: CONV, media_path: path }));
  assertEquals(r1.status, 413);
  await r1.body?.cancel();
  const wrong = setup({ file: { size: 10, mime: "image/webp" } });
  const r2 = await wrong.handler(request({ conversation_id: CONV, media_path: path }));
  assertEquals(r2.status, 400);
  await r2.body?.cancel();
  const missing = setup({ file: null });
  const r3 = await missing.handler(request({ conversation_id: CONV, media_path: path }));
  assertEquals(r3.status, 400);
  await r3.body?.cancel();
  assertEquals(big.rows.length + wrong.rows.length + missing.rows.length, 0);
});

Deno.test("rate limit: 429 after too many recent sends", async () => {
  const { handler, rows } = setup({ recentSends: RATE_LIMIT_MAX });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 429);
  await res.body?.cancel();
  assertEquals(rows.length, 0);
});

Deno.test("Graph API rejection: message is marked failed with the reason, 502", async () => {
  const { handler, rows, calls } = setup({
    responses: [
      Response.json(
        { error: { message: "(#131030) Recipient phone number not in allowed list", code: 131030 } },
        { status: 400 },
      ),
    ],
  });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 502);
  const data = await res.json();
  assertEquals(data.message.status, "failed");
  assertEquals(rows[0].error, "131030: (#131030) Recipient phone number not in allowed list");
  assertEquals(calls.length, 1); // 4xx is not retried
});

Deno.test("Graph API 5xx is retried with backoff, then succeeds", async () => {
  const { handler, rows, calls } = setup({
    responses: [new Response("x", { status: 500 }), new Error("network"), graphOk()],
  });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(calls.length, 3);
  assertEquals(rows[0].status, "sent");
});

Deno.test("Graph API down after all retries: failed, 502", async () => {
  const { handler, rows, calls } = setup({
    responses: [new Error("network"), new Error("network"), new Error("network")],
  });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 502);
  await res.body?.cancel();
  assertEquals(calls.length, 3);
  assertEquals(rows[0].status, "failed");
});

Deno.test("missing WA_TOKEN without dry run is a 500 and nothing is stored", async () => {
  const { handler, rows } = setup({ env: { token: undefined } });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).code, "not_configured");
  assertEquals(rows.length, 0);
});

Deno.test("CORS preflight is answered", async () => {
  const { handler } = setup();
  const res = await handler(new Request("http://localhost/send-whatsapp", { method: "OPTIONS" }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  await res.body?.cancel();
});

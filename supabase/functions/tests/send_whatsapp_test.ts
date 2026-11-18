import {
  type ConversationRow,
  createSendHandler,
  type MessageRef,
  type MessageRow,
  RATE_LIMIT_MAX,
  type SendEnv,
  type SendStore,
  type StaffRow,
} from "../send-whatsapp/handler.ts";
import type { CredentialLookup } from "../_shared/connections.ts";
import { assert, assertEquals, fakeFetch, noSleep } from "./helpers.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";
const OTHER_TENANT = "44444444-4444-4444-8444-444444444444";
const CONN = "55555555-5555-4555-8555-555555555555";
const NOW = Date.parse("2026-11-14T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

interface Options {
  env?: Partial<SendEnv>;
  staff?: StaffRow | null;
  conversation?: ConversationRow | null;
  recentSends?: number;
  file?: { size: number; mime: string } | null;
  responses?: Array<Response | Error>;
  messages?: MessageRef[];
  /** What the tenant's connection resolves to. Default: a working connection (PHONE1 / graph-token). */
  credentials?: CredentialLookup;
}

function setup(options: Options = {}) {
  const rows: MessageRow[] = [];
  const signedUrls: string[] = [];
  const credentialCalls: string[] = [];
  const reactions: Array<{ messageId: string; emoji: string | null; staffId: string }> = [];
  const staff = options.staff === undefined
    ? { user_id: USER, staff_id: "EMP1001", role: "staff", disabled: false, tenant_id: TENANT }
    : options.staff;
  const conversation = options.conversation === undefined
    ? { id: CONV, tenant_id: TENANT, connection_id: CONN, wa_id: "919800000001", last_inbound_at: hoursAgo(1) }
    : options.conversation;
  const store: SendStore = {
    getUserId: (jwt) => Promise.resolve(jwt === "good-jwt" ? USER : null),
    getStaff: () => Promise.resolve(staff),
    getCredentials: (connectionId) => {
      credentialCalls.push(connectionId);
      return Promise.resolve(
        options.credentials ??
          { ok: true as const, credentials: { connectionId, tenantId: TENANT, phoneId: "PHONE1", token: "graph-token" } },
      );
    },
    getConversation: (id) => Promise.resolve(conversation && conversation.id === id ? conversation : null),
    getMessage: (id) => Promise.resolve((options.messages ?? []).find((m) => m.id === id) ?? null),
    downloadFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    setBusinessReaction: (messageId, emoji, staffId) => {
      reactions.push({ messageId, emoji, staffId });
      return Promise.resolve({ id: messageId, reaction_business: emoji, reaction_business_by: emoji ? staffId : null });
    },
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
        media_size: m.mediaSize,
        media_voice: m.mediaVoice,
        reply_to_wa_message_id: m.replyTo,
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
    env: { graphVersion: "v26.0", dryRun: false, ...options.env },
    store,
    fetchFn,
    sleep: noSleep,
    now: () => NOW,
  });
  return { handler, rows, calls, signedUrls, reactions, credentialCalls };
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
  const { handler, rows } = setup({ staff: { user_id: USER, staff_id: "EMP1001", role: "staff", disabled: true, tenant_id: TENANT } });
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
    conversation: { id: CONV, tenant_id: TENANT, connection_id: CONN, wa_id: "919800000001", last_inbound_at: hoursAgo(25) },
  });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "window_closed");
  assertEquals(rows.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("closed 24h window: customer never wrote is also closed", async () => {
  const { handler } = setup({ conversation: { id: CONV, tenant_id: TENANT, connection_id: CONN, wa_id: "919800000001", last_inbound_at: null } });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 409);
  await res.body?.cancel();
});

Deno.test("closed 24h window: template is still allowed", async () => {
  const { handler, rows, calls } = setup({
    conversation: { id: CONV, tenant_id: TENANT, connection_id: CONN, wa_id: "919800000001", last_inbound_at: hoursAgo(48) },
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
  const { handler, rows, calls } = setup({ env: { dryRun: true } });
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
  assertEquals(calls[0].url, "https://graph.facebook.com/v26.0/PHONE1/messages");
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
  const big = setup({ file: { size: 10 * 1024 * 1024 + 1, mime: "application/pdf" } });
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
  assertEquals(
    rows[0].error,
    "This number is not in the allowed list of the Meta test number. Add it under WhatsApp > API Setup. (code 131030)",
  );
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

Deno.test("a connection without a token (not dry run) is a 500 and nothing is stored", async () => {
  const { handler, rows } = setup({ credentials: { ok: false, reason: "no_token" } });
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

// --- Replies, reactions, audio, video, error mapping --------------------------

const TARGET = "33333333-3333-4333-8333-333333333333";
const targetMessages: MessageRef[] = [
  { id: TARGET, conversation_id: CONV, wa_message_id: "wamid.CUSTOMER1" },
  { id: "44444444-4444-4444-8444-444444444444", conversation_id: "55555555-5555-4555-8555-555555555555", wa_message_id: "wamid.OTHERCHAT" },
  { id: "66666666-6666-4666-8666-666666666666", conversation_id: CONV, wa_message_id: null },
];

Deno.test("reply: the quoted message goes into the Cloud API context field", async () => {
  const { handler, rows, calls } = setup({ responses: [graphOk()], messages: targetMessages });
  const res = await handler(request({ conversation_id: CONV, text: "Yes", reply_to: TARGET }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const sent = JSON.parse(calls[0].init!.body as string);
  assertEquals(sent.context, { message_id: "wamid.CUSTOMER1" });
  assertEquals(sent.text.body, "Yes");
  assertEquals(rows[0].reply_to_wa_message_id, "wamid.CUSTOMER1");
});

Deno.test("reply: a message from another chat, or one WhatsApp never got, cannot be quoted", async () => {
  const { handler, rows } = setup({ messages: targetMessages });
  const other = await handler(request({ conversation_id: CONV, text: "x", reply_to: targetMessages[1].id }));
  assertEquals(other.status, 404);
  await other.body?.cancel();
  const unsent = await handler(request({ conversation_id: CONV, text: "x", reply_to: targetMessages[2].id }));
  assertEquals(unsent.status, 409);
  await unsent.body?.cancel();
  const bad = await handler(request({ conversation_id: CONV, text: "x", reply_to: "nope" }));
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  assertEquals(rows.length, 0);
});

Deno.test("reaction: sent as a reaction message and stored on the target", async () => {
  const { handler, rows, calls, reactions } = setup({
    responses: [Response.json({ messaging_product: "whatsapp", messages: [{ id: "wamid.R" }] })],
    messages: targetMessages,
  });
  const res = await handler(request({ conversation_id: CONV, reaction: { message_id: TARGET, emoji: "\u{1F44D}" } }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).message.reaction_business, "\u{1F44D}");
  assertEquals(JSON.parse(calls[0].init!.body as string), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "919800000001",
    type: "reaction",
    reaction: { message_id: "wamid.CUSTOMER1", emoji: "\u{1F44D}" },
  });
  assertEquals(reactions, [{ messageId: TARGET, emoji: "\u{1F44D}", staffId: "EMP1001" }]);
  assertEquals(rows.length, 0); // a reaction is not a message row
});

Deno.test("reaction: empty emoji removes it; text is not an emoji; window must be open", async () => {
  const removed = setup({ env: { dryRun: true }, messages: targetMessages });
  const r1 = await removed.handler(request({ conversation_id: CONV, reaction: { message_id: TARGET, emoji: "" } }));
  assertEquals(r1.status, 200);
  await r1.body?.cancel();
  assertEquals(removed.reactions[0].emoji, null);
  assertEquals(removed.calls.length, 0);

  const text = setup({ messages: targetMessages });
  const r2 = await text.handler(request({ conversation_id: CONV, reaction: { message_id: TARGET, emoji: "ok" } }));
  assertEquals(r2.status, 400);
  await r2.body?.cancel();

  const closed = setup({
    messages: targetMessages,
    conversation: { id: CONV, tenant_id: TENANT, connection_id: CONN, wa_id: "919800000001", last_inbound_at: hoursAgo(30) },
  });
  const r3 = await closed.handler(request({ conversation_id: CONV, reaction: { message_id: TARGET, emoji: "\u{2764}\u{FE0F}" } }));
  assertEquals(r3.status, 409);
  await r3.body?.cancel();
  assertEquals(closed.reactions.length, 0);
});

Deno.test("reaction: when Meta refuses, nothing is stored and the reason is mapped", async () => {
  const { handler, reactions } = setup({
    responses: [Response.json({ error: { message: "x", code: 131009 } }, { status: 400 })],
    messages: targetMessages,
  });
  const res = await handler(request({ conversation_id: CONV, reaction: { message_id: TARGET, emoji: "\u{1F44D}" } }));
  assertEquals(res.status, 502);
  assert((await res.json()).error.includes("(code 131009)"));
  assertEquals(reactions.length, 0);
});

Deno.test("voice note: OGG/Opus is sent as audio with voice=true", async () => {
  const { handler, rows, calls, signedUrls } = setup({
    file: { size: 4000, mime: "audio/ogg; codecs=opus" },
    responses: [graphOk()],
  });
  const res = await handler(request({ conversation_id: CONV, media_path: `outgoing/${USER}/v.ogg`, voice: true }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const sent = JSON.parse(calls[0].init!.body as string);
  assertEquals(sent.type, "audio");
  assertEquals(sent.audio, { link: signedUrls[0], voice: true });
  assertEquals(rows[0].type, "audio");
  assertEquals(rows[0].media_voice, true);
  assertEquals(rows[0].media_size, 4000);
});

Deno.test("audio in another format is sent as plain audio; a caption on audio is refused", async () => {
  const { handler, rows, calls } = setup({ file: { size: 4000, mime: "audio/mp4" }, responses: [graphOk()] });
  const res = await handler(request({ conversation_id: CONV, media_path: `outgoing/${USER}/v.m4a`, voice: true }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(JSON.parse(calls[0].init!.body as string).audio.voice, undefined);
  assertEquals(rows[0].media_voice, false);
  const caption = await handler(request({ conversation_id: CONV, media_path: `outgoing/${USER}/v.m4a`, text: "hi" }));
  assertEquals(caption.status, 400);
  await caption.body?.cancel();
});

Deno.test("video: MP4 is sent as video with a caption", async () => {
  const { handler, calls } = setup({ file: { size: 9000, mime: "video/mp4" }, responses: [graphOk()] });
  const res = await handler(request({ conversation_id: CONV, media_path: `outgoing/${USER}/v.mp4`, text: "clip" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const sent = JSON.parse(calls[0].init!.body as string);
  assertEquals(sent.type, "video");
  assertEquals(sent.video.caption, "clip");
});

Deno.test("photo larger than Meta's 5 MB image limit is refused before sending", async () => {
  const { handler, rows } = setup({ file: { size: 5 * 1024 * 1024 + 1, mime: "image/jpeg" } });
  const res = await handler(request({ conversation_id: CONV, media_path: `outgoing/${USER}/big.jpg` }));
  assertEquals(res.status, 413);
  assertEquals((await res.json()).error, "File is larger than 5 MB");
  assertEquals(rows.length, 0);
});

Deno.test("WA_MEDIA_MODE=upload: the file is uploaded to Meta and sent by media id", async () => {
  const { handler, calls, signedUrls } = setup({
    env: { mediaMode: "upload" },
    file: { size: 3, mime: "audio/ogg" },
    responses: [Response.json({ id: "MEDIA_UPLOADED" }), graphOk()],
  });
  const res = await handler(request({ conversation_id: CONV, media_path: `outgoing/${USER}/v.ogg`, voice: true }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(calls[0].url, "https://graph.facebook.com/v26.0/PHONE1/media");
  const form = calls[0].init!.body as FormData;
  assertEquals(form.get("messaging_product"), "whatsapp");
  assertEquals(form.get("type"), "audio/ogg; codecs=opus");
  assertEquals((form.get("file") as File).size, 3);
  assertEquals(JSON.parse(calls[1].init!.body as string).audio, { id: "MEDIA_UPLOADED", voice: true });
  assertEquals(signedUrls.length, 0);
});

Deno.test("WA_MEDIA_MODE=upload: a rejected upload marks the message failed with the reason", async () => {
  const { handler, rows, calls } = setup({
    env: { mediaMode: "upload" },
    responses: [Response.json({ error: { message: "bad", code: 131053 } }, { status: 400 })],
  });
  const res = await handler(request({ conversation_id: CONV, media_path: `outgoing/${USER}/p.jpg` }));
  assertEquals(res.status, 502);
  await res.body?.cancel();
  assertEquals(calls.length, 1);
  assertEquals(
    rows[0].error,
    "WhatsApp rejected the file: the type is not supported or the file is too large. (code 131053)",
  );
});

Deno.test("customer known only by user id is addressed with 'recipient' instead of 'to'", async () => {
  const { handler, calls } = setup({
    conversation: { id: CONV, tenant_id: TENANT, connection_id: CONN, wa_id: "US.13491208655302741918", last_inbound_at: hoursAgo(1) },
    responses: [graphOk()],
  });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const sent = JSON.parse(calls[0].init!.body as string);
  assertEquals(sent.recipient, "US.13491208655302741918");
  assertEquals(sent.to, undefined);
});

Deno.test("Meta error codes become staff-facing messages", async () => {
  const cases: Array<[Record<string, unknown>, number, string]> = [
    [{ message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 }, 401, "access token has expired"],
    [{ message: "Re-engagement message", code: 131047, error_data: { details: "More than 24 hours" } }, 400, "24-hour window is closed"],
    [{ message: "Template name does not exist in the translation", code: 132001 }, 404, "not approved yet"],
    [{ message: "Rate limit hit", code: 130429 }, 429, "rate limit"],
    [{ message: "Media upload error", code: 131053 }, 400, "rejected the file"],
    [{ message: "Something new", code: 139999 }, 400, "Something new (code 139999)"],
  ];
  for (const [error, status, expected] of cases) {
    // 429 is retried twice more before giving up.
    const responses = Array.from({ length: status === 429 ? 3 : 1 }, () => Response.json({ error }, { status }));
    const { handler, rows } = setup({ responses });
    const res = await handler(request({ conversation_id: CONV, text: "hi" }));
    assertEquals(res.status, 502);
    await res.body?.cancel();
    assert(String(rows[0].error).includes(expected), `${error.code}: ${rows[0].error}`);
    assert(String(rows[0].error).includes(`(code ${error.code})`));
  }
});

// --- multi-tenant -----------------------------------------------------------------------------

Deno.test("tenant: a staff member without an active tenant is 403 and nothing is stored or sent", async () => {
  const { handler, rows, calls } = setup({
    staff: { user_id: USER, staff_id: "EMP1001", role: "staff", disabled: false, tenant_id: null },
  });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 403);
  await res.body?.cancel();
  assertEquals(rows.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("tenant: another tenant's conversation is 'not found' (no sending, no storing, no credential lookup)", async () => {
  const { handler, rows, calls, credentialCalls } = setup({
    conversation: { id: CONV, tenant_id: OTHER_TENANT, connection_id: CONN, wa_id: "919800000001", last_inbound_at: hoursAgo(1) },
  });
  for (const body of [{ text: "hi" }, { template: "hello_world" }, { reaction: { message_id: CONV, emoji: "👍" } }]) {
    const res = await handler(request({ conversation_id: CONV, ...body }));
    assertEquals(res.status, 404);
    assertEquals((await res.json()).code, "not_found");
  }
  assertEquals(rows.length, 0);
  assertEquals(calls.length, 0);
  assertEquals(credentialCalls.length, 0);
});

Deno.test("tenant: the message is sent with the credentials of the conversation's own connection", async () => {
  const { handler, calls, credentialCalls } = setup({
    responses: [graphOk()],
    credentials: { ok: true, credentials: { connectionId: CONN, tenantId: TENANT, phoneId: "TENANT_PHONE_77", token: "tenant-specific-token" } },
  });
  const res = await handler(request({ conversation_id: CONV, text: "hello" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(credentialCalls, [CONN]);
  assertEquals(calls[0].url, "https://graph.facebook.com/v26.0/TENANT_PHONE_77/messages");
  assertEquals((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer tenant-specific-token");
});

Deno.test("tenant: a disconnected connection is 409, nothing is stored and Meta is not called", async () => {
  const { handler, rows, calls } = setup({ credentials: { ok: false, reason: "inactive" } });
  const res = await handler(request({ conversation_id: CONV, text: "hi" }));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "connection_inactive");
  assertEquals(rows.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("tenant: the token is never part of any response", async () => {
  const secret = "super-secret-tenant-token-xyz";
  const { handler } = setup({
    responses: [graphOk()],
    credentials: { ok: true, credentials: { connectionId: CONN, tenantId: TENANT, phoneId: "P1", token: secret } },
  });
  const res = await handler(request({ conversation_id: CONV, text: "hello" }));
  assert(!(await res.text()).includes(secret));
  const failing = setup({
    responses: [Response.json({ error: { message: `bad token ${"x"}`, code: 190 } }, { status: 401 })],
    credentials: { ok: true, credentials: { connectionId: CONN, tenantId: TENANT, phoneId: "P1", token: secret } },
  });
  const failed = await failing.handler(request({ conversation_id: CONV, text: "hello" }));
  assert(!(await failed.text()).includes(secret));
});

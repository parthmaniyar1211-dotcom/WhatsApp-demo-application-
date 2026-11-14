import {
  createWebhookHandler,
  type IncomingMessage,
  type WebhookEnv,
  type WebhookStore,
} from "../whatsapp-webhook/handler.ts";
import { assert, assertEquals, fakeFetch, noSleep, sign } from "./helpers.ts";

const SECRET = "test-app-secret";
const URL_ = "http://localhost/whatsapp-webhook";

function memoryStore() {
  const messages = new Map<string, IncomingMessage & { id: string; mediaPath?: string; error?: string }>();
  const files = new Map<string, { bytes: Uint8Array; mime: string }>();
  const outgoing = new Map<string, string>(); // wa_message_id -> status
  const reactions = new Map<string, string>(); // wa_message_id -> emoji
  const store: WebhookStore = {
    ingestIncoming(m) {
      if (messages.has(m.waMessageId)) return Promise.resolve(null);
      const id = crypto.randomUUID();
      messages.set(m.waMessageId, { ...m, id });
      return Promise.resolve(id);
    },
    saveMedia(messageId, path, bytes, mime) {
      files.set(path, { bytes, mime });
      for (const m of messages.values()) if (m.id === messageId) m.mediaPath = path;
      return Promise.resolve();
    },
    setMessageError(messageId, error) {
      for (const m of messages.values()) if (m.id === messageId) m.error = error;
      return Promise.resolve();
    },
    applyStatus(waMessageId, status) {
      if (!outgoing.has(waMessageId)) return Promise.resolve(false);
      outgoing.set(waMessageId, status);
      return Promise.resolve(true);
    },
    applyReaction(waMessageId, emoji) {
      if (!messages.has(waMessageId) && !outgoing.has(waMessageId)) return Promise.resolve(false);
      reactions.set(waMessageId, emoji);
      return Promise.resolve(true);
    },
  };
  return { store, messages, files, outgoing, reactions };
}

function setup(env: Partial<WebhookEnv> = {}, responses: Array<Response | Error> = []) {
  const memory = memoryStore();
  const { fetchFn, calls } = fakeFetch(responses);
  const handler = createWebhookHandler({
    env: {
      verifyToken: "verify-me",
      appSecret: SECRET,
      token: "graph-token",
      phoneId: "PHONE1",
      graphVersion: "v26.0",
      dryRun: false,
      ...env,
    },
    store: memory.store,
    fetchFn,
    sleep: noSleep,
  });
  return { handler, calls, ...memory };
}

function payload(value: Record<string, unknown>) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550001111", phone_number_id: "PHONE1" },
          ...value,
        },
      }],
    }],
  });
}

const contact = [{ profile: { name: "Asha Customer" }, wa_id: "919800000001" }];
const textMessage = (id = "wamid.TEXT1") => ({
  contacts: contact,
  messages: [{ from: "919800000001", id, timestamp: "1700000000", type: "text", text: { body: "hi" } }],
});

async function post(handler: (r: Request) => Promise<Response>, body: string, signature?: string) {
  return await handler(
    new Request(URL_, {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": signature ?? (await sign(body, SECRET)) },
    }),
  );
}

Deno.test("verification: correct token echoes hub.challenge", async () => {
  const { handler } = setup();
  const res = await handler(
    new Request(`${URL_}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "12345");
});

Deno.test("verification: wrong token is rejected", async () => {
  const { handler } = setup();
  const res = await handler(new Request(`${URL_}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`));
  assertEquals(res.status, 403);
  await res.body?.cancel();
});

Deno.test("verification: fails closed when WA_VERIFY_TOKEN is not set", async () => {
  const { handler } = setup({ verifyToken: undefined });
  const res = await handler(new Request(`${URL_}?hub.mode=subscribe&hub.verify_token=&hub.challenge=12345`));
  assertEquals(res.status, 403);
  await res.body?.cancel();
});

Deno.test("bad signature returns 401 and stores nothing", async () => {
  const { handler, messages } = setup();
  const body = payload(textMessage());
  const res = await post(handler, body, await sign(body, "wrong-secret"));
  assertEquals(res.status, 401);
  await res.body?.cancel();
  assertEquals(messages.size, 0);
});

Deno.test("missing or malformed signature returns 401", async () => {
  const { handler } = setup();
  const body = payload(textMessage());
  const missing = await handler(new Request(URL_, { method: "POST", body }));
  assertEquals(missing.status, 401);
  await missing.body?.cancel();
  const malformed = await post(handler, body, "sha256=xyz");
  assertEquals(malformed.status, 401);
  await malformed.body?.cancel();
});

Deno.test("signature is checked against the exact raw body", async () => {
  const { handler } = setup();
  const body = payload(textMessage());
  const res = await post(handler, body + " ", await sign(body, SECRET));
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("fails closed when WA_APP_SECRET is not set", async () => {
  const { handler, messages } = setup({ appSecret: undefined });
  const body = payload(textMessage());
  const res = await post(handler, body, await sign(body, "anything"));
  assertEquals(res.status, 503);
  await res.body?.cancel();
  assertEquals(messages.size, 0);
});

Deno.test("text message is stored with the customer name", async () => {
  const { handler, messages } = setup();
  const res = await post(handler, payload(textMessage()));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, stored: 1, duplicates: 0, statuses: 0, reactions: 0, ignored: 0 });
  const stored = messages.get("wamid.TEXT1")!;
  assertEquals(stored.type, "text");
  assertEquals(stored.body, "hi");
  assertEquals(stored.waId, "919800000001");
  assertEquals(stored.customerName, "Asha Customer");
  assertEquals(stored.timestamp, "2023-11-14T22:13:20.000Z");
});

Deno.test("duplicate message id is stored once", async () => {
  const { handler, messages } = setup();
  const body = payload(textMessage("wamid.DUP"));
  const first = await post(handler, body);
  assertEquals((await first.json()).stored, 1);
  const second = await post(handler, body);
  assertEquals(second.status, 200);
  assertEquals(await second.json(), { ok: true, stored: 0, duplicates: 1, statuses: 0, reactions: 0, ignored: 0 });
  assertEquals(messages.size, 1);
});

Deno.test("image message: file is downloaded from Meta and stored privately", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { handler, messages, files, calls } = setup({}, [
    Response.json({ url: "https://lookaside.fbsbx.com/file/1", mime_type: "image/jpeg", file_size: 4 }),
    new Response(bytes),
  ]);
  const res = await post(
    handler,
    payload({
      contacts: contact,
      messages: [{
        from: "919800000001",
        id: "wamid.IMG1",
        timestamp: "1700000000",
        type: "image",
        image: { id: "MEDIA1", mime_type: "image/jpeg", sha256: "x", caption: "look" },
      }],
    }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).stored, 1);
  const stored = messages.get("wamid.IMG1")!;
  assertEquals(stored.type, "image");
  assertEquals(stored.body, "look");
  assertEquals(stored.mediaPath, `incoming/919800000001/${stored.id}.jpg`);
  assertEquals(files.get(stored.mediaPath!)?.mime, "image/jpeg");
  assertEquals(Array.from(files.get(stored.mediaPath!)!.bytes), [1, 2, 3, 4]);
  assertEquals(calls[0].url, "https://graph.facebook.com/v26.0/MEDIA1");
  assertEquals((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer graph-token");
  assertEquals(calls[1].url, "https://lookaside.fbsbx.com/file/1");
});

Deno.test("document message keeps its file name", async () => {
  const { handler, messages } = setup({}, [
    Response.json({ url: "https://lookaside.fbsbx.com/file/2", mime_type: "application/pdf" }),
    new Response(new Uint8Array([37, 80, 68, 70])),
  ]);
  const res = await post(
    handler,
    payload({
      contacts: contact,
      messages: [{
        from: "919800000001",
        id: "wamid.DOC1",
        timestamp: "1700000000",
        type: "document",
        document: { id: "MEDIA2", mime_type: "application/pdf", filename: "../invoice.pdf" },
      }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = messages.get("wamid.DOC1")!;
  assertEquals(stored.type, "document");
  assertEquals(stored.mediaFilename, "..invoice.pdf"); // path separators removed
  assert(stored.mediaPath?.endsWith(".pdf"));
});

Deno.test("media download retries on 5xx with backoff, then succeeds", async () => {
  const { handler, messages, calls } = setup({}, [
    new Response("busy", { status: 503 }),
    Response.json({ url: "https://lookaside.fbsbx.com/file/3" }),
    new Response(new Uint8Array([9])),
  ]);
  const res = await post(
    handler,
    payload({
      messages: [{
        from: "919800000001",
        id: "wamid.IMG2",
        timestamp: "1700000000",
        type: "image",
        image: { id: "MEDIA3", mime_type: "image/png" },
      }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(calls.length, 3);
  assert(messages.get("wamid.IMG2")!.mediaPath?.endsWith(".png"));
});

Deno.test("media failure keeps the message and records the reason (still 200)", async () => {
  const { handler, messages } = setup({}, [new Response("gone", { status: 404 })]);
  const res = await post(
    handler,
    payload({
      messages: [{
        from: "919800000001",
        id: "wamid.IMG3",
        timestamp: "1700000000",
        type: "image",
        image: { id: "MEDIA4", mime_type: "image/jpeg" },
      }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = messages.get("wamid.IMG3")!;
  assertEquals(stored.mediaPath, undefined);
  assertEquals(stored.error, "File could not be downloaded (HTTP 404)");
});

Deno.test("file larger than 16 MB is not downloaded", async () => {
  const { handler, messages, calls } = setup({}, [
    Response.json({ url: "https://lookaside.fbsbx.com/file/5", file_size: 17 * 1024 * 1024 }),
  ]);
  const res = await post(
    handler,
    payload({
      messages: [{
        from: "919800000001",
        id: "wamid.BIG",
        timestamp: "1700000000",
        type: "document",
        document: { id: "MEDIA5", mime_type: "application/pdf", filename: "big.pdf" },
      }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(calls.length, 1);
  assertEquals(messages.get("wamid.BIG")!.error, "File is larger than 16 MB and was not stored");
});

Deno.test("unsupported file type is recorded without downloading", async () => {
  const { handler, messages, calls } = setup();
  const res = await post(
    handler,
    payload({
      messages: [{
        from: "919800000001",
        id: "wamid.DOCX",
        timestamp: "1700000000",
        type: "document",
        document: { id: "MEDIA6", mime_type: "application/zip", filename: "a.zip" },
      }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(calls.length, 0);
  assertEquals(messages.get("wamid.DOCX")!.error, "File type not supported: application/zip");
});

Deno.test("dry run stores a sample file without calling Meta", async () => {
  const { handler, messages, files, calls } = setup({ dryRun: true, token: undefined });
  const res = await post(
    handler,
    payload({
      messages: [{
        from: "919800000001",
        id: "wamid.DRYIMG",
        timestamp: "1700000000",
        type: "image",
        image: { id: "SIMULATED", mime_type: "image/png" },
      }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(calls.length, 0);
  const stored = messages.get("wamid.DRYIMG")!;
  const file = files.get(stored.mediaPath!)!;
  assertEquals(Array.from(file.bytes.slice(1, 4)), [80, 78, 71]); // "PNG"
});

Deno.test("status update is applied to the matching outgoing message", async () => {
  const { handler, outgoing } = setup();
  outgoing.set("wamid.OUT1", "sent");
  const res = await post(
    handler,
    payload({
      statuses: [{ id: "wamid.OUT1", status: "delivered", timestamp: "1700000001", recipient_id: "919800000001" }],
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, stored: 0, duplicates: 0, statuses: 1, reactions: 0, ignored: 0 });
  assertEquals(outgoing.get("wamid.OUT1"), "delivered");
});

Deno.test("failed status carries the reason from Meta", async () => {
  let captured: unknown[] = [];
  const store: WebhookStore = {
    ingestIncoming: () => Promise.resolve(null),
    saveMedia: () => Promise.resolve(),
    setMessageError: () => Promise.resolve(),
    applyStatus: (...args) => {
      captured = args;
      return Promise.resolve(true);
    },
    applyReaction: () => Promise.resolve(false),
  };
  const h = createWebhookHandler({
    env: { appSecret: SECRET, graphVersion: "v26.0", dryRun: false },
    store,
  });
  const res = await post(
    h,
    payload({
      statuses: [{
        id: "wamid.OUT2",
        status: "failed",
        errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "More than 24 hours" } }],
      }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(captured, [
    "wamid.OUT2",
    "failed",
    "The 24-hour window is closed. Send a template message; free text works again after the customer replies. (code 131047)",
  ]);
});

Deno.test("unknown status for unknown message is ignored, not an error", async () => {
  const { handler } = setup();
  const res = await post(handler, payload({ statuses: [{ id: "wamid.NOPE", status: "read" }, { id: "x", status: "weird" }] }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ignored, 2);
});

Deno.test("events for another phone number id are ignored", async () => {
  const { handler, messages } = setup({ phoneId: "OTHER" });
  const res = await post(handler, payload(textMessage()));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ignored, 1);
  assertEquals(messages.size, 0);
});

Deno.test("message types we do not render are recorded as 'other'", async () => {
  const { handler, messages } = setup();
  const res = await post(
    handler,
    payload({
      messages: [
        { from: "919800000001", id: "wamid.ORDER", timestamp: "1700000000", type: "order", order: { catalog_id: "1" } },
        {
          from: "919800000001",
          id: "wamid.UNSUP",
          timestamp: "1700000000",
          type: "unsupported",
          errors: [{ code: 131051, title: "Message type unknown", message: "Message type unknown" }],
          unsupported: { type: "poll_update" },
        },
        {
          from: "919800000001",
          id: "wamid.UNKNOWN",
          timestamp: "1700000000",
          type: "unsupported",
          errors: [{ code: 131051, title: "Message type unknown" }],
        },
        {
          from: "919800000001",
          id: "wamid.SYSTEM",
          timestamp: "1700000000",
          type: "system",
          system: { body: "User A changed from 919800000001 to 919800000009", type: "user_changed_number" },
        },
      ],
    }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).stored, 4);
  assertEquals(messages.get("wamid.ORDER")!.type, "other");
  assertEquals(messages.get("wamid.ORDER")!.body, "[Unsupported message type: order]");
  assertEquals(messages.get("wamid.UNSUP")!.body, "[Unsupported message type: poll_update]");
  assert(messages.get("wamid.UNKNOWN")!.body!.startsWith("[Message type not supported by the WhatsApp Business API"));
  assertEquals(messages.get("wamid.SYSTEM")!.body, "User A changed from 919800000001 to 919800000009");
});

Deno.test("malformed payloads never crash: invalid JSON is 400, odd shapes are ignored", async () => {
  const { handler, messages } = setup();
  const bad = await post(handler, "{not json");
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  const odd = await post(handler, JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: "x" }, null, 5] }));
  assertEquals(odd.status, 200);
  await odd.body?.cancel();
  const badSender = await post(
    handler,
    payload({ messages: [{ from: "abc", id: "wamid.X", type: "text", text: { body: "x" } }] }),
  );
  assertEquals((await badSender.json()).ignored, 1);
  assertEquals(messages.size, 0);
});

Deno.test("database failure returns 500 so Meta retries", async () => {
  const handler = createWebhookHandler({
    env: { appSecret: SECRET, graphVersion: "v26.0", dryRun: false },
    store: {
      ingestIncoming: () => Promise.reject(new Error("db down")),
      saveMedia: () => Promise.resolve(),
      setMessageError: () => Promise.resolve(),
      applyStatus: () => Promise.resolve(false),
      applyReaction: () => Promise.resolve(false),
    },
  });
  const res = await post(handler, payload(textMessage()));
  assertEquals(res.status, 500);
  await res.body?.cancel();
});

Deno.test("other HTTP methods are rejected", async () => {
  const { handler } = setup();
  const res = await handler(new Request(URL_, { method: "PUT" }));
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

// --- Every Cloud API message type ---------------------------------------------

const from = { from: "919800000001", timestamp: "1700000000" };

Deno.test("voice note: stored as audio with the voice flag and an Opus content type", async () => {
  const { handler, messages, files } = setup({}, [
    Response.json({ url: "https://lookaside.fbsbx.com/file/a", mime_type: "audio/ogg; codecs=opus", file_size: 3 }),
    new Response(new Uint8Array([79, 103, 103])),
  ]);
  const res = await post(
    handler,
    payload({
      messages: [{
        ...from,
        id: "wamid.VOICE",
        type: "audio",
        audio: { id: "MEDIA_A", mime_type: "audio/ogg; codecs=opus", sha256: "x", voice: true },
      }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = messages.get("wamid.VOICE")!;
  assertEquals(stored.type, "audio");
  assertEquals(stored.mediaVoice, true);
  assertEquals(stored.mediaMime, "audio/ogg");
  assert(stored.mediaPath?.endsWith(".ogg"));
  assertEquals(files.get(stored.mediaPath!)!.mime, "audio/ogg; codecs=opus");
});

Deno.test("video with caption and sticker are stored with their files", async () => {
  const { handler, messages } = setup({}, [
    Response.json({ url: "https://lookaside.fbsbx.com/file/v" }),
    new Response(new Uint8Array([1])),
    Response.json({ url: "https://lookaside.fbsbx.com/file/s" }),
    new Response(new Uint8Array([2])),
  ]);
  const res = await post(
    handler,
    payload({
      messages: [
        { ...from, id: "wamid.VIDEO", type: "video", video: { id: "MEDIA_V", mime_type: "video/mp4", caption: "watch" } },
        { ...from, id: "wamid.STICKER", type: "sticker", sticker: { id: "MEDIA_S", mime_type: "image/webp", animated: false } },
      ],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(messages.get("wamid.VIDEO")!.type, "video");
  assertEquals(messages.get("wamid.VIDEO")!.body, "watch");
  assert(messages.get("wamid.VIDEO")!.mediaPath?.endsWith(".mp4"));
  assertEquals(messages.get("wamid.STICKER")!.type, "sticker");
  assert(messages.get("wamid.STICKER")!.mediaPath?.endsWith(".webp"));
});

Deno.test("a file type that does not fit its message type is refused (PDF sent as image)", async () => {
  const { handler, messages, calls } = setup();
  const res = await post(
    handler,
    payload({ messages: [{ ...from, id: "wamid.FAKEIMG", type: "image", image: { id: "M", mime_type: "application/pdf" } }] }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(calls.length, 0);
  assertEquals(messages.get("wamid.FAKEIMG")!.error, "File type not supported: application/pdf");
});

Deno.test("office documents are stored", async () => {
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const { handler, messages } = setup({}, [
    Response.json({ url: "https://lookaside.fbsbx.com/file/d" }),
    new Response(new Uint8Array([80, 75])),
  ]);
  const res = await post(
    handler,
    payload({ messages: [{ ...from, id: "wamid.DOCX2", type: "document", document: { id: "M", mime_type: docx, filename: "offer.docx" } }] }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assert(messages.get("wamid.DOCX2")!.mediaPath?.endsWith(".docx"));
});

Deno.test("expired token while downloading media gives a clear reason", async () => {
  const { handler, messages } = setup({}, [new Response("{}", { status: 401 })]);
  const res = await post(
    handler,
    payload({ messages: [{ ...from, id: "wamid.IMG401", type: "image", image: { id: "M", mime_type: "image/jpeg" } }] }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(
    messages.get("wamid.IMG401")!.error,
    "File could not be downloaded: the WhatsApp access token is invalid or expired",
  );
});

Deno.test("location message keeps coordinates, name and address", async () => {
  const { handler, messages } = setup();
  const res = await post(
    handler,
    payload({
      messages: [{
        ...from,
        id: "wamid.LOC",
        type: "location",
        location: { latitude: 19.076, longitude: 72.8777, name: "Gateway of India", address: "Apollo Bandar, Mumbai" },
      }, { ...from, id: "wamid.BADLOC", type: "location", location: { latitude: "x", longitude: 500 } }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = messages.get("wamid.LOC")!;
  assertEquals(stored.type, "location");
  assertEquals(stored.body, "Gateway of India");
  assertEquals(stored.location, {
    latitude: 19.076,
    longitude: 72.8777,
    name: "Gateway of India",
    address: "Apollo Bandar, Mumbai",
    url: null,
  });
  assertEquals(messages.get("wamid.BADLOC")!.type, "other");
});

Deno.test("contacts message keeps names and phone numbers", async () => {
  const { handler, messages } = setup();
  const res = await post(
    handler,
    payload({
      messages: [{
        ...from,
        id: "wamid.CONTACT",
        type: "contacts",
        contacts: [{
          name: { formatted_name: "Ravi Kumar", first_name: "Ravi" },
          phones: [{ phone: "+91 98000 00002", wa_id: "919800000002", type: "CELL" }],
        }],
      }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const stored = messages.get("wamid.CONTACT")!;
  assertEquals(stored.type, "contacts");
  assertEquals(stored.body, "Ravi Kumar");
  assertEquals(stored.contacts, [{ name: "Ravi Kumar", phones: ["+91 98000 00002"] }]);
});

Deno.test("interactive replies and template buttons are stored with their label", async () => {
  const { handler, messages } = setup();
  const res = await post(
    handler,
    payload({
      messages: [
        {
          ...from,
          id: "wamid.BTNREPLY",
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes please" } },
          context: { from: "15550001111", id: "wamid.OURS" },
        },
        {
          ...from,
          id: "wamid.LISTREPLY",
          type: "interactive",
          interactive: { type: "list_reply", list_reply: { id: "row1", title: "Option one", description: "d" } },
        },
        { ...from, id: "wamid.BUTTON", type: "button", button: { payload: "STOP", text: "Stop promotions" } },
      ],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(messages.get("wamid.BTNREPLY")!.type, "interactive");
  assertEquals(messages.get("wamid.BTNREPLY")!.body, "Yes please");
  assertEquals(messages.get("wamid.BTNREPLY")!.replyTo, "wamid.OURS");
  assertEquals(messages.get("wamid.LISTREPLY")!.body, "Option one");
  assertEquals(messages.get("wamid.BUTTON")!.type, "button");
  assertEquals(messages.get("wamid.BUTTON")!.body, "Stop promotions");
});

Deno.test("reply (quote) keeps the id of the quoted message; forwarded flag is kept", async () => {
  const { handler, messages } = setup();
  const res = await post(
    handler,
    payload({
      messages: [
        { ...from, id: "wamid.REPLY", type: "text", text: { body: "this one" }, context: { from: "15550001111", id: "wamid.QUOTED" } },
        { ...from, id: "wamid.FWD", type: "text", text: { body: "fwd" }, context: { forwarded: true } },
      ],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(messages.get("wamid.REPLY")!.replyTo, "wamid.QUOTED");
  assertEquals(messages.get("wamid.REPLY")!.forwarded, false);
  assertEquals(messages.get("wamid.FWD")!.forwarded, true);
  assertEquals(messages.get("wamid.FWD")!.replyTo, null);
});

Deno.test("reaction decorates the target message and creates no message; removal clears it", async () => {
  const { handler, messages, outgoing, reactions } = setup();
  outgoing.set("wamid.OUT9", "delivered");
  const add = await post(
    handler,
    payload({ messages: [{ ...from, id: "wamid.REACT1", type: "reaction", reaction: { message_id: "wamid.OUT9", emoji: "\u{1F44D}" } }] }),
  );
  assertEquals(await add.json(), { ok: true, stored: 0, duplicates: 0, statuses: 0, reactions: 1, ignored: 0 });
  assertEquals(reactions.get("wamid.OUT9"), "\u{1F44D}");
  assertEquals(messages.size, 0);

  // Meta omits "emoji" when the customer removes the reaction.
  const remove = await post(
    handler,
    payload({ messages: [{ ...from, id: "wamid.REACT2", type: "reaction", reaction: { message_id: "wamid.OUT9" } }] }),
  );
  assertEquals((await remove.json()).reactions, 1);
  assertEquals(reactions.get("wamid.OUT9"), "");

  const unknown = await post(
    handler,
    payload({ messages: [{ ...from, id: "wamid.REACT3", type: "reaction", reaction: { message_id: "wamid.NOPE", emoji: "x" } }] }),
  );
  assertEquals((await unknown.json()).ignored, 1);
});

Deno.test("played status (voice message listened to) is applied", async () => {
  const { handler, outgoing } = setup();
  outgoing.set("wamid.OUTV", "read");
  const res = await post(handler, payload({ statuses: [{ id: "wamid.OUTV", status: "played", timestamp: "1700000002" }] }));
  assertEquals((await res.json()).statuses, 1);
  assertEquals(outgoing.get("wamid.OUTV"), "played");
});

Deno.test("customer without a visible phone number is stored by business-scoped user id", async () => {
  const { handler, messages } = setup();
  const res = await post(
    handler,
    payload({
      contacts: [{ profile: { name: "Username User" }, user_id: "US.13491208655302741918" }],
      messages: [{
        from_user_id: "US.13491208655302741918",
        id: "wamid.BSUID",
        timestamp: "1700000000",
        type: "text",
        text: { body: "hi" },
      }],
    }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).stored, 1);
  const stored = messages.get("wamid.BSUID")!;
  assertEquals(stored.waId, null);
  assertEquals(stored.userId, "US.13491208655302741918");
  assertEquals(stored.customerName, "Username User");
});

Deno.test("phone number and user id together: both are kept", async () => {
  const { handler, messages } = setup();
  const res = await post(
    handler,
    payload({
      contacts: [{ profile: { name: "Asha" }, wa_id: "919800000001", user_id: "IN.555" }],
      messages: [{ ...from, from_user_id: "IN.555", id: "wamid.BOTH", type: "text", text: { body: "hi" } }],
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(messages.get("wamid.BOTH")!.waId, "919800000001");
  assertEquals(messages.get("wamid.BOTH")!.userId, "IN.555");
});

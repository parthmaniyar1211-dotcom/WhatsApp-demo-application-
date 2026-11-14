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
  };
  return { store, messages, files, outgoing };
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
      graphVersion: "v24.0",
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
  assertEquals(await res.json(), { ok: true, stored: 1, duplicates: 0, statuses: 0, ignored: 0 });
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
  assertEquals(await second.json(), { ok: true, stored: 0, duplicates: 1, statuses: 0, ignored: 0 });
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
  assertEquals(calls[0].url, "https://graph.facebook.com/v24.0/MEDIA1");
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

Deno.test("file larger than 10 MB is not downloaded", async () => {
  const { handler, messages, calls } = setup({}, [
    Response.json({ url: "https://lookaside.fbsbx.com/file/5", file_size: 11 * 1024 * 1024 }),
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
  assertEquals(messages.get("wamid.BIG")!.error, "File is larger than 10 MB and was not stored");
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
  assertEquals(await res.json(), { ok: true, stored: 0, duplicates: 0, statuses: 1, ignored: 0 });
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
  };
  const h = createWebhookHandler({
    env: { appSecret: SECRET, graphVersion: "v24.0", dryRun: false },
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
  assertEquals(captured, ["wamid.OUT2", "failed", "131047: More than 24 hours"]);
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

Deno.test("unsupported message types are recorded as 'other'", async () => {
  const { handler, messages } = setup();
  const res = await post(
    handler,
    payload({ messages: [{ from: "919800000001", id: "wamid.AUDIO", timestamp: "1700000000", type: "audio", audio: { id: "A" } }] }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(messages.get("wamid.AUDIO")!.type, "other");
  assertEquals(messages.get("wamid.AUDIO")!.body, "[Unsupported message type: audio]");
});

Deno.test("malformed payloads never crash: invalid JSON is 400, odd shapes are ignored", async () => {
  const { handler, messages } = setup();
  const bad = await post(handler, "{not json");
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  const odd = await post(handler, JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: "x" }, null, 5] }));
  assertEquals(odd.status, 200);
  await odd.body?.cancel();
  const badSender = await post(handler, payload({ messages: [{ from: "abc", id: "wamid.X", type: "text", text: { body: "x" } }] }));
  assertEquals((await badSender.json()).ignored, 1);
  assertEquals(messages.size, 0);
});

Deno.test("database failure returns 500 so Meta retries", async () => {
  const handler = createWebhookHandler({
    env: { appSecret: SECRET, graphVersion: "v24.0", dryRun: false },
    store: {
      ingestIncoming: () => Promise.reject(new Error("db down")),
      saveMedia: () => Promise.resolve(),
      setMessageError: () => Promise.resolve(),
      applyStatus: () => Promise.resolve(false),
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

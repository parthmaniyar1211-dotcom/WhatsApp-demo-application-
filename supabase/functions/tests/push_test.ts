import { buildPushMessage, NullPushSender, type PushDevice, selectPushTargets } from "../_shared/push.ts";
import { assert, assertEquals } from "./helpers.ts";

const dev = (token: string, userId: string, tenantId: string): PushDevice => ({ token, userId, tenantId, platform: "android" });

Deno.test("push: only devices of the message's own tenant are targeted", () => {
  const devices = [dev("t1", "u1", "A"), dev("t2", "u2", "A"), dev("t3", "u3", "B")];
  assertEquals(selectPushTargets(devices, "A").map((d) => d.token), ["t1", "t2"]);
  assertEquals(selectPushTargets(devices, "B").map((d) => d.token), ["t3"]);
  assertEquals(selectPushTargets(devices, "C"), []);
});

Deno.test("push: the sender of an action is not notified about it, and duplicate tokens are sent once", () => {
  const devices = [dev("t1", "u1", "A"), dev("t1", "u1", "A"), dev("t2", "u2", "A")];
  assertEquals(selectPushTargets(devices, "A", "u1").map((d) => d.token), ["t2"]);
  assertEquals(selectPushTargets(devices, "A").length, 2);
});

Deno.test("push: message text stays out of the notification unless previews are on", () => {
  const incoming = { tenantId: "A", conversationId: "c1", contactName: "Asha", text: "my card number is 4111" };
  const hidden = buildPushMessage(incoming);
  assertEquals(hidden.body, "New message");
  assert(!JSON.stringify(hidden).includes("4111"));
  assertEquals(hidden.data, { tenantId: "A", conversationId: "c1" });
  assertEquals(buildPushMessage(incoming, true).body, "my card number is 4111");
});

Deno.test("push: with no provider configured nothing is sent and the reason is reported", async () => {
  const result = await new NullPushSender().send();
  assertEquals(result.sent, 0);
  assert(String(result.skipped).includes("no push provider"));
});

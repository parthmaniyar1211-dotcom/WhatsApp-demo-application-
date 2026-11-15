// "Delete for me" (soft delete) and "Delete for everyone" (not supported): end to end, against a real Supabase stack
// with WA_DRY_RUN=true. Incoming WhatsApp events are simulated with the signed harness.

import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  apiCall,
  conversationItem,
  fileStillServed,
  flagOf,
  login,
  messagesOf,
  missingForE2E,
  newCustomer,
  openChat,
  openMessageMenu,
  simulateIncoming,
  simulateReaction,
  simulateStatus,
  statusOf,
} from "./helpers";

const fixture = (name: string) => fileURLToPath(new URL(`../../scripts/fixtures/${name}`, import.meta.url));

test.use({ permissions: ["microphone", "clipboard-read", "clipboard-write"] });

test.beforeEach(() => {
  const reason = missingForE2E();
  test.skip(reason !== null, reason ?? "");
});

async function start(page: Page, firstText = "First message") {
  const customer = newCustomer();
  await login(page);
  await simulateIncoming(customer, { kind: "text", text: firstText });
  await openChat(page, customer);
  return customer;
}

async function sendText(page: Page, text: string) {
  await page.getByTestId("reply-input").fill(text);
  await page.getByTestId("send-button").click();
  const bubble = page.getByTestId("message-out").filter({ hasText: text });
  await expect(bubble).toHaveCount(1);
  await expect(statusOf(bubble)).toHaveAttribute("data-status", "sent");
  return bubble;
}

/** Menu -> Delete for me -> confirm. Resolves when the dialog has closed. */
async function deleteForMe(page: Page, bubble: Locator) {
  await openMessageMenu(bubble);
  await page.getByTestId("menu-delete-me").click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("delete-dialog")).toHaveCount(0);
}

// Matches the message whose own text is exactly this (a reply that merely quotes it does not count).
const bubbleIn = (page: Page, text: string) =>
  page.getByTestId("message-in").filter({ has: page.locator("p.body").filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }) });

test("the confirmation says what will happen, and Cancel / Escape / clicking outside delete nothing", async ({ page }) => {
  const customer = await start(page, "Keep me");
  const keep = bubbleIn(page, "Keep me");
  const row = (await messagesOf(customer.from))[0];

  await openMessageMenu(keep);
  await page.getByTestId("menu-delete-me").click();
  const dialog = page.getByTestId("delete-dialog");
  await expect(dialog.getByRole("heading", { name: "Delete message?" })).toBeVisible();
  await expect(dialog).toContainText("This message will be removed from your application. The original WhatsApp message will remain unchanged.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete for me" })).toBeVisible();

  await page.getByTestId("delete-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(keep).toHaveCount(1);

  await openMessageMenu(keep);
  await page.getByTestId("menu-delete-me").click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await openMessageMenu(keep);
  await page.getByTestId("menu-delete-me").click();
  await page.mouse.click(5, 5); // on the backdrop, outside the dialog
  await expect(dialog).toHaveCount(0);

  await expect(keep).toHaveCount(1);
  expect(await flagOf(row.id)).toBeUndefined(); // nothing was written
});

test("incoming text: deleted for me, others untouched, row kept, still gone after a refresh", async ({ page }) => {
  const customer = await start(page, "Please delete this one");
  await simulateIncoming(customer, { kind: "text", text: "But keep this one" });
  await expect(page.getByTestId("message-in")).toHaveCount(2);
  const before = await messagesOf(customer.from);
  const doomed = before.find((m) => m.body === "Please delete this one")!;

  await deleteForMe(page, bubbleIn(page, "Please delete this one"));
  await expect(bubbleIn(page, "Please delete this one")).toHaveCount(0);
  await expect(bubbleIn(page, "But keep this one")).toHaveCount(1);
  await expect(page.getByTestId("chat-notice")).toContainText("Message deleted.");

  // Soft delete: the message row is intact, only this user's flag says "hidden".
  const after = await messagesOf(customer.from);
  expect(after).toHaveLength(before.length);
  expect(after.find((m) => m.id === doomed.id)).toMatchObject({ body: "Please delete this one", status: "received" });
  expect(await flagOf(doomed.id)).toMatchObject({ hidden: true });
  expect((await flagOf(doomed.id))!.hidden_at).not.toBeNull();

  await page.reload();
  await expect(bubbleIn(page, "But keep this one")).toHaveCount(1);
  await expect(bubbleIn(page, "Please delete this one")).toHaveCount(0);
});

test("outgoing text: deleted for me; its delivery status keeps updating afterwards", async ({ page }) => {
  const customer = await start(page);
  const mine = await sendText(page, "My reply");
  await sendText(page, "Another reply");
  const stored = (await messagesOf(customer.from)).find((m) => m.body === "My reply")!;

  await deleteForMe(page, mine);
  await expect(page.getByTestId("message-out").filter({ hasText: "My reply" })).toHaveCount(0);
  await expect(page.getByTestId("message-out").filter({ hasText: "Another reply" })).toHaveCount(1);

  // WhatsApp reports delivered, then read, for the message I deleted: the webhook still applies them.
  await simulateStatus(customer.from, stored.wa_message_id!, "delivered");
  await simulateStatus(customer.from, stored.wa_message_id!, "read");
  const row = (await messagesOf(customer.from)).find((m) => m.id === stored.id)!;
  expect(row.status).toBe("read");
  expect((await flagOf(stored.id))!.hidden).toBe(true);
  await expect(page.getByTestId("message-out").filter({ hasText: "My reply" })).toHaveCount(0);

  // Undo shows it again, with the status that arrived while it was hidden.
  await page.getByTestId("chat-notice").getByRole("button", { name: "Undo" }).click();
  const restored = page.getByTestId("message-out").filter({ hasText: "My reply" });
  await expect(restored).toHaveCount(1);
  await expect(statusOf(restored)).toHaveAttribute("data-status", "read");
});

for (const kind of ["image", "video", "audio", "document"] as const) {
  test(`incoming ${kind}: deleted for me, the stored file stays valid`, async ({ page }) => {
    const customer = await start(page);
    await simulateIncoming(customer, kind === "document" ? { kind, filename: "to-delete.pdf" } : { kind, text: kind === "audio" ? undefined : "cap" });
    const player = { image: "message-image", video: "message-video", audio: "message-audio", document: "message-document" }[kind];
    const bubble = page.getByTestId("message-in").filter({ has: page.getByTestId(player) });
    await expect(bubble).toHaveCount(1);
    const stored = (await messagesOf(customer.from)).find((m) => m.type === kind)!;
    expect(stored.media_path).toBeTruthy();
    expect(await fileStillServed(stored.media_path!)).toBe(true);

    await deleteForMe(page, bubble);
    await expect(bubble).toHaveCount(0);
    await expect(bubbleIn(page, "First message")).toHaveCount(1); // unrelated message untouched

    // The row and the file are retained, and a fresh signed URL still works.
    const row = (await messagesOf(customer.from)).find((m) => m.id === stored.id)!;
    expect(row.media_path).toBe(stored.media_path);
    expect(await fileStillServed(stored.media_path!)).toBe(true);
    await page.reload();
    await expect(bubble).toHaveCount(0);
  });
}

test("outgoing photo and PDF (sent from the app): deleted for me, files kept", async ({ page }) => {
  const customer = await start(page);
  await page.getByTestId("file-input").setInputFiles(fixture("sample.png"));
  await page.getByTestId("reply-input").fill("Photo for you");
  await page.getByTestId("send-button").click();
  const photo = page.getByTestId("message-out").filter({ hasText: "Photo for you" });
  await expect(photo.getByTestId("message-image")).toBeVisible();
  await page.getByTestId("file-input").setInputFiles(fixture("sample.pdf"));
  await page.getByTestId("send-button").click();
  const pdf = page.getByTestId("message-out").filter({ has: page.getByTestId("message-document") });
  await expect(pdf).toHaveCount(1);
  const sent = (await messagesOf(customer.from)).filter((m) => m.direction === "out" && m.media_path);
  expect(sent).toHaveLength(2);

  await deleteForMe(page, photo);
  await deleteForMe(page, pdf);
  await expect(page.getByTestId("message-out")).toHaveCount(0);
  for (const message of sent) expect(await fileStillServed(message.media_path!)).toBe(true);
});

test("Undo brings the message back", async ({ page }) => {
  const customer = await start(page, "Undo me");
  const row = (await messagesOf(customer.from))[0];
  await deleteForMe(page, bubbleIn(page, "Undo me"));
  await expect(bubbleIn(page, "Undo me")).toHaveCount(0);
  await page.getByTestId("chat-notice").getByRole("button", { name: "Undo" }).click();
  await expect(bubbleIn(page, "Undo me")).toHaveCount(1);
  await expect(page.getByTestId("chat-notice")).toContainText("Message restored.");
  expect(await flagOf(row.id)).toBeUndefined();
});

test("Delete for everyone is visible but unavailable: it explains the limit and calls nothing", async ({ page }) => {
  const customer = await start(page);
  await sendText(page, "Cannot be unsent");
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/functions/v1/")) requests.push(r.url());
    if (r.url().includes("delete_message")) requests.push(r.url());
  });

  const bubble = page.getByTestId("message-out").filter({ hasText: "Cannot be unsent" });
  await openMessageMenu(bubble);
  const item = page.getByTestId("menu-delete-everyone");
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await item.click({ force: true }); // aria-disabled only: a real user can click it to read the reason

  const dialog = page.getByTestId("everyone-dialog");
  await expect(dialog).toContainText("Delete for everyone is not supported through the current WhatsApp Cloud API integration.");
  await expect(dialog).toContainText("The message can only be removed from this application’s view using Delete for me.");
  await page.getByTestId("everyone-close").click();
  await expect(dialog).toHaveCount(0);

  // "Delete for me instead" leads to the normal confirmation; nothing is deleted before it is confirmed.
  await openMessageMenu(bubble);
  await page.getByTestId("menu-delete-everyone").click({ force: true });
  await page.getByTestId("everyone-delete-me").click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await page.getByTestId("delete-cancel").click();
  await expect(bubble).toHaveCount(1);

  expect(requests, "no call to WhatsApp or to a delete function was made").toEqual([]);
  const row = (await messagesOf(customer.from)).find((m) => m.body === "Cannot be unsent")!;
  expect(row.status).toBe("sent");
  expect(await flagOf(row.id)).toBeUndefined();
});

test("deleted messages do not leak: chat list, Starred, info panel, quotes, reply target", async ({ page }) => {
  const customer = await start(page, "Old message");
  const first = (await messagesOf(customer.from))[0];
  await simulateIncoming(customer, { kind: "text", text: "Secret last message" });
  await expect(page.getByTestId("message-in")).toHaveCount(2);
  const item = conversationItem(page, customer.from);
  await expect(item.getByTestId("chat-preview")).toHaveText("Secret last message");

  // Star the old one, quote it, then delete things.
  await openMessageMenu(bubbleIn(page, "Old message"));
  await page.getByRole("menuitem", { name: "Star", exact: true }).click();
  await expect(bubbleIn(page, "Old message").getByTestId("star-mark")).toBeVisible();
  await simulateIncoming(customer, { kind: "text", text: "I mean the old one", replyTo: first.wa_message_id! });
  const quoting = bubbleIn(page, "I mean the old one");
  await expect(quoting.getByTestId("quote")).toContainText("Old message");

  // 1. Delete the newest message: the chat list falls back to the newest message that is NOT deleted.
  await deleteForMe(page, bubbleIn(page, "I mean the old one"));
  await expect(item.getByTestId("chat-preview")).toHaveText("Secret last message");
  await deleteForMe(page, bubbleIn(page, "Secret last message"));
  await expect(item.getByTestId("chat-preview")).toHaveText("Old message");
  await expect(item).not.toContainText("Secret last message");

  // 2. Delete the starred message: it leaves the Starred list and the info panel; replies that quote it show a placeholder.
  await simulateIncoming(customer, { kind: "text", text: "Quoting again", replyTo: first.wa_message_id! });
  await expect(bubbleIn(page, "Quoting again").getByTestId("quote")).toContainText("Old message");
  await page.getByTestId("info-button").click();
  await expect(page.getByTestId("info-starred")).toContainText("Old message");
  await page.getByRole("button", { name: "Close contact info" }).click();
  if (await page.getByTestId("filter-starred").isHidden()) await page.getByRole("link", { name: "Back to chats" }).click();
  await page.getByTestId("filter-starred").click();
  await expect(page.getByTestId("starred-item").filter({ hasText: customer.name })).toHaveCount(1); // listed while not deleted
  await page.getByTestId("filter-all").click();
  await conversationItem(page, customer.from).click();
  await deleteForMe(page, bubbleIn(page, "Old message"));
  await expect(bubbleIn(page, "Quoting again").getByTestId("quote")).toContainText("You deleted this message");
  await expect(bubbleIn(page, "Quoting again").getByTestId("quote")).not.toContainText("Old message");
  await page.getByTestId("info-button").click();
  await expect(page.getByTestId("info-starred")).toHaveCount(0);
  await page.getByRole("button", { name: "Close contact info" }).click();
  if (await page.getByTestId("filter-starred").isHidden()) await page.getByRole("link", { name: "Back to chats" }).click();
  await page.getByTestId("filter-starred").click();
  // (other chats of earlier runs may have starred messages of their own: look only at this customer)
  await expect(page.getByTestId("starred-item").filter({ hasText: customer.name })).toHaveCount(0);
  await page.getByTestId("filter-all").click();
  await conversationItem(page, customer.from).click();

  // 3. Delete everything that is left: an explanation and a way back, never a blank screen.
  await deleteForMe(page, bubbleIn(page, "Quoting again"));
  await expect(page.getByTestId("empty-chat")).toContainText("You deleted all the messages loaded in this chat.");
  await expect(item.getByTestId("chat-preview")).toHaveText("You deleted all messages");
  await page.getByTestId("show-deleted").click();
  await expect(bubbleIn(page, "Quoting again")).toHaveCount(1);
  await expect(bubbleIn(page, "Secret last message")).toHaveCount(1);
});

test("a deleted message cannot be the reply target", async ({ page }) => {
  await start(page, "Reply to this");
  await openMessageMenu(bubbleIn(page, "Reply to this"));
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(page.getByTestId("reply-preview")).toBeVisible();
  await deleteForMe(page, bubbleIn(page, "Reply to this"));
  await expect(page.getByTestId("reply-preview")).toHaveCount(0);
});

test("Copy message copies text, captions, file names; it is disabled when there is nothing to copy", async ({ page }) => {
  const customer = await start(page, "Copy this text");
  await simulateIncoming(customer, { kind: "image" }); // photo without caption
  await simulateIncoming(customer, { kind: "document", filename: "price-list.pdf" });
  await simulateIncoming(customer, { kind: "audio" });

  await openMessageMenu(bubbleIn(page, "Copy this text"));
  await page.getByTestId("menu-copy").click();
  await expect(page.getByTestId("chat-notice")).toContainText("Copied to the clipboard.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Copy this text");

  await openMessageMenu(page.getByTestId("message-in").filter({ has: page.getByTestId("message-document") }));
  await page.getByTestId("menu-copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("price-list.pdf");

  await openMessageMenu(page.getByTestId("message-in").filter({ has: page.getByTestId("message-image") }));
  await expect(page.getByTestId("menu-copy")).toBeDisabled();
  await page.keyboard.press("Escape");
  await openMessageMenu(page.getByTestId("message-in").filter({ has: page.getByTestId("message-audio") }));
  await expect(page.getByTestId("menu-copy")).toBeDisabled();
  // Reply, Star, Delete for me and Delete for everyone are all there for every kind of message.
  for (const id of ["menu-delete-me", "menu-delete-everyone"]) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Star", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
});

test("reactions, replies and normal messaging keep working around deletions", async ({ page }) => {
  const customer = await start(page, "Hello there");
  const mine = await sendText(page, "I will delete this");
  const stored = (await messagesOf(customer.from)).find((m) => m.body === "I will delete this")!;
  await deleteForMe(page, mine);

  // New traffic in both directions still works.
  await simulateIncoming(customer, { kind: "text", text: "After the deletion" });
  await expect(bubbleIn(page, "After the deletion")).toHaveCount(1);
  const reply = await sendText(page, "Reply after deletion");
  await expect(reply).toHaveCount(1);
  await simulateReaction(customer, (await messagesOf(customer.from)).find((m) => m.body === "Reply after deletion")!.wa_message_id!, "👍");
  await expect(reply.getByTestId("reaction-customer")).toHaveText("👍");
  expect((await messagesOf(customer.from)).some((m) => m.id === stored.id)).toBe(true);
});

test("unauthorized attempts are refused by the server", async () => {
  const customer = newCustomer();
  await simulateIncoming(customer, { kind: "text", text: "Target" });
  const target = (await messagesOf(customer.from))[0];

  const anonymous = await apiCall("rpc/delete_message_for_me", { p_message_id: target.id }, "anon");
  expect(anonymous.status).toBeGreaterThanOrEqual(400);
  const forged = await apiCall("rpc/delete_message_for_me", { p_message_id: target.id }, "forged");
  expect(forged.status).toBe(401);
  const unknown = await apiCall("rpc/delete_message_for_me", { p_message_id: "00000000-0000-4000-8000-000000000000" }, "owner");
  expect(unknown.status).toBeGreaterThanOrEqual(400);
  expect(unknown.json.message).toContain("Message not found");
  const directWrite = await apiCall("message_flags", { user_id: "00000000-0000-4000-8000-000000000001", message_id: target.id, hidden: true }, "owner");
  expect([401, 403]).toContain(directWrite.status); // no table grant: only the functions can write
  const directDelete = await apiCall("rpc/restore_message_for_me", { p_message_id: "not-a-uuid" }, "owner");
  expect(directDelete.status).toBeGreaterThanOrEqual(400);

  // None of the attempts deleted or hid anything.
  expect(await messagesOf(customer.from)).toHaveLength(1);
  expect(await flagOf(target.id)).toBeUndefined();
});

test("layout: the menu and the dialogs fit on desktop and on a phone", async ({ page }, testInfo) => {
  const phone = testInfo.project.name === "phone";
  await start(page, "Layout check");
  const viewport = page.viewportSize()!;
  const bubble = bubbleIn(page, "Layout check");

  await openMessageMenu(bubble);
  const popover = page.getByRole("menu");
  const box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  // Phone: a sheet along the bottom edge; desktop: a popover next to the bubble.
  if (phone) expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
  await page.screenshot({ path: testInfo.outputPath("menu.png") });

  await page.getByTestId("menu-delete-me").click();
  const dialog = page.getByTestId("delete-dialog");
  const dialogBox = (await dialog.boundingBox())!;
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height + 1);
  await expect(page.getByTestId("delete-confirm")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("dialog.png") });
  await page.getByTestId("delete-cancel").click();

  // Click outside the menu closes it.
  await openMessageMenu(bubble);
  await expect(popover).toBeVisible();
  await page.mouse.click(viewport.width / 2, 10);
  await expect(popover).toHaveCount(0);
});

test("a failed deletion shows the error inside the dialog and deletes nothing", async ({ page }) => {
  const customer = await start(page, "Network will fail");
  const row = (await messagesOf(customer.from))[0];
  await page.route("**/rest/v1/rpc/delete_message_for_me", (route) => route.fulfill({ status: 500, json: { message: "boom" } }));

  await openMessageMenu(bubbleIn(page, "Network will fail"));
  await page.getByTestId("menu-delete-me").click();
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("delete-error")).toContainText("Could not delete the message");
  await expect(bubbleIn(page, "Network will fail")).toHaveCount(1); // still there

  await page.unroute("**/rest/v1/rpc/delete_message_for_me");
  await page.getByTestId("delete-confirm").click(); // "Try again"
  await expect(page.getByTestId("delete-dialog")).toHaveCount(0);
  await expect(bubbleIn(page, "Network will fail")).toHaveCount(0);
  expect((await flagOf(row.id))!.hidden).toBe(true);
});

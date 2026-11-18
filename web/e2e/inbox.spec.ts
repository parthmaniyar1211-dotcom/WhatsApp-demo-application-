// End-to-end test against a REAL Supabase project (hosted, or `supabase start`).
// Incoming WhatsApp messages are simulated with the harness in ../scripts (signed like Meta).
//
// Needs web/.env and ../.env (see .env.example files). Skipped with a message otherwise.
// The reply steps expect WA_DRY_RUN=true on the server, because the simulated customer
// number does not exist on WhatsApp.

import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  env,
  conversationItem,
  closeSettings,
  openSettings,
  latestOutgoing,
  login,
  missingForE2E,
  newCustomer,
  signOut,
  simulateIncoming,
  simulateStatus,
  statusOf,
} from "./helpers";

const fixture = (name: string) => fileURLToPath(new URL(`../../scripts/fixtures/${name}`, import.meta.url));

test.beforeEach(() => {
  const reason = missingForE2E();
  test.skip(reason !== null, reason ?? "");
});

test("incoming message appears live, staff replies, statuses update", async ({ page }, testInfo) => {
  const customer = newCustomer();
  const isPhone = testInfo.project.name === "phone";

  await login(page);

  // 1. A customer writes. The inbox must show it without a reload.
  await simulateIncoming(customer, { kind: "text", text: "Hi, is my order ready?" });
  const item = conversationItem(page, customer.from);
  await expect(item).toBeVisible();
  await expect(item).toContainText(customer.name);
  await expect(item).toContainText("Hi, is my order ready?");
  await expect(item.getByTestId("unread-badge")).toHaveText("1");
  // Newest activity is on top.
  await expect(page.getByTestId("conversation-item").first()).toHaveAttribute("data-wa-id", customer.from);

  // A second message raises the unread count, still without a reload.
  await simulateIncoming(customer, { kind: "text", text: "Hello?" });
  await expect(item.getByTestId("unread-badge")).toHaveText("2");
  await page.screenshot({ path: testInfo.outputPath("1-inbox.png") });

  // Search by number and by name.
  const search = page.getByLabel("Search chats and messages");
  await search.fill(customer.from.slice(-8));
  await expect(page.getByTestId("conversation-item")).toHaveCount(1);
  await search.fill("zzz-no-such-customer");
  await expect(page.getByText("No chat or message matches")).toBeVisible();
  await search.fill(customer.name.toLowerCase());
  await expect(item).toBeVisible();
  await search.fill("");

  // 2. Open the conversation: messages are shown and the chat is marked as read.
  await item.click();
  await expect(page.getByTestId("conversation-title")).toHaveText(customer.name);
  await expect(page.getByTestId("message-in")).toHaveCount(2);
  await expect(page.getByTestId("message-in").first()).toContainText("Hi, is my order ready?");
  await expect(page.getByTestId("window-open")).toBeVisible();
  if (!isPhone) await expect(item.getByTestId("unread-badge")).toHaveCount(0);

  // 3. Reply. The outgoing bubble shows the text, the sender's staff ID and a status.
  await page.getByTestId("reply-input").fill("Yes, it is ready for pickup.");
  await page.getByTestId("send-button").click();
  const reply = page.getByTestId("message-out").filter({ hasText: "Yes, it is ready for pickup." });
  await expect(reply).toHaveCount(1);
  await expect(statusOf(reply)).toHaveAttribute("data-status", /sent|delivered|read/);
  await expect(page.getByTestId("reply-input")).toHaveValue("");

  // 4. WhatsApp reports "delivered", then "read": the bubble follows live.
  const sent = await latestOutgoing(customer.from);
  expect(sent.wa_message_id).toBeTruthy();
  const dryRun = sent.wa_message_id!.startsWith("wamid.DRYRUN.");
  await simulateStatus(customer.from, sent.wa_message_id!, "delivered");
  await expect(statusOf(reply)).toHaveAttribute("data-status", "delivered");
  await expect(statusOf(reply)).toHaveAttribute("aria-label", "Delivered");
  await simulateStatus(customer.from, sent.wa_message_id!, "read");
  await expect(statusOf(reply)).toHaveAttribute("data-status", "read");
  // A late "delivered" must not move the message backwards.
  const config = await import("../../scripts/lib/meta.mjs");
  const late = await config.postWebhook(
    config.harnessConfig().webhookUrl,
    config.statusPayload({
      phoneId: config.harnessConfig().phoneId,
      to: customer.from,
      messageId: sent.wa_message_id!,
      status: "delivered",
    }),
    config.harnessConfig().appSecret,
  );
  expect(late.json?.statuses).toBe(0);
  await expect(statusOf(reply)).toHaveAttribute("data-status", "read");

  // 6. Files both ways (only in dry run: the simulated media does not exist at Meta).
  if (dryRun) {
    await simulateIncoming(customer, { kind: "image", text: "Here is a photo" });
    const photo = page.getByTestId("message-in").filter({ hasText: "Here is a photo" }).getByTestId("message-image");
    await expect(photo).toBeVisible();
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    await simulateIncoming(customer, { kind: "document", filename: "invoice-123.pdf" });
    const pdf = page.getByTestId("message-in").getByTestId("message-document");
    await expect(pdf).toContainText("invoice-123.pdf");
    await expect(pdf.getByTestId("document-details")).toHaveText("PDF · 598 B");
    await expect(pdf).toHaveAttribute("href", /\/storage\/v1\/object\/sign\/files\/incoming\/.+token=/);

    await page.getByTestId("file-input").setInputFiles(fixture("sample.png"));
    await expect(page.getByTestId("attachment")).toContainText("sample.png");
    await page.getByTestId("reply-input").fill("Photo of your parcel");
    await page.getByTestId("send-button").click();
    const sentPhoto = page.getByTestId("message-out").filter({ hasText: "Photo of your parcel" });
    await expect(sentPhoto.getByTestId("message-image")).toBeVisible();
    await expect(page.getByTestId("attachment")).toHaveCount(0);

    await page.getByTestId("file-input").setInputFiles(fixture("sample.pdf"));
    await page.getByTestId("send-button").click();
    await expect(page.getByTestId("message-out").getByTestId("message-document")).toContainText("sample.pdf");
  }

  // A file type that is not allowed is refused in the app before any upload.
  await page.getByTestId("file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not allowed"),
  });
  await expect(page.getByTestId("composer-error")).toContainText("Only JPEG or PNG photos, PDF files");
  await page.screenshot({ path: testInfo.outputPath("2-conversation.png") });

  // 7. The session survives a reload.
  await page.reload();
  await expect(page.getByTestId("conversation-title")).toHaveText(customer.name);
  await expect(page.getByTestId("message-out").first()).toBeVisible();

  // 8. Back to the list (phone: back button), then sign out.
  if (isPhone) {
    await page.getByRole("link", { name: "Back to chats" }).click();
    await expect(conversationItem(page, customer.from)).toBeVisible();
  }
  await signOut(page);
});

test("closed 24-hour window: free text is disabled and the template sender is shown", async ({ page }, testInfo) => {
  const customer = newCustomer();
  await login(page);

  // The customer's only message is 25 hours old.
  await simulateIncoming(customer, { kind: "text", text: "Old question", hoursAgo: 25 });
  await conversationItem(page, customer.from).click();

  await expect(page.getByTestId("window-closed")).toContainText("Send a template message to start");
  await expect(page.getByTestId("reply-input")).toHaveCount(0);
  await expect(page.getByTestId("template-sender").locator("textarea")).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("3-window-closed.png") });

  await page.getByTestId("send-template").click();
  const template = page.getByTestId("message-out").filter({ hasText: "hello_world" });
  await expect(template).toHaveCount(1);
  await expect(statusOf(template)).toHaveAttribute("data-status", /sent|delivered|read|failed/);

  // WhatsApp later reports that delivery failed: the bubble shows the reason.
  const sent = await latestOutgoing(customer.from);
  if (sent.wa_message_id && sent.status === "sent") {
    await simulateStatus(customer.from, sent.wa_message_id, "failed");
    await expect(statusOf(template)).toHaveAttribute("data-status", "failed");
    await expect(template.getByTestId("message-error")).toContainText("Message could not be delivered");
  }

  // When the customer answers, the window opens again without a reload.
  await simulateIncoming(customer, { kind: "text", text: "Thanks, I am back" });
  await expect(page.getByTestId("window-open")).toBeVisible();
  await expect(page.getByTestId("reply-input")).toBeEnabled();
});

test("offline banner, and messages that arrived while offline show up after reconnecting", async ({ page, context }) => {
  const customer = newCustomer();
  await login(page);

  await context.setOffline(true);
  await expect(page.getByText("You are offline.")).toBeVisible();
  await openSettings(page);
  await expect(page.getByTestId("live-status")).toHaveText("Offline");
  await closeSettings(page);

  // Arrives while this browser has no connection.
  await simulateIncoming(customer, { kind: "text", text: "Sent while you were offline" });

  await context.setOffline(false);
  await openSettings(page);
  await expect(page.getByTestId("live-status")).toHaveText("Live");
  await closeSettings(page);
  const item = conversationItem(page, customer.from);
  await expect(item).toContainText("Sent while you were offline");
  await expect(item.getByTestId("unread-badge")).toHaveText("1");
});

test("wrong password is rejected with a clear message", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Staff ID").fill(env.staffId);
  await page.getByLabel("Password").fill("definitely-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Wrong Staff ID or password");
});

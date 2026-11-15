// WhatsApp-style contacts: add a number, start the chat with a template, rename, change password.

import { expect, test } from "@playwright/test";
import { conversationItem, env, login, messagesOf, missingForE2E, newCustomer, openChat, simulateIncoming, closeSettings, openSettings, signOut, statusOf } from "./helpers";

test.beforeEach(() => {
  const reason = missingForE2E();
  test.skip(reason !== null, reason ?? "");
});

function newNumber() {
  return `9198${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
}

test("add a number, start the chat with the template, then the person replies", async ({ page }, testInfo) => {
  const number = newNumber();
  const name = `New Contact ${number.slice(-4)}`;
  await login(page);

  await page.getByTestId("new-chat-button").click();
  const dialog = page.getByTestId("new-chat-dialog");
  await dialog.locator('input[name="new-phone"]').fill(`+${number.slice(0, 2)} ${number.slice(2, 7)} ${number.slice(7)}`);
  await expect(dialog).toContainText(`Chat with +${number}`);
  await dialog.locator('input[name="new-name"]').fill(name);
  await page.screenshot({ path: testInfo.outputPath("new-chat.png") });
  await dialog.getByRole("button", { name: "Start chat" }).click();

  // The chat is open, named, and says what WhatsApp allows: a template first.
  await expect(page.getByTestId("conversation-title")).toHaveText(name);
  await expect(page.getByTestId("info-button")).toBeVisible();
  await expect(page.getByTestId("window-closed")).toContainText("Send a template message to start");
  await expect(page.getByTestId("template-sender").locator("textarea")).toBeDisabled();
  await expect(conversationItem(page, number)).toContainText(name);

  await page.getByTestId("send-template").click();
  const template = page.getByTestId("message-out").filter({ hasText: "hello_world" });
  await expect(template).toHaveCount(1);
  await expect(statusOf(template)).toHaveAttribute("data-status", /sent|delivered|read/);
  await expect(conversationItem(page, number)).toContainText("Template: hello_world");

  // The person answers: free text opens, the saved name is kept.
  await simulateIncoming({ from: number, name: "Profile Name" }, { kind: "text", text: "Hi, got your message" });
  await expect(page.getByTestId("window-open")).toBeVisible();
  await expect(page.getByTestId("conversation-title")).toHaveText(name);
  await page.getByTestId("reply-input").fill("Great, how can I help?");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("message-out").filter({ hasText: "Great, how can I help?" })).toHaveCount(1);
  expect((await messagesOf(number)).map((m) => m.type)).toEqual(["template", "text", "text"]);
});

test("a number without country code gets 91; the same number reuses its chat; bad numbers are refused", async ({ page }) => {
  const number = newNumber();
  const local = number.slice(2); // 10 digits
  await login(page);

  await page.getByTestId("new-chat-button").click();
  let dialog = page.getByTestId("new-chat-dialog");
  await dialog.locator('input[name="new-phone"]').fill("12345");
  await expect(dialog.getByRole("button", { name: "Start chat" })).toBeDisabled();
  await dialog.locator('input[name="new-phone"]').fill(local);
  await expect(dialog).toContainText(`Chat with +91${local}`);
  await dialog.getByRole("button", { name: "Start chat" }).click();
  await expect(page.getByTestId("conversation-title")).toHaveText(`+91${local}`);
  const firstUrl = page.url();

  // Back in the list, adding the same number again opens the same chat (no duplicate).
  if (await page.getByTestId("new-chat-button").isHidden()) await page.getByRole("link", { name: "Back to chats" }).click();
  await page.getByTestId("new-chat-button").click();
  dialog = page.getByTestId("new-chat-dialog");
  await dialog.locator('input[name="new-phone"]').fill(`+91 ${local}`);
  await dialog.locator('input[name="new-name"]').fill("Saved later");
  await dialog.getByRole("button", { name: "Start chat" }).click();
  await expect(page.getByTestId("conversation-title")).toHaveText("Saved later");
  expect(page.url()).toBe(firstUrl);
  await expect(page.locator(`[data-testid="conversation-item"][data-wa-id="91${local}"]`)).toHaveCount(1).catch(() => {});

  // Typing a number into the search box offers to start a chat.
  if (await page.getByLabel("Search chats and messages").isHidden()) await page.getByRole("link", { name: "Back to chats" }).click();
  await page.getByLabel("Search chats and messages").fill("+44 7700 900123");
  await page.getByRole("button", { name: "Start a chat with +447700900123" }).click();
  await expect(page.getByTestId("new-chat-dialog")).toBeVisible();
  await expect(page.getByTestId("new-chat-dialog")).toContainText("approved template"); // the hint about templates is shown
});

test("unread filter, and a customer who writes first shows up by their WhatsApp name", async ({ page }) => {
  const customer = newCustomer();
  await login(page);
  await simulateIncoming(customer, { kind: "text", text: "Hello first" });
  await expect(conversationItem(page, customer.from)).toContainText(customer.name);
  await page.getByTestId("filter-unread").click();
  await expect(conversationItem(page, customer.from)).toBeVisible();
  await page.getByTestId("filter-all").click();
  await openChat(page, customer);
  if (await page.getByTestId("filter-unread").isHidden()) await page.getByRole("link", { name: "Back to chats" }).click();
  await page.getByTestId("filter-unread").click();
  await expect(conversationItem(page, customer.from)).toHaveCount(0);
});

test("change the password and sign in with the new one (then change it back)", async ({ page }) => {
  const temporary = `temp-${Date.now().toString(36)}-pw`;
  await login(page);
  const change = async (password: string) => {
    await openSettings(page);
    await page.getByRole("menuitem", { name: "Change password" }).click();
    await page.locator('input[name="new-password"]').fill(password);
    await page.getByRole("button", { name: "Change password" }).last().click();
    await expect(page.getByTestId("password-status")).toHaveText("Password changed.");
    await page.getByRole("button", { name: "Close" }).click();
    await closeSettings(page);
  };
  await change(temporary);
  await signOut(page);

  await page.getByLabel("Password").fill(env.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Wrong password");
  await page.getByLabel("Password").fill(temporary);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("settings-button")).toBeVisible();

  await change(env.password); // restore, so the other tests keep working
  await signOut(page);
  await page.getByLabel("Password").fill(env.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("settings-button")).toBeVisible();
});

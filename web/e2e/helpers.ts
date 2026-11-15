import { expect, type Page } from "@playwright/test";
import {
  anonKey,
  harnessConfig,
  type IncomingKind,
  incomingPayload,
  postWebhook,
  reactionPayload,
  restSelect,
  staffLogin,
  statusPayload,
  supabaseUrl,
} from "../../scripts/lib/meta.mjs";

export const env = {
  password: process.env.E2E_PASSWORD ?? "",
  appSecret: process.env.WA_APP_SECRET ?? "",
};

/** Why the end-to-end test cannot run, or null when everything needed is set. */
export function missingForE2E(): string | null {
  const missing: string[] = [];
  if (!supabaseUrl()) missing.push("VITE_SUPABASE_URL (web/.env)");
  if (!anonKey()) missing.push("VITE_SUPABASE_ANON_KEY (web/.env)");
  if (!env.appSecret) missing.push("WA_APP_SECRET (.env)");
  if (!env.password) missing.push("E2E_PASSWORD (.env)");
  if (missing.length === 0) return null;
  return `End-to-end test skipped: it needs a real Supabase project. Missing: ${missing.join(", ")}. See TEST_PLAN.md.`;
}

/** A fresh customer for every run, so runs never interfere with each other. */
export function newCustomer() {
  const suffix = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
  return { from: `9199${suffix}`, name: `E2E Customer ${suffix.slice(-4)}` };
}

export async function simulateIncoming(
  customer: { from: string; name: string },
  input: { kind: IncomingKind; text?: string; filename?: string; hoursAgo?: number; replyTo?: string },
) {
  const config = harnessConfig();
  const payload = incomingPayload({ ...input, phoneId: config.phoneId, from: customer.from, name: customer.name });
  const result = await postWebhook(config.webhookUrl, payload, config.appSecret);
  expect(result.status, `webhook answered ${result.status}: ${result.text}`).toBe(200);
  expect(result.json?.stored, "webhook ignored the event: does WA_PHONE_ID match the server?").toBe(1);
}

/** Many text messages in one webhook delivery (fast way to build a long history). */
export async function simulateMany(customer: { from: string; name: string }, texts: string[]) {
  const config = harnessConfig();
  const payload = incomingPayload({ kind: "text", phoneId: config.phoneId, from: customer.from, name: customer.name, text: texts[0] });
  const value = (payload.entry[0] as { changes: { value: { messages: Record<string, unknown>[] } }[] }).changes[0].value;
  const first = value.messages[0];
  value.messages = texts.map((text, index) => ({ ...first, id: `${first.id}.${index}`, text: { body: text } }));
  const result = await postWebhook(config.webhookUrl, payload, config.appSecret);
  expect(result.status).toBe(200);
  expect(result.json?.stored).toBe(texts.length);
}

export async function simulateStatus(to: string, messageId: string, status: "delivered" | "read" | "played" | "failed") {
  const config = harnessConfig();
  const result = await postWebhook(
    config.webhookUrl,
    statusPayload({ phoneId: config.phoneId, to, messageId, status }),
    config.appSecret,
  );
  expect(result.status).toBe(200);
  expect(result.json?.statuses).toBe(1);
}

export async function simulateReaction(customer: { from: string; name: string }, messageId: string, emoji?: string) {
  const config = harnessConfig();
  const result = await postWebhook(
    config.webhookUrl,
    reactionPayload({ phoneId: config.phoneId, from: customer.from, name: customer.name, messageId, emoji }),
    config.appSecret,
  );
  expect(result.status).toBe(200);
  expect(result.json?.reactions).toBe(1);
}

/** Reads rows through the REST API as the signed-in owner (RLS applies). */
export async function rest<T = Record<string, unknown>>(pathAndQuery: string): Promise<T[]> {
  const token = await staffLogin();
  if (!token) throw new Error("staff login failed");
  return await restSelect<T>(token, pathAndQuery);
}

export interface MessageRecord {
  id: string;
  wa_message_id: string | null;
  status: string;
  type: string;
  body: string | null;
  media_mime: string | null;
  media_voice: boolean;
  media_path: string | null;
  reply_to_wa_message_id: string | null;
  reaction_business: string | null;
  reaction_customer: string | null;
}

/** All messages of a customer, oldest first. */
export async function messagesOf(waId: string): Promise<MessageRecord[]> {
  const conversations = await rest<{ id: string }>(`conversations?select=id&wa_id=eq.${waId}`);
  return await rest<MessageRecord>(
    `wa_messages?select=*&conversation_id=eq.${conversations[0].id}&order=created_at.asc&limit=500`,
  );
}

/** The newest outgoing message of a customer. */
export async function latestOutgoing(waId: string) {
  const outgoing = (await messagesOf(waId)).filter((m) => m.wa_message_id && m.status !== "received");
  return outgoing[outgoing.length - 1];
}

export async function login(page: Page, password: string = env.password) {
  await page.goto("/");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("settings-button")).toBeVisible();
  // Realtime must be connected before the test simulates anything.
  await openSettings(page);
  await expect(page.getByTestId("live-status")).toHaveText("Live");
  await closeSettings(page);
}

export function conversationItem(page: Page, waId: string) {
  return page.locator(`[data-testid="conversation-item"][data-wa-id="${waId}"]`);
}

// On a phone the menu lives in the chat list, so an open chat is left first and restored afterwards.
const leftChat = new WeakSet<Page>();

export async function openSettings(page: Page) {
  // Wait for the page to settle: either the list (menu button) or an open chat on a phone (back link).
  const menuButton = page.getByTestId("settings-button");
  const backLink = page.getByRole("link", { name: "Back to chats" });
  await expect.poll(async () => (await menuButton.isVisible()) || (await backLink.isVisible())).toBe(true);
  if (!(await menuButton.isVisible())) {
    await backLink.click();
    leftChat.add(page);
  }
  if (!(await page.getByTestId("settings-menu").isVisible())) await page.getByTestId("settings-button").click();
  await expect(page.getByTestId("settings-menu")).toBeVisible();
}

/** Closes the menu (and any dialog it opened) and goes back to the chat that openSettings left. */
export async function closeSettings(page: Page) {
  if (await page.getByTestId("settings-menu").isVisible()) await page.keyboard.press("Escape");
  if (leftChat.delete(page)) await page.goBack();
}

export async function signOut(page: Page) {
  await openSettings(page);
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
}

/** Opens a customer's chat from the list and waits until its messages are shown. */
export async function openChat(page: Page, customer: { from: string; name: string }) {
  await conversationItem(page, customer.from).click();
  await expect(page.getByTestId("conversation-title")).toHaveText(customer.name);
  await expect(page.getByTestId("message-in").first()).toBeVisible();
}

/** Opens the "⋯" menu of a message bubble. */
export async function openMessageMenu(bubble: import("@playwright/test").Locator) {
  await bubble.hover();
  await bubble.getByTestId("message-menu").click();
}

export function statusOf(bubble: import("@playwright/test").Locator) {
  return bubble.getByTestId("message-status");
}

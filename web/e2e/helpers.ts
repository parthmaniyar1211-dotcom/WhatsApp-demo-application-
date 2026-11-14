import { expect, type Page } from "@playwright/test";
import {
  anonKey,
  harnessConfig,
  incomingPayload,
  postWebhook,
  restSelect,
  staffLogin,
  statusPayload,
  supabaseUrl,
} from "../../scripts/lib/meta.mjs";

export const env = {
  staffId: process.env.E2E_STAFF_ID ?? "",
  password: process.env.E2E_PASSWORD ?? "",
  adminId: process.env.E2E_ADMIN_ID ?? "",
  adminPassword: process.env.E2E_ADMIN_PASSWORD ?? "",
  appSecret: process.env.WA_APP_SECRET ?? "",
};

/** Why the end-to-end test cannot run, or null when everything needed is set. */
export function missingForE2E(): string | null {
  const missing: string[] = [];
  if (!supabaseUrl()) missing.push("VITE_SUPABASE_URL (web/.env)");
  if (!anonKey()) missing.push("VITE_SUPABASE_ANON_KEY (web/.env)");
  if (!env.appSecret) missing.push("WA_APP_SECRET (.env)");
  if (!env.staffId) missing.push("E2E_STAFF_ID (.env)");
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
  input: { kind: "text" | "image" | "document"; text?: string; filename?: string; hoursAgo?: number },
) {
  const config = harnessConfig();
  const payload = incomingPayload({ ...input, phoneId: config.phoneId, from: customer.from, name: customer.name });
  const result = await postWebhook(config.webhookUrl, payload, config.appSecret);
  expect(result.status, `webhook answered ${result.status}: ${result.text}`).toBe(200);
  expect(result.json?.stored, "webhook ignored the event: does WA_PHONE_ID match the server?").toBe(1);
}

export async function simulateStatus(to: string, messageId: string, status: "delivered" | "read" | "failed") {
  const config = harnessConfig();
  const result = await postWebhook(
    config.webhookUrl,
    statusPayload({ phoneId: config.phoneId, to, messageId, status }),
    config.appSecret,
  );
  expect(result.status).toBe(200);
  expect(result.json?.statuses).toBe(1);
}

/** Reads the newest outgoing message of a customer through the REST API (as staff, RLS applies). */
export async function latestOutgoing(waId: string) {
  const token = await staffLogin();
  if (!token) throw new Error("staff login failed");
  const conversations = await restSelect<{ id: string }>(token, `conversations?select=id&wa_id=eq.${waId}`);
  const rows = await restSelect<{ wa_message_id: string | null; status: string }>(
    token,
    `wa_messages?select=wa_message_id,status&conversation_id=eq.${conversations[0].id}&direction=eq.out&order=created_at.desc&limit=1`,
  );
  return rows[0];
}

export async function login(page: Page, staffId: string, password: string) {
  await page.goto("/");
  await page.getByLabel("Staff ID").fill(staffId);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("me")).toHaveText(staffId.toUpperCase());
  await expect(page.getByTestId("live-status")).toHaveText("Live");
}

export function conversationItem(page: Page, waId: string) {
  return page.locator(`[data-testid="conversation-item"][data-wa-id="${waId}"]`);
}

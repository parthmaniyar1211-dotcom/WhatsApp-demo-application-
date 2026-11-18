// Multi-tenant flows through the real UI: the branded login, the administrator's console, creating a
// client, the temporary password and the forced change, and what a client can and cannot see.
//
// It CREATES clients, so it only runs against a local Supabase stack and removes everything it made.
// Needs (see TEST_PLAN.md): a local stack, the LOCAL admin's Staff ID and password, and
// LOCAL_SERVICE_ROLE_KEY for the cleanup.

import { expect, test, type Page } from "@playwright/test";
import { anonKey, supabaseUrl } from "../../scripts/lib/meta.mjs";
import { env, login, missingForE2E } from "./helpers";

const skipReason = missingForE2E();
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(supabaseUrl());
test.skip(!!skipReason, skipReason ?? "");
test.skip(!isLocal, "The multi-tenant UI test creates clients and runs only against a local Supabase stack.");

const SERVICE = process.env.LOCAL_SERVICE_ROLE_KEY ?? "";
const created: string[] = []; // tenant ids to clean up

async function cleanup(tenantIds: string[]) {
  if (!SERVICE) return;
  const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
  const base = supabaseUrl();
  for (const id of tenantIds) {
    const members = await (await fetch(`${base}/rest/v1/tenant_memberships?tenant_id=eq.${id}&select=user_id`, { headers: h })).json();
    const conns = await (await fetch(`${base}/rest/v1/whatsapp_connections?tenant_id=eq.${id}&select=id`, { headers: h })).json();
    for (const c of conns) {
      await fetch(`${base}/rest/v1/rpc/revoke_connection_token`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ p_connection_id: c.id, p_status: "revoked" }) });
      await fetch(`${base}/rest/v1/webhook_events?connection_id=eq.${c.id}`, { method: "DELETE", headers: h });
    }
    await fetch(`${base}/rest/v1/conversations?tenant_id=eq.${id}`, { method: "DELETE", headers: h });
    await fetch(`${base}/rest/v1/whatsapp_connections?tenant_id=eq.${id}`, { method: "DELETE", headers: h });
    await fetch(`${base}/rest/v1/tenants?id=eq.${id}`, { method: "DELETE", headers: h });
    for (const m of members) await fetch(`${base}/auth/v1/admin/users/${m.user_id}`, { method: "DELETE", headers: h });
  }
}

test.afterAll(async () => {
  await cleanup(created);
});

async function openAdmin(page: Page) {
  await login(page);
  await page.getByTestId("settings-button").click();
  await page.getByTestId("menu-admin").click();
  await expect(page.getByTestId("admin-console")).toBeVisible();
}

test("the login screen carries the brand and asks for Staff ID and password", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("brand-name")).toHaveText("CosmiConnect");
  await expect(page.getByLabel("Staff ID")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page).toHaveTitle("CosmiConnect");
  // never claims to be WhatsApp
  await expect(page.locator("body")).not.toContainText(/official whatsapp/i);
});

test("an unknown Staff ID and a wrong password get the same answer", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Staff ID").fill("NOSUCHID1");
  await page.getByLabel("Password").fill("whatever-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  const unknown = await page.getByRole("alert").innerText();
  await page.getByLabel("Staff ID").fill(env.staffId);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(unknown);
});

test("admin console: overview, create a client, temporary password shown once, forced change, isolation", async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const business = `ZZ UI Test ${testInfo.project.name} ${Date.now().toString(36)}`;
  await openAdmin(page);

  // Overview
  await expect(page.getByTestId("admin-overview")).toContainText("Clients");
  await expect(page.getByTestId("admin-overview")).toContainText("WhatsApp numbers");

  // Clients: the existing test data lives in "Owner (test)"
  await page.getByTestId("tab-clients").click();
  await expect(page.getByTestId("client-row-owner-test")).toBeVisible();

  // Create a client
  await page.locator('input[name="clientName"]').fill(business);
  await page.locator('input[name="displayName"]').fill("UI Owner");
  await page.getByRole("button", { name: "Create login" }).click();
  const dialog = page.getByTestId("credential-dialog");
  await expect(dialog).toBeVisible();
  const staffId = (await page.getByTestId("credential-staff-id").innerText()).trim();
  const temporary = (await page.getByTestId("credential-password").innerText()).trim();
  expect(staffId).toMatch(/^CC[A-Z2-9]{6}$/);
  expect(temporary).toHaveLength(16);
  await page.getByTestId("credential-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("admin-message")).toContainText(`Created ${staffId}`);
  // shown once: it is nowhere on the page any more
  await expect(page.locator("body")).not.toContainText(temporary);

  const row = page.locator("tr", { hasText: business });
  await expect(row).toBeVisible();
  const tenantId = await page.evaluate(async ([url, key, name]) => {
    const token = JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes("auth-token"))!)!).access_token;
    const r = await fetch(`${url}/rest/v1/tenants?name=eq.${encodeURIComponent(name)}&select=id`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    return (await r.json())[0]?.id as string;
  }, [supabaseUrl(), anonKey(), business]);
  expect(tenantId).toBeTruthy();
  created.push(tenantId);

  // The audit log recorded it
  await page.getByTestId("tab-audit").click();
  await expect(page.getByTestId("admin-audit")).toContainText("staff.create");
  // Webhook routing diagnostics (metadata only)
  await page.getByTestId("tab-webhooks").click();
  await expect(page.getByTestId("admin-webhooks")).toContainText("Waiting in quarantine");

  // A new browser = the client signs in with the temporary password
  const clientContext = await browser.newContext(testInfo.project.use);
  const client = await clientContext.newPage();
  await client.goto("/");
  await client.getByLabel("Staff ID").fill(staffId);
  await client.getByLabel("Password").fill(temporary);
  await client.getByRole("button", { name: "Sign in" }).click();
  await expect(client.getByTestId("force-password")).toBeVisible();
  // nothing else is reachable
  await expect(client.getByTestId("settings-button")).toHaveCount(0);
  // The lock is enforced by the DATABASE, not only by this screen: even with the session's own token the API gives nothing,
  // and the browser cannot clear the flag (user_metadata, staff PATCH, the RPC) or reach the unlock function with a stale token.
  const locked = await client.evaluate(async ([url, key]) => {
    const token = JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes("auth-token"))!)!).access_token;
    const h = { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const rows = async (path: string) => (await (await fetch(`${url}/rest/v1/${path}`, { headers: h })).json()).length;
    await fetch(`${url}/auth/v1/user`, { method: "PUT", headers: h, body: JSON.stringify({ data: { must_change_password: false } }) });
    const patch = await fetch(`${url}/rest/v1/staff`, { method: "PATCH", headers: h, body: JSON.stringify({ must_change_password: false }) });
    const own = await (await fetch(`${url}/rest/v1/staff?select=must_change_password`, { headers: h })).json();
    return { conversations: await rows("conversations?select=id"), connections: await rows("whatsapp_connections?select=id"), patch: patch.status, flagStill: own[0]?.must_change_password };
  }, [supabaseUrl(), anonKey()]);
  expect(locked).toEqual({ conversations: 0, connections: 0, patch: expect.any(Number), flagStill: true });
  expect(locked.patch).toBeGreaterThanOrEqual(400);
  await client.locator('input[name="new-password"]').fill("short");
  await client.locator('input[name="repeat-password"]').fill("short");
  await client.getByRole("button", { name: "Save password" }).click();
  await expect(client.getByRole("alert")).toContainText("at least 8");
  const chosen = `chosen-${Date.now().toString(36)}-pw`;
  await client.locator('input[name="new-password"]').fill(chosen);
  await client.locator('input[name="repeat-password"]').fill("something-else-123");
  await client.getByRole("button", { name: "Save password" }).click();
  await expect(client.getByRole("alert")).toContainText("not the same");
  await client.locator('input[name="repeat-password"]').fill(chosen);
  await client.getByRole("button", { name: "Save password" }).click();

  // The client's inbox: its own (empty) world, a banner because no number is connected, and no admin menu
  await expect(client.getByTestId("settings-button")).toBeVisible();
  await expect(client.getByTestId("connection-banner")).toContainText("No WhatsApp number is connected");
  await expect(client.getByTestId("conversation-item")).toHaveCount(0);
  await client.getByTestId("settings-button").click();
  await expect(client.getByTestId("menu-admin")).toHaveCount(0);
  await client.keyboard.press("Escape");

  // Everything of "Owner (test)" is invisible to the client, even by calling the API with its own token.
  const seen = await client.evaluate(async ([url, key]) => {
    const token = JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes("auth-token"))!)!).access_token;
    const h = { apikey: key, Authorization: `Bearer ${token}` };
    const count = async (path: string) => (await (await fetch(`${url}/rest/v1/${path}`, { headers: h })).json()).length;
    const admin = await fetch(`${url}/rest/v1/rpc/admin_overview`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: "{}" });
    const fn = await fetch(`${url}/functions/v1/admin-staff`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", client_name: "evil" }) });
    return { conversations: await count("conversations?select=id"), messages: await count("wa_messages?select=id"), tenants: await count("tenants?select=id"), audit: await count("audit_logs?select=id"), adminRpc: admin.status, adminFn: fn.status };
  }, [supabaseUrl(), anonKey()]);
  expect(seen.conversations).toBe(0);
  expect(seen.messages).toBe(0);
  expect(seen.tenants).toBe(1);
  expect(seen.audit).toBe(0);
  expect(seen.adminRpc).toBeGreaterThanOrEqual(400);
  expect(seen.adminFn).toBe(403);

  // Back in the admin console: connections tab, Embedded Signup gate, create a connection for the client
  await page.getByTestId("tab-connections").click();
  await expect(page.getByTestId("onboarding-flag")).toContainText("not enabled");
  await expect(page.getByRole("button", { name: "Connect with Meta" })).toBeDisabled();
  await page.locator('select[name="connTenant"]').selectOption({ label: business });
  await page.locator('input[name="connLabel"]').fill("UI number");
  const phoneId = `55${Date.now().toString().slice(-9)}`;
  await page.locator('input[name="connPhoneId"]').fill(phoneId);
  await page.locator('input[name="connWaba"]').fill(`44${Date.now().toString().slice(-9)}`);
  await page.getByRole("button", { name: "Create connection" }).click();
  await expect(page.getByTestId("admin-message")).toContainText("Connection created");
  const connRow = page.locator("tr", { hasText: business });
  await expect(connRow).toContainText("pending");

  // The client sees "being set up" (not "disconnected") after a refresh
  await client.getByRole("button", { name: "Check again" }).click();
  await expect(client.getByTestId("connection-banner")).toContainText("being set up");

  // Suspending the client locks it out at once
  await page.getByTestId("tab-clients").click();
  page.once("dialog", (d) => void d.accept());
  await page.locator("tr", { hasText: business }).getByRole("button", { name: "Suspend" }).click();
  await expect(page.getByTestId("admin-message")).toContainText("Suspended");
  await client.reload();
  await expect(client.getByText("No client account")).toBeVisible();

  await clientContext.close();
});

test("the admin console fits a phone-sized screen and the admin can go back to the chats", async ({ page }) => {
  await openAdmin(page);
  await expect(page.getByTestId("admin-console")).toBeVisible();
  // no horizontal page scroll
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByTestId("admin-back").click();
  await expect(page.getByTestId("settings-button")).toBeVisible();
});

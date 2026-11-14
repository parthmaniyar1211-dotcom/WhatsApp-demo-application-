// Admin page end-to-end test. Needs an admin login in ../.env (E2E_ADMIN_ID / E2E_ADMIN_PASSWORD).

import { expect, test } from "@playwright/test";
import { conversationItem, env, login, missingForE2E, newCustomer, simulateIncoming } from "./helpers";

test.beforeEach(() => {
  const reason = missingForE2E();
  test.skip(reason !== null, reason ?? "");
  test.skip(!env.adminId || !env.adminPassword, "Admin test skipped: set E2E_ADMIN_ID and E2E_ADMIN_PASSWORD in .env.");
});

test("admin creates, resets and disables a staff login", async ({ page, browser }, testInfo) => {
  const staffId = `T${Date.now().toString(36).toUpperCase()}`;
  const firstPassword = "first-Password-1";
  const secondPassword = "second-Password-2";

  await login(page, env.adminId, env.adminPassword);
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page.getByTestId("admin-page")).toBeVisible();

  // Create
  await page.locator('input[name="new-staff-id"]').fill(staffId.toLowerCase());
  await page.locator('input[name="new-name"]').fill("Temp Tester");
  await page.locator('input[name="new-password"]').fill(firstPassword);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("admin-notice")).toContainText(`Created ${staffId}`);
  const row = page.locator(`[data-testid="staff-row"][data-staff-id="${staffId}"]`);
  await expect(row).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("4-admin.png"), fullPage: true });

  // The new staff member can sign in (separate browser session).
  const staffContext = await browser.newContext({ ...testInfo.project.use });
  const staffPage = await staffContext.newPage();
  await login(staffPage, staffId, firstPassword);
  // Staff do not get the admin page, even by URL.
  await expect(staffPage.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await staffPage.goto("/#/admin");
  await expect(staffPage.getByTestId("admin-page")).toHaveCount(0);

  // Reset password: the old one stops working, the new one works.
  await row.getByRole("button", { name: "Reset password" }).click();
  await row.locator('input[name="reset-password"]').fill(secondPassword);
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("admin-notice")).toContainText(`Password of ${staffId} changed`);

  const check = await browser.newContext({ ...testInfo.project.use });
  const checkPage = await check.newPage();
  await checkPage.goto("/");
  await checkPage.getByLabel("Staff ID").fill(staffId);
  await checkPage.getByLabel("Password").fill(firstPassword);
  await checkPage.getByRole("button", { name: "Sign in" }).click();
  await expect(checkPage.getByRole("alert")).toContainText("Wrong staff ID or password");
  await checkPage.getByLabel("Password").fill(secondPassword);
  await checkPage.getByRole("button", { name: "Sign in" }).click();
  await expect(checkPage.getByTestId("me")).toHaveText(staffId);

  // Disable: the signed-in session loses access, and signing in again is refused.
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByTestId("admin-notice")).toContainText(`${staffId} is disabled`);
  await expect(row).toContainText("Disabled");

  await checkPage.reload();
  await expect(checkPage.getByText(/Account not active|Sign in/).first()).toBeVisible();
  await expect(checkPage.getByTestId("me")).toHaveCount(0);

  const blocked = await browser.newContext({ ...testInfo.project.use });
  const blockedPage = await blocked.newPage();
  await blockedPage.goto("/");
  await blockedPage.getByLabel("Staff ID").fill(staffId);
  await blockedPage.getByLabel("Password").fill(secondPassword);
  await blockedPage.getByRole("button", { name: "Sign in" }).click();
  await expect(blockedPage.getByRole("alert")).toContainText("Wrong staff ID or password, or the account is disabled");

  // Enable again.
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByTestId("admin-notice")).toContainText(`${staffId} can sign in again`);

  await staffContext.close();
  await check.close();
  await blocked.close();
});

test("two staff members: owner is visible to everyone live, unread counts are per person", async ({ page, browser }, testInfo) => {
  const customer = newCustomer();
  const other = await browser.newContext({ ...testInfo.project.use });
  const otherPage = await other.newPage();
  await login(page, env.staffId, env.password);
  await login(otherPage, env.adminId, env.adminPassword);

  await simulateIncoming(customer, { kind: "text", text: "Who reads this?" });
  const mine = conversationItem(page, customer.from);
  const theirs = conversationItem(otherPage, customer.from);
  await expect(mine.getByTestId("unread-badge")).toHaveText("1");
  await expect(theirs.getByTestId("unread-badge")).toHaveText("1");

  // The first staff member opens and takes the chat.
  await mine.click();
  await page.getByRole("button", { name: "Take chat" }).click();
  await expect(page.getByTestId("owner")).toContainText("You");

  // The other one sees the owner without a reload, and still has the message unread.
  await expect(theirs).toContainText(env.staffId.toUpperCase());
  await expect(theirs.getByTestId("unread-badge")).toHaveText("1");
  await otherPage.reload();
  await expect(theirs.getByTestId("unread-badge")).toHaveText("1");

  // For the first one it stays read after a reload.
  await page.goto("/");
  await page.reload();
  await expect(mine).toBeVisible();
  await expect(mine.getByTestId("unread-badge")).toHaveCount(0);

  // The other one opens it: sees the owner, can take over; the first one sees the change live.
  await theirs.click();
  await expect(otherPage.getByTestId("owner")).toContainText(`Owner: ${env.staffId.toUpperCase()}`);
  await otherPage.getByRole("button", { name: "Take over" }).click();
  await expect(otherPage.getByTestId("owner")).toContainText("You");
  await expect(mine).toContainText(env.adminId.toUpperCase());

  await otherPage.getByRole("button", { name: "Release" }).click();
  await expect(otherPage.getByTestId("owner")).toContainText("Unassigned");
  await expect(mine).not.toContainText(env.adminId.toUpperCase());
  await other.close();
});

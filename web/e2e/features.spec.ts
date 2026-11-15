// WhatsApp-like features, end to end against a real Supabase project with WA_DRY_RUN=true.
// Customer actions are simulated with the harness (signed like Meta signs webhooks).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  conversationItem,
  login,
  messagesOf,
  missingForE2E,
  newCustomer,
  openChat,
  openMessageMenu,
  closeSettings,
  openSettings,
  rest,
  simulateIncoming,
  simulateMany,
  simulateReaction,
  simulateStatus,
  statusOf,
} from "./helpers";

const fixture = (name: string) => fileURLToPath(new URL(`../../scripts/fixtures/${name}`, import.meta.url));

test.beforeEach(() => {
  const reason = missingForE2E();
  test.skip(reason !== null, reason ?? "");
});

async function start(page: Page, firstText = "Hello") {
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

test("ticks: sent, delivered, read and failed look different", async ({ page }) => {
  const customer = await start(page);
  const bubble = await sendText(page, "Tick test");
  const ticks = statusOf(bubble);
  const paths = () => ticks.locator("path").count();
  const colour = () => ticks.evaluate((el) => getComputedStyle(el).color);

  await expect(ticks).toHaveAttribute("aria-label", "Sent");
  expect(await paths()).toBe(1); // one tick
  const grey = await colour();

  const sent = (await messagesOf(customer.from)).find((m) => m.body === "Tick test")!;
  await simulateStatus(customer.from, sent.wa_message_id!, "delivered");
  await expect(ticks).toHaveAttribute("aria-label", "Delivered");
  expect(await paths()).toBe(2); // two ticks
  expect(await colour()).toBe(grey);

  await simulateStatus(customer.from, sent.wa_message_id!, "read");
  await expect(ticks).toHaveAttribute("aria-label", "Read");
  expect(await paths()).toBe(2);
  expect(await colour()).not.toBe(grey); // blue

  const second = await sendText(page, "Will fail");
  const failing = (await messagesOf(customer.from)).find((m) => m.body === "Will fail")!;
  await simulateStatus(customer.from, failing.wa_message_id!, "failed");
  await expect(statusOf(second)).toHaveAttribute("aria-label", "Failed");
  await expect(second.getByTestId("message-error")).toContainText("(code 131026)");
});

test("opening a chat marks it read at WhatsApp; typing sends the typing indicator", async ({ page }) => {
  const customer = newCustomer();
  await login(page);
  await simulateIncoming(customer, { kind: "text", text: "Are you there?" });
  const before = await rest<{ meta_read_wa_message_id: string | null }>(
    `conversations?select=meta_read_wa_message_id&wa_id=eq.${customer.from}`,
  );
  expect(before[0].meta_read_wa_message_id).toBeNull();

  const markRead = page.waitForResponse((r) => r.url().includes("/functions/v1/mark-read") && r.request().method() === "POST");
  await openChat(page, customer);
  expect(await (await markRead).json()).toMatchObject({ ok: true, marked: true });

  const incoming = (await messagesOf(customer.from))[0];
  await expect
    .poll(async () => (await rest<{ meta_read_wa_message_id: string }>(`conversations?select=meta_read_wa_message_id&wa_id=eq.${customer.from}`))[0].meta_read_wa_message_id)
    .toBe(incoming.wa_message_id);

  // Typing: one call with typing=true (throttled, so more typing does not repeat it).
  const typing = page.waitForRequest((r) => r.url().includes("/functions/v1/mark-read") && (r.postData() ?? "").includes('"typing":true'));
  await page.getByTestId("reply-input").pressSequentially("Yes, ");
  await typing;
  let extra = 0;
  page.on("request", (r) => {
    if (r.url().includes("/functions/v1/mark-read") && (r.postData() ?? "").includes('"typing":true')) extra++;
  });
  await page.getByTestId("reply-input").pressSequentially("one moment");
  await page.waitForTimeout(500);
  expect(extra).toBe(0);

  // A new message while the chat is open is marked read at WhatsApp too.
  await simulateIncoming(customer, { kind: "text", text: "Still there?" });
  await expect(page.getByTestId("message-in")).toHaveCount(2);
  await expect
    .poll(async () => {
      const rows = await rest<{ meta_read_wa_message_id: string }>(`conversations?select=meta_read_wa_message_id&wa_id=eq.${customer.from}`);
      const all = await messagesOf(customer.from);
      return rows[0].meta_read_wa_message_id === all[all.length - 1].wa_message_id;
    })
    .toBe(true);
});

test("reply (quote) works in both directions", async ({ page }) => {
  const customer = await start(page, "What time do you open?");

  // Staff quotes the customer's message.
  const question = page.getByTestId("message-in").filter({ hasText: "What time do you open?" });
  await openMessageMenu(question);
  await page.getByRole("menuitem", { name: "Reply" }).click();
  await expect(page.getByTestId("reply-preview")).toContainText(`Replying to ${customer.name}`);
  await expect(page.getByTestId("reply-preview")).toContainText("What time do you open?");
  const answer = await sendText(page, "At 9 am");
  await expect(answer.getByTestId("quote")).toContainText(customer.name);
  await expect(answer.getByTestId("quote")).toContainText("What time do you open?");
  await expect(page.getByTestId("reply-preview")).toHaveCount(0);

  const rows = await messagesOf(customer.from);
  const stored = rows.find((m) => m.body === "At 9 am")!;
  expect(stored.reply_to_wa_message_id).toBe(rows[0].wa_message_id);

  // The customer quotes our answer.
  await simulateIncoming(customer, { kind: "text", text: "Great, see you then", replyTo: stored.wa_message_id! });
  const followUp = page.getByTestId("message-in").filter({ hasText: "Great, see you then" });
  await expect(followUp.getByTestId("quote")).toContainText("You");
  await expect(followUp.getByTestId("quote")).toContainText("At 9 am");

  // Cancelling a reply removes the preview.
  await openMessageMenu(followUp);
  await page.getByRole("menuitem", { name: "Reply" }).click();
  await page.getByRole("button", { name: "Cancel reply" }).click();
  await expect(page.getByTestId("reply-preview")).toHaveCount(0);
});

test("emoji reactions work in both directions", async ({ page }) => {
  const customer = await start(page, "Thanks for the quick help");
  const ours = await sendText(page, "You are welcome");
  const stored = (await messagesOf(customer.from)).find((m) => m.body === "You are welcome")!;

  // Customer reacts to our message, changes it, then removes it.
  await simulateReaction(customer, stored.wa_message_id!, "❤️");
  await expect(ours.getByTestId("reaction-customer")).toHaveText("❤️");
  await simulateReaction(customer, stored.wa_message_id!, "👍");
  await expect(ours.getByTestId("reaction-customer")).toHaveText("👍");
  await simulateReaction(customer, stored.wa_message_id!);
  await expect(ours.getByTestId("reaction-customer")).toHaveCount(0);

  // Staff reacts to the customer's message, then removes the reaction.
  const theirs = page.getByTestId("message-in").filter({ hasText: "Thanks for the quick help" });
  await openMessageMenu(theirs);
  await page.getByRole("button", { name: "React with 🙏" }).click();
  await expect(theirs.getByTestId("reaction-business")).toHaveText("🙏");
  expect((await messagesOf(customer.from))[0].reaction_business).toBe("🙏");
  await theirs.getByTestId("reaction-business").click();
  await expect(theirs.getByTestId("reaction-business")).toHaveCount(0);
  expect((await messagesOf(customer.from))[0].reaction_business).toBeNull();
});

test("voice note: record in the browser, send as OGG/Opus, play incoming audio", async ({ page }) => {
  const customer = await start(page, "Can you explain by voice?");

  await page.getByTestId("record-button").click();
  await expect(page.getByTestId("recording")).toContainText("Recording");
  await page.waitForTimeout(1800);
  await page.getByTestId("stop-recording").click();
  await expect(page.getByTestId("attachment")).toContainText("Voice note");
  // The converted recording plays in the browser before it is sent.
  const preview = page.getByTestId("attachment-audio");
  await expect.poll(() => preview.evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(0.5);

  await page.getByTestId("send-button").click();
  const bubble = page.getByTestId("message-out").filter({ has: page.getByTestId("message-audio") });
  await expect(bubble).toHaveCount(1);
  await expect(bubble).toContainText("Voice message");

  const stored = (await messagesOf(customer.from)).find((m) => m.type === "audio")!;
  expect(stored.media_mime).toBe("audio/ogg");
  expect(stored.media_voice).toBe(true);

  // The stored file really is OGG with the Opus codec (what WhatsApp requires for voice notes).
  const src = await bubble.locator("audio").getAttribute("src");
  const response = await fetch(src!);
  expect(response.headers.get("content-type")).toBe("audio/ogg; codecs=opus");
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.subarray(0, 4).toString()).toBe("OggS");
  expect(bytes.includes(Buffer.from("OpusHead"))).toBe(true);
  expect(bytes.includes(Buffer.from("OpusTags"))).toBe(true);
  try {
    const file = join(mkdtempSync(join(tmpdir(), "voice-")), "voice.ogg");
    writeFileSync(file, bytes);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels:format=duration", "-of", "default=nw=1", file]).toString();
    expect(probe).toContain("codec_name=opus");
    expect(probe).toContain("channels=1");
    expect(Number(/duration=([\d.]+)/.exec(probe)?.[1])).toBeGreaterThan(1);
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]); // decodes without errors
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // ffprobe not installed: header checks above still ran
  }

  // The customer listens to it: WhatsApp reports "played".
  await simulateStatus(customer.from, stored.wa_message_id!, "played");
  await expect(statusOf(bubble)).toHaveAttribute("aria-label", "Played");

  // Incoming voice note is playable.
  await simulateIncoming(customer, { kind: "audio" });
  const incoming = page.getByTestId("message-in").filter({ has: page.getByTestId("message-audio") });
  await expect(incoming).toContainText("Voice message");
  await expect.poll(() => incoming.locator("audio").evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(1);
});

test("media: video, sticker, location, contact, document card and photo preview", async ({ page }, testInfo) => {
  const customer = await start(page, "Sending you some things");

  await simulateIncoming(customer, { kind: "video", text: "Look at this" });
  const video = page.getByTestId("message-video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);

  await simulateIncoming(customer, { kind: "sticker" });
  const sticker = page.getByTestId("message-sticker");
  await expect.poll(() => sticker.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await simulateIncoming(customer, { kind: "location", text: "Gateway of India" });
  const location = page.getByTestId("message-location");
  await expect(location).toContainText("Gateway of India");
  await expect(location).toContainText("Apollo Bandar");
  await expect(location).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=19.076,72.8777");

  await simulateIncoming(customer, { kind: "contacts", text: "Ravi Kumar" });
  await expect(page.getByTestId("message-contact")).toContainText("Ravi Kumar");
  await expect(page.getByTestId("message-contact")).toContainText("+91 98000 00042");

  await simulateIncoming(customer, { kind: "document", filename: "price-list.pdf" });
  const document = page.getByTestId("message-document");
  await expect(document).toContainText("price-list.pdf");
  await expect(document.getByTestId("document-details")).toHaveText("PDF · 598 B");

  await simulateIncoming(customer, { kind: "image", text: "And a photo" });
  await page.getByRole("button", { name: "Open photo" }).click();
  await expect(page.getByTestId("lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("lightbox")).toHaveCount(0);

  // Staff sends a video and it shows as a player.
  await page.getByTestId("file-input").setInputFiles(fixture("sample.mp4"));
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("message-out").getByTestId("message-video")).toBeVisible();
  // A photo over WhatsApp's 5 MB image limit is refused in the app.
  await page.getByTestId("file-input").setInputFiles({ name: "huge.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(page.getByTestId("composer-error")).toHaveText("Photos can be at most 5 MB.");
  await page.screenshot({ path: testInfo.outputPath("media.png") });
});

test("history: unread divider, date separator, grouping, infinite scroll, scroll to latest", async ({ page }) => {
  const customer = newCustomer();
  await login(page);
  await simulateMany(customer, Array.from({ length: 70 }, (_, i) => `History message ${i + 1}`));
  await expect(conversationItem(page, customer.from).getByTestId("unread-badge")).toHaveText("70");
  await conversationItem(page, customer.from).click();

  // The chat opens at the first unread message, under an "unread" divider.
  await expect(page.getByTestId("unread-divider")).toHaveText("70 unread messages");
  await expect(page.getByTestId("unread-divider")).toBeInViewport();
  await expect(page.locator(".day-divider").first()).toHaveText("Today");
  // Consecutive messages of the same sender are grouped (all but the first of a run).
  await expect(page.locator(".message-row.grouped").first()).toBeVisible();
  expect(await page.locator(".message-row.grouped").count()).toBeGreaterThan(40);

  // Opened again (now read): no divider, the view is at the newest message, one page is loaded.
  await page.reload();
  await expect(page.getByTestId("message-in")).toHaveCount(50);
  await expect(page.getByTestId("unread-divider")).toHaveCount(0);
  await expect(page.getByTestId("message-in").last()).toContainText("History message 70");
  await expect(page.getByTestId("message-in").last()).toBeInViewport();

  // Scrolling to the top loads the earlier page without a click.
  const list = page.getByTestId("messages");
  await list.evaluate((el) => el.scrollTo(0, 0));
  await expect(page.getByTestId("message-in")).toHaveCount(70);
  await expect(page.getByText("Start of the conversation")).toBeVisible();
  await expect(page.getByTestId("message-in").first()).toContainText("History message 1");
  // The view did not jump to the very top or bottom: the messages we were reading are still in view.
  const scrollTop = await list.evaluate((el) => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(200);

  // Reading old messages: a "scroll to latest" button appears and counts new messages.
  await expect(page.getByTestId("scroll-latest")).toBeVisible();
  await simulateIncoming(customer, { kind: "text", text: "Newest message" });
  await expect(page.getByTestId("scroll-latest")).toContainText("1");
  await page.getByTestId("scroll-latest").click();
  await expect(page.getByTestId("message-in").filter({ hasText: "Newest message" })).toBeInViewport();
  await expect(page.getByTestId("scroll-latest")).toHaveCount(0);
});

test("search inside a chat and across all chats", async ({ page }) => {
  const customer = newCustomer();
  const token = `needle${customer.from.slice(-6)}`;
  await login(page);
  await simulateMany(customer, [`The order number is ${token}`, ...Array.from({ length: 60 }, (_, i) => `Filler ${i + 1}`)]);

  // Across all chats, from the sidebar. The match is older than the first loaded page.
  const search = page.getByLabel("Search chats and messages");
  await search.fill(token);
  const result = page.getByTestId("message-result");
  await expect(result).toHaveCount(1);
  await expect(result).toContainText(customer.name);
  await expect(result).toContainText(token);
  await result.click();
  await expect(page.getByTestId("conversation-title")).toHaveText(customer.name);
  const match = page.getByTestId("message-in").filter({ hasText: token });
  await expect(match).toBeInViewport();
  await expect(match).toHaveClass(/highlighted/);

  // Inside the chat.
  await page.getByTestId("scroll-latest").click();
  await page.getByTestId("chat-search-button").click();
  await page.getByLabel("Search in this chat").last().fill("Filler 3");
  await expect(page.getByTestId("chat-search-result").first()).toBeVisible();
  expect(await page.getByTestId("chat-search-result").count()).toBeGreaterThan(1); // Filler 3, 30, 31 ...
  await page.getByLabel("Search in this chat").last().fill(token.toUpperCase()); // not case sensitive
  await expect(page.getByTestId("chat-search-result")).toHaveCount(1);
  await page.getByTestId("chat-search-result").click();
  await expect(match).toBeInViewport();
  await page.getByTestId("chat-search-button").click();
  await page.getByLabel("Search in this chat").last().fill("zzzz-nothing");
  await expect(page.getByText("No message contains")).toBeVisible();
});

test("starred messages and delete for me", async ({ page }) => {
  const customer = await start(page, "My address is 12 Lake Road");
  await simulateIncoming(customer, { kind: "text", text: "Please ignore this one" });
  const address = page.getByTestId("message-in").filter({ hasText: "12 Lake Road" });
  const ignore = page.getByTestId("message-in").filter({ hasText: "Please ignore this one" });

  // Star it; the star shows on the bubble and in the Starred tab.
  await openMessageMenu(address);
  await page.getByRole("menuitem", { name: "Star", exact: true }).click();
  await expect(address.getByTestId("star-mark")).toBeVisible();
  if (await page.getByTestId("filter-starred").isHidden()) await page.getByRole("link", { name: "Back to chats" }).click();
  await page.getByTestId("filter-starred").click();
  const starred = page.getByTestId("starred-item").filter({ hasText: "12 Lake Road" }).filter({ hasText: customer.name });
  await expect(starred).toContainText(customer.name);
  await starred.click();
  await expect(address).toBeInViewport();

  // Stars survive a reload (they are stored per staff member).
  await page.reload();
  await expect(address.getByTestId("star-mark")).toBeVisible();

  // Delete for me: gone from my view, with a clear explanation and an undo.
  await openMessageMenu(ignore);
  await expect(page.getByText("WhatsApp does not let a business edit or delete a sent message.")).toBeVisible();
  await page.getByRole("menuitem", { name: "Delete for me" }).click();
  await expect(ignore).toHaveCount(1); // not deleted until confirmed
  await page.getByTestId("delete-confirm").click();
  await expect(ignore).toHaveCount(0);
  await expect(page.getByTestId("chat-notice")).toContainText("Message deleted.");
  await page.getByTestId("chat-notice").getByRole("button", { name: "Undo" }).click();
  await expect(ignore).toHaveCount(1);

  // Delete again and bring it back from the contact info panel.
  await openMessageMenu(ignore);
  await page.getByRole("menuitem", { name: "Delete for me" }).click();
  await page.getByTestId("delete-confirm").click();
  await expect(ignore).toHaveCount(0);
  expect((await messagesOf(customer.from)).some((m) => m.body === "Please ignore this one")).toBe(true); // not deleted
  await page.reload();
  await expect(address).toBeVisible();
  await expect(ignore).toHaveCount(0);
  await page.getByTestId("info-button").click();
  await expect(page.getByTestId("info-starred")).toContainText("12 Lake Road");
  await page.getByTestId("unhide-all").click();
  await page.getByRole("button", { name: "Close contact info" }).click();
  await expect(ignore).toHaveCount(1);

  // Unstar.
  await openMessageMenu(address);
  await page.getByRole("menuitem", { name: "Unstar" }).click();
  await expect(address.getByTestId("star-mark")).toHaveCount(0);
});

test("quick replies: insert with a slash command, create and delete", async ({ page }) => {
  await start(page, "Hi");
  const input = page.getByTestId("reply-input");
  const shortcut = `e2e${Date.now().toString(36)}`;

  // A built-in one, chosen with the keyboard.
  await input.fill("/he");
  await expect(page.getByTestId("quick-replies")).toContainText("/hello");
  await input.press("Enter");
  await expect(input).toHaveValue("Hello! Thank you for contacting us. How can we help you today?");
  await expect(page.getByTestId("quick-replies")).toHaveCount(0);
  await expect(page.getByTestId("message-out")).toHaveCount(0); // Enter picked the snippet, it did not send
  await input.fill("");

  // Create a new one from the list's "Manage" link.
  await input.fill("/");
  await page.getByRole("button", { name: "Manage quick replies…" }).click();
  const dialog = page.getByTestId("quick-dialog");
  await dialog.getByRole("button", { name: "New quick reply" }).click();
  await dialog.locator('input[name="quick-shortcut"]').fill(`/${shortcut.toUpperCase()}`);
  await dialog.locator('textarea[name="quick-body"]').fill("Your parcel is on its way.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByTestId("quick-row").filter({ hasText: `/${shortcut}` })).toBeVisible();
  // A duplicate shortcut is refused with a clear message.
  await dialog.getByRole("button", { name: "New quick reply" }).click();
  await dialog.locator('input[name="quick-shortcut"]').fill(shortcut);
  await dialog.locator('textarea[name="quick-body"]').fill("x");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.getByRole("button", { name: "Close" }).click();

  // Use it (click), send it.
  await input.fill(`/${shortcut.slice(0, 6)}`);
  await page.getByTestId("quick-replies").getByRole("option").filter({ hasText: `/${shortcut}` }).click();
  await expect(input).toHaveValue("Your parcel is on its way.");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("message-out").filter({ hasText: "Your parcel is on its way." })).toHaveCount(1);

  // Delete it from Settings > Quick replies.
  await openSettings(page);
  await page.getByRole("menuitem", { name: "Quick replies" }).click();
  await dialog.getByRole("button", { name: `Delete /${shortcut}` }).click();
  await expect(dialog.getByTestId("quick-row").filter({ hasText: `/${shortcut}` })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await closeSettings(page);
  await input.fill(`/${shortcut}`);
  await expect(page.getByTestId("quick-replies")).toContainText("No quick reply starts with");
});

test("contact info: name, number, rename, API limits", async ({ page }) => {
  const customer = await start(page, "Hello");
  const saved = `Asha ${customer.from.slice(-4)}`;
  await page.getByTestId("info-button").click();
  const panel = page.getByTestId("info-panel");
  await expect(panel.getByTestId("info-name")).toContainText(customer.name);
  await expect(panel.getByTestId("info-number")).toHaveText(`+${customer.from}`);

  // Save a name: it wins over the WhatsApp profile name, in the header and in the list.
  await panel.getByTestId("edit-name").click();
  await panel.getByLabel("Contact name").fill(saved);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByTestId("info-status")).toHaveText("Name saved");
  await expect(page.getByTestId("conversation-title")).toHaveText(saved);
  await expect(panel).toContainText(`WhatsApp name: ${customer.name}`);

  // A new message from the customer (with the profile name) does not overwrite it.
  await simulateIncoming(customer, { kind: "text", text: "Still me" });
  await expect(page.getByTestId("message-in")).toHaveCount(2);
  await expect(page.getByTestId("conversation-title")).toHaveText(saved);

  // What the Business API cannot do is stated in the app.
  await expect(panel.getByTestId("limits")).toContainText("Online and “last seen” status");
  await expect(panel.getByTestId("limits")).toContainText("cannot be edited or deleted");
  await expect(panel.getByTestId("limits")).toContainText("Status updates, groups and voice or video calls");

  // Stored on the server: still there after a reload, and searchable in the list.
  await page.reload();
  await expect(page.getByTestId("conversation-title")).toHaveText(saved);
  if (await page.getByLabel("Search chats and messages").isHidden()) await page.getByRole("link", { name: "Back to chats" }).click();
  await page.getByLabel("Search chats and messages").fill(saved.toLowerCase());
  await expect(page.getByTestId("conversation-item")).toHaveCount(1);
  await expect(conversationItem(page, customer.from)).toContainText(saved);
});

test("browser notification and sound for new messages, with on/off settings", async ({ page, context }) => {
  await context.grantPermissions(["notifications", "microphone"]);
  // Record what the app asks the browser to do (no real notification or sound in the test).
  await page.addInitScript(() => {
    const w = window as unknown as { __notifications: { title: string; body?: string }[]; __tones: number };
    w.__notifications = [];
    w.__tones = 0;
    class FakeNotification {
      static permission = "granted";
      static requestPermission = () => Promise.resolve("granted");
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        w.__notifications.push({ title, body: options?.body });
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      w.__tones++;
      return create.call(this);
    };
  });
  const state = () => page.evaluate(() => {
    const w = window as unknown as { __notifications: { title: string; body?: string }[]; __tones: number };
    return { notifications: w.__notifications, tones: w.__tones };
  });

  const customer = newCustomer();
  await login(page);

  // Defaults: sound on, notifications off.
  await simulateIncoming(customer, { kind: "text", text: "First message" });
  await expect(conversationItem(page, customer.from)).toBeVisible();
  await expect.poll(async () => (await state()).tones).toBe(2); // two short tones
  expect((await state()).notifications).toHaveLength(0);

  // Turn notifications on, sound off.
  await openSettings(page);
  await page.getByLabel("Desktop notifications").check();
  await page.getByLabel("Sound for new messages").uncheck();
  await closeSettings(page);
  await simulateIncoming(customer, { kind: "text", text: "Second message" });
  await expect.poll(async () => (await state()).notifications.length).toBe(1);
  expect((await state()).notifications[0]).toEqual({ title: customer.name, body: "Second message" });
  expect((await state()).tones).toBe(2); // unchanged: sound is off

  // No alert for the chat that is open in front of the user.
  await openChat(page, customer);
  await simulateIncoming(customer, { kind: "text", text: "Third message" });
  await expect(page.getByTestId("message-in")).toHaveCount(3);
  expect((await state()).notifications).toHaveLength(1);

  // The settings are remembered after a reload.
  await page.reload();
  await openSettings(page);
  await expect(page.getByLabel("Desktop notifications")).toBeChecked();
  await expect(page.getByLabel("Sound for new messages")).not.toBeChecked();
  await closeSettings(page);
});

test("emoji picker, paste an image, drag and drop a file", async ({ page }) => {
  await start(page, "Hello");
  const input = page.getByTestId("reply-input");

  // Emoji goes in at the cursor.
  await input.fill("Thanks!");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
  await page.getByTestId("emoji-button").click();
  await page.getByTestId("emoji-picker").getByRole("button", { name: "Insert 🙏" }).click();
  await expect(input).toHaveValue("Thanks🙏!");
  await page.getByTestId("emoji-button").click();
  await expect(page.getByTestId("emoji-picker")).toHaveCount(0);

  // Paste a picture from the clipboard.
  const png = (await import("node:fs")).readFileSync(fixture("sample.png")).toString("base64");
  await input.evaluate((el, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "screenshot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  await expect(page.getByTestId("attachment")).toContainText("screenshot.png");
  await page.getByTestId("send-button").click();
  const sent = page.getByTestId("message-out").filter({ hasText: "Thanks🙏!" });
  await expect(sent.getByTestId("message-image")).toBeVisible();
  await expect(page.getByTestId("attachment")).toHaveCount(0);

  // Drag a PDF onto the chat.
  const pdf = (await import("node:fs")).readFileSync(fixture("sample.pdf")).toString("base64");
  await page.locator(".conversation").evaluate((el, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "dropped.pdf", { type: "application/pdf" }));
    el.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, pdf);
  await expect(page.getByTestId("attachment")).toContainText("dropped.pdf");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("message-out").getByTestId("message-document")).toContainText("dropped.pdf");
});

test("dark is the default theme; light can be chosen and is remembered", async ({ page }, testInfo) => {
  const customer = await start(page, "Hello in the dark");
  await simulateIncoming(customer, { kind: "image", text: "Photo" });
  await sendText(page, "Dark mode reply");
  const background = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await background();
  await page.screenshot({ path: testInfo.outputPath("dark.png") });

  await openSettings(page);
  await page.getByLabel("Theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await background()).not.toBe(dark);
  await closeSettings(page);
  await page.screenshot({ path: testInfo.outputPath("light.png") });

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openSettings(page);
  await page.getByLabel("Theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

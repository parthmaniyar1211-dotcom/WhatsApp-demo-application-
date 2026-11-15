import type { Conversation, Message, MessageLocation } from "./types";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Saved name, else the WhatsApp profile name, else the number. */
export function customerLabel(c: Pick<Conversation, "customer_name" | "contact_name" | "wa_id">): string {
  return c.contact_name?.trim() || c.customer_name?.trim() || formatPhone(c.wa_id);
}

/** "+9198…" for phone numbers. WhatsApp can hide the number of customers who use a username. */
export function formatPhone(waId: string): string {
  return /^\d+$/.test(waId) ? `+${waId}` : "Number hidden by WhatsApp";
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Time for today, otherwise a short date: used in the conversation list. */
export function formatListTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (sameDay(date, now)) return formatTime(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function formatDay(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** WhatsApp only allows free-form replies within 24 hours of the customer's last message. */
export function isWindowOpen(lastInboundAt: string | null, now: number): boolean {
  if (!lastInboundAt) return false;
  return now - new Date(lastInboundAt).getTime() < WINDOW_MS;
}

export function formatRemaining(lastInboundAt: string, now: number): string {
  const ms = new Date(lastInboundAt).getTime() + WINDOW_MS - now;
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${minutes} min`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** One line that describes a message: used in quotes, search results and notifications. */
export function messageSummary(m: Pick<Message, "type" | "body" | "media_filename" | "media_voice">): string {
  switch (m.type) {
    case "image":
      return m.body ? `Photo: ${m.body}` : "Photo";
    case "video":
      return m.body ? `Video: ${m.body}` : "Video";
    case "audio":
      return m.media_voice ? "Voice message" : "Audio";
    case "sticker":
      return "Sticker";
    case "document":
      return m.media_filename ?? "Document";
    case "location":
      return m.body ? `Location: ${m.body}` : "Location";
    case "contacts":
      return m.body ? `Contact: ${m.body}` : "Contact";
    case "template":
      return `Template: ${m.body ?? ""}`;
    default:
      return m.body ?? "";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return "Something went wrong";
}

/** The chat-list line for a message. Mirrors the server's message_preview(), so both look the same. */
export function previewText(m: Pick<Message, "type" | "body" | "media_filename">): string {
  const withBody = (label: string) => (m.body ? `${label}: ${m.body}` : label);
  let text: string;
  switch (m.type) {
    case "image":
      text = withBody("Photo");
      break;
    case "video":
      text = withBody("Video");
      break;
    case "audio":
      text = "Voice message";
      break;
    case "sticker":
      text = "Sticker";
      break;
    case "location":
      text = withBody("Location");
      break;
    case "contacts":
      text = withBody("Contact");
      break;
    case "document":
      text = m.media_filename ? `Document: ${m.media_filename}` : "Document";
      break;
    case "template":
      text = withBody("Template");
      break;
    default:
      text = m.body ?? "";
  }
  return text.slice(0, 120);
}

/** What "Copy message" copies, or null when there is nothing to copy (a photo without a caption, a voice note ...). */
export function copyableText(m: Pick<Message, "type" | "body" | "media_filename" | "location" | "contacts">): string | null {
  const text = (value: string | null | undefined) => (value && value.trim() ? value : null);
  switch (m.type) {
    case "text":
    case "template":
    case "interactive":
    case "button":
    case "other":
      return text(m.body);
    case "image":
    case "video":
      return text(m.body); // the caption
    case "document":
      return text(m.body) ?? text(m.media_filename);
    case "location": {
      const l: MessageLocation | null = m.location;
      return l ? `${text(m.body) ? `${m.body}\n` : ""}https://www.google.com/maps/search/?api=1&query=${l.latitude},${l.longitude}` : text(m.body);
    }
    case "contacts":
      return m.contacts?.length ? m.contacts.map((c) => [c.name, ...c.phones].join(" ")).join("\n") : text(m.body);
    default:
      return null; // audio, sticker
  }
}

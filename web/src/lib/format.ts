import type { Conversation, Message } from "./types";

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

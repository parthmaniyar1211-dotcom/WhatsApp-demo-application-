// File rules shared by the webhook (incoming) and send-whatsapp (outgoing).

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB, same as the bucket limit
export const BUCKET = "files";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** "image/jpeg; charset=binary" -> "image/jpeg" */
export function cleanMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

/** File extension for an allowed incoming mime type, or null when not allowed. */
export function extensionFor(mime: string): string | null {
  return EXTENSIONS[mime] ?? null;
}

/** Staff may send JPEG/PNG photos and PDF documents (what WhatsApp accepts). */
export function outgoingKind(mime: string): "image" | "document" | null {
  if (mime === "image/jpeg" || mime === "image/png") return "image";
  if (mime === "application/pdf") return "document";
  return null;
}

/** Keep a customer- or staff-supplied file name safe to store and display. */
export function safeFilename(name: unknown, fallback: string): string {
  if (typeof name !== "string") return fallback;
  // deno-lint-ignore no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 120);
  return cleaned || fallback;
}

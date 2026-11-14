// File rules shared by the webhook (incoming) and send-whatsapp (outgoing).
// Formats and size limits follow Meta's "Supported media types" table (Cloud API media reference):
//   images  JPEG / PNG                      5 MB
//   audio   AAC, AMR, MP3, M4A, OGG (Opus)  16 MB   (voice notes: OGG/Opus)
//   video   MP4, 3GP (H.264 + AAC)          16 MB
//   sticker WebP                            100 KB static / 500 KB animated
//   documents                               100 MB

export const BUCKET = "files";
/** Storage bucket limit: nothing larger is stored (incoming) or accepted (uploads). */
export const MAX_STORED_BYTES = 16 * 1024 * 1024;
/** What staff may send from the console. */
export const MAX_OUTGOING_BYTES = 10 * 1024 * 1024;
export const MAX_OUTGOING_IMAGE_BYTES = 5 * 1024 * 1024; // Meta rejects larger photos

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export type MediaKind = "image" | "document" | "audio" | "video" | "sticker";

/** "audio/ogg; codecs=opus" -> "audio/ogg" */
export function cleanMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

/** File extension for a mime type we store, or null when the type is not allowed. */
export function extensionFor(mime: string): string | null {
  return EXTENSIONS[mime] ?? null;
}

/** May a file of this type arrive as this kind of WhatsApp message? */
export function incomingAllowed(kind: MediaKind, mime: string): boolean {
  if (!extensionFor(mime)) return false;
  if (kind === "image") return mime === "image/jpeg" || mime === "image/png" || mime === "image/webp";
  if (kind === "sticker") return mime === "image/webp";
  if (kind === "audio") return mime.startsWith("audio/");
  if (kind === "video") return mime.startsWith("video/");
  return true; // document: anything in the table
}

/** What staff may send, by the stored file's type. Null when the type cannot be sent. */
export function outgoingRule(mime: string): { kind: "image" | "document" | "audio" | "video"; maxBytes: number } | null {
  if (mime === "image/jpeg" || mime === "image/png") return { kind: "image", maxBytes: MAX_OUTGOING_IMAGE_BYTES };
  if (mime === "application/pdf") return { kind: "document", maxBytes: MAX_OUTGOING_BYTES };
  if (["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr"].includes(mime)) {
    return { kind: "audio", maxBytes: MAX_OUTGOING_BYTES };
  }
  if (mime === "video/mp4") return { kind: "video", maxBytes: MAX_OUTGOING_BYTES };
  return null;
}

/**
 * The Content-Type to store a file with. WhatsApp only accepts OGG audio when the
 * type says it is Opus, so that parameter is kept for audio/ogg.
 */
export function storedContentType(mime: string): string {
  return mime === "audio/ogg" ? "audio/ogg; codecs=opus" : mime;
}

/** Keep a customer- or staff-supplied file name safe to store and display. */
export function safeFilename(name: unknown, fallback: string): string {
  if (typeof name !== "string") return fallback;
  // deno-lint-ignore no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 120);
  return cleaned || fallback;
}

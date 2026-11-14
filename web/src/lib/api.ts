// Everything the web app asks the backend to do, in one place.

import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Message, MessageFlag, QuickReply, Staff } from "./types";

export const STAFF_EMAIL_DOMAIN = "company.demo";
export const MAX_TEXT_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;
const BUCKET = "files";
const MB = 1024 * 1024;

/**
 * What staff may attach. The same rules are enforced again by send-whatsapp.
 * Photos are limited to 5 MB because WhatsApp rejects larger images.
 */
const FILE_RULES: Record<string, { extension: string; maxBytes: number; label: string }> = {
  "image/jpeg": { extension: "jpg", maxBytes: 5 * MB, label: "Photos" },
  "image/png": { extension: "png", maxBytes: 5 * MB, label: "Photos" },
  "application/pdf": { extension: "pdf", maxBytes: 10 * MB, label: "PDF files" },
  "video/mp4": { extension: "mp4", maxBytes: 10 * MB, label: "Videos" },
  "audio/ogg": { extension: "ogg", maxBytes: 10 * MB, label: "Audio files" },
  "audio/mpeg": { extension: "mp3", maxBytes: 10 * MB, label: "Audio files" },
  "audio/mp4": { extension: "m4a", maxBytes: 10 * MB, label: "Audio files" },
  "audio/aac": { extension: "aac", maxBytes: 10 * MB, label: "Audio files" },
};
export const ALLOWED_FILE_TYPES = Object.keys(FILE_RULES);

function baseType(file: File): string {
  return file.type.split(";")[0].trim().toLowerCase();
}

/** Staff ID "EMP1001" signs in as emp1001@company.demo. Returns null for an invalid ID. */
export function staffEmail(staffId: string): string | null {
  const id = staffId.trim().toLowerCase();
  return /^[a-z0-9]{3,20}$/.test(id) ? `${id}@${STAFF_EMAIL_DOMAIN}` : null;
}

/** Calls an Edge Function and turns its JSON error into a normal Error. */
async function callFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return data as T;
  if (error instanceof FunctionsHttpError) {
    let message = "The server rejected the request";
    try {
      const payload = await (error.context as Response).json();
      if (typeof payload?.error === "string") message = payload.error;
      else if (typeof payload?.message === "string") message = payload.message;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  throw new Error(navigator.onLine ? "Could not reach the server. Try again." : "You are offline.");
}

function rpcError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export function validateFile(file: File): string | null {
  const rule = FILE_RULES[baseType(file)];
  if (!rule) return "Only JPEG or PNG photos, PDF files, MP4 videos and audio files can be sent.";
  if (file.size > rule.maxBytes) return `${rule.label} can be at most ${rule.maxBytes / MB} MB.`;
  if (file.size === 0) return "This file is empty.";
  return null;
}

export interface SendInput {
  conversationId: string;
  text?: string;
  file?: File;
  /** Send an OGG/Opus recording as a WhatsApp voice note. */
  voice?: boolean;
  /** Id of the message being quoted. */
  replyTo?: string;
  template?: "hello_world";
}

/** Uploads the file (if any) to the caller's private folder, then asks send-whatsapp to deliver it. */
export async function sendMessage(userId: string, input: SendInput): Promise<Message> {
  const body: Record<string, unknown> = { conversation_id: input.conversationId };
  if (input.template) {
    body.template = input.template;
  } else {
    if (input.text) body.text = input.text;
    if (input.replyTo) body.reply_to = input.replyTo;
    if (input.file) {
      const problem = validateFile(input.file);
      if (problem) throw new Error(problem);
      const type = baseType(input.file);
      const path = `outgoing/${userId}/${crypto.randomUUID()}.${FILE_RULES[type].extension}`;
      // WhatsApp only accepts OGG audio that declares the Opus codec.
      const contentType = type === "audio/ogg" ? "audio/ogg; codecs=opus" : type;
      // Upload the raw bytes (not a multipart form): only then does Storage keep the full
      // Content-Type, including "; codecs=opus".
      const bytes = await input.file.arrayBuffer();
      const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      body.media_path = path;
      body.filename = input.file.name;
      if (input.voice) body.voice = true;
    }
  }
  const result = await callFunction<{ message: Message }>("send-whatsapp", body);
  return result.message;
}

/** Reacts to a message with one emoji ("" removes our reaction). Returns the updated message. */
export async function sendReaction(conversationId: string, messageId: string, emoji: string): Promise<Message> {
  const result = await callFunction<{ message: Message }>("send-whatsapp", {
    conversation_id: conversationId,
    reaction: { message_id: messageId, emoji },
  });
  return result.message;
}

/**
 * Tells WhatsApp the customer's messages were read (blue ticks on the customer's phone)
 * and optionally shows "typing…" to the customer. Best effort: failures are ignored.
 */
export async function markReadAtWhatsApp(conversationId: string, typing = false): Promise<void> {
  try {
    await callFunction("mark-read", { conversation_id: conversationId, typing });
  } catch {
    // Reading a chat must work even when WhatsApp cannot be reached.
  }
}

// --- Files -------------------------------------------------------------------------

// Signed URLs for the private bucket, cached until shortly before they expire.
const SIGNED_URL_SECONDS = 60 * 60;
const urlCache = new Map<string, { url: string; expires: number }>();

export async function signedFileUrl(path: string): Promise<string> {
  const cached = urlCache.get(path);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data) throw new Error("File is not available");
  urlCache.set(path, { url: data.signedUrl, expires: Date.now() + (SIGNED_URL_SECONDS - 300) * 1000 });
  return data.signedUrl;
}

export function clearFileUrlCache(): void {
  urlCache.clear();
}

// --- Stars, hidden messages, quick replies, notes, search --------------------------------

export async function loadFlags(): Promise<MessageFlag[]> {
  const { data, error } = await supabase.from("message_flags").select("message_id, starred, hidden").limit(5000);
  rpcError(error);
  return (data ?? []) as MessageFlag[];
}

export async function setMessageFlags(messageId: string, starred: boolean, hidden: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_message_flags", {
    p_message_id: messageId,
    p_starred: starred,
    p_hidden: hidden,
  });
  rpcError(error);
}

export async function loadQuickReplies(): Promise<QuickReply[]> {
  const { data, error } = await supabase.from("quick_replies").select("id, shortcut, body").order("shortcut");
  rpcError(error);
  return (data ?? []) as QuickReply[];
}

export async function saveQuickReply(id: string | null, shortcut: string, body: string): Promise<void> {
  const { error } = await supabase.rpc("save_quick_reply", { p_id: id, p_shortcut: shortcut, p_body: body });
  rpcError(error);
}

export async function deleteQuickReply(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_quick_reply", { p_id: id });
  rpcError(error);
}

export async function updateConversationInfo(conversationId: string, notes: string, labels: string[]): Promise<void> {
  const { error } = await supabase.rpc("update_conversation_info", {
    p_conversation_id: conversationId,
    p_notes: notes,
    p_labels: labels,
  });
  rpcError(error);
}

/** Text search in messages: one chat when conversationId is given, otherwise all chats. */
export async function searchMessages(query: string, conversationId: string | null = null): Promise<Message[]> {
  const { data, error } = await supabase.rpc("search_messages", {
    p_query: query,
    p_conversation_id: conversationId,
    p_limit: 50,
  });
  rpcError(error);
  return (data ?? []) as Message[];
}

export async function loadMessagesByIds(ids: string[]): Promise<Message[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("wa_messages")
    .select("*")
    .in("id", ids.slice(0, 200))
    .order("created_at", { ascending: false });
  rpcError(error);
  return (data ?? []) as Message[];
}

// --- Admin (the admin-staff function checks the admin role on the server) ---

export function adminCreateStaff(input: { staffId: string; password: string; displayName: string; role: Staff["role"] }) {
  return callFunction<{ staff: Staff }>("admin-staff", {
    action: "create",
    staff_id: input.staffId,
    password: input.password,
    display_name: input.displayName,
    role: input.role,
  });
}

export function adminSetDisabled(userId: string, disabled: boolean) {
  return callFunction<{ staff: Staff }>("admin-staff", { action: "set_disabled", user_id: userId, disabled });
}

export function adminResetPassword(userId: string, password: string) {
  return callFunction<{ staff: Staff }>("admin-staff", { action: "reset_password", user_id: userId, password });
}

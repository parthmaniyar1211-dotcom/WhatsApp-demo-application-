// Everything the web app asks the backend to do, in one place.

import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Message, Staff } from "./types";

export const STAFF_EMAIL_DOMAIN = "company.demo";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_FILE_TYPES = ["image/jpeg", "image/png", "application/pdf"];
export const MAX_TEXT_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;
const BUCKET = "files";

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

export function validateFile(file: File): string | null {
  if (!ALLOWED_FILE_TYPES.includes(file.type)) return "Only JPEG or PNG photos and PDF files can be sent.";
  if (file.size > MAX_FILE_BYTES) return "This file is larger than 10 MB.";
  if (file.size === 0) return "This file is empty.";
  return null;
}

export interface SendInput {
  conversationId: string;
  text?: string;
  file?: File;
  template?: "hello_world";
}

/** Uploads the file (if any) to the caller's private folder, then asks send-whatsapp to deliver it. */
export async function sendMessage(userId: string, input: SendInput): Promise<Message> {
  const body: Record<string, unknown> = { conversation_id: input.conversationId };
  if (input.template) {
    body.template = input.template;
  } else {
    if (input.text) body.text = input.text;
    if (input.file) {
      const problem = validateFile(input.file);
      if (problem) throw new Error(problem);
      const extension = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" }[input.file.type];
      const path = `outgoing/${userId}/${crypto.randomUUID()}.${extension}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, input.file, { contentType: input.file.type });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      body.media_path = path;
      body.filename = input.file.name;
    }
  }
  const result = await callFunction<{ message: Message }>("send-whatsapp", body);
  return result.message;
}

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

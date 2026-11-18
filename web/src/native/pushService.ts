// Push notifications in the app: a provider-neutral seam. The Android build (Capacitor, a later phase) supplies a
// real implementation backed by Firebase Cloud Messaging once the owner has created the Firebase project and added
// google-services.json (see docs/FIREBASE_AND_NOTIFICATIONS.md). Until then the app uses NullPushService, so nothing
// pretends to work and no credential of any kind is in the code.

import { supabase } from "../lib/supabase";

export interface PushNotification {
  /** The chat to open (a deep link). Never message content. */
  conversationId: string | null;
}

export interface PushService {
  /** Is a push provider available on this device? */
  isSupported(): boolean;
  /** Asks permission (when the platform needs it) and returns the device token, or null when not granted. */
  register(): Promise<string | null>;
  /** Forgets the device (on sign out). */
  unregister(): Promise<void>;
  /** Called when the user taps a notification. Returns the unsubscribe function. */
  onOpen(handler: (n: PushNotification) => void): () => void;
}

export class NullPushService implements PushService {
  isSupported(): boolean {
    return false;
  }
  register(): Promise<string | null> {
    return Promise.resolve(null);
  }
  unregister(): Promise<void> {
    return Promise.resolve();
  }
  onOpen(): () => void {
    return () => {};
  }
}

let current: PushService = new NullPushService();

/** The Android entry point installs the real service here before the app starts. */
export function installPushService(service: PushService): void {
  current = service;
}

export function pushService(): PushService {
  return current;
}

/**
 * Registers this device for the signed-in login. The server derives the tenant from the login (the app sends
 * no tenant id) and re-assigns the token if another login used the same device before.
 */
export async function registerPushDevice(service: PushService = current): Promise<boolean> {
  if (!service.isSupported()) return false;
  const token = await service.register();
  if (!token) return false;
  const { error } = await supabase.rpc("register_push_device", { p_token: token, p_platform: "android" });
  if (error) throw new Error(error.message);
  return true;
}

/** Call before signing out so the device stops receiving this login's notifications. */
export async function unregisterPushDevice(service: PushService = current): Promise<void> {
  if (!service.isSupported()) return;
  const token = await service.register();
  if (token) await supabase.rpc("unregister_push_device", { p_token: token });
  await service.unregister();
}

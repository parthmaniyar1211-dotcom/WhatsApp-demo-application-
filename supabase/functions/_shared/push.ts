// Push notifications: a provider-neutral seam. NO provider is configured yet (Firebase Cloud Messaging
// needs a Firebase project and a service-account key that only the owner can create; see
// docs/FIREBASE_AND_NOTIFICATIONS.md). Until one is wired in, NullPushSender is used and nothing is sent.
// There are deliberately no placeholder or fake credentials anywhere.
//
// Two rules live here because they are security rules, not provider details:
//   1. A notification only ever goes to devices registered by members of the SAME tenant as the message
//      (selectPushTargets). A device re-registered by another login is re-assigned in the database
//      (register_push_device), so a previous account stops receiving pushes.
//   2. Message text is not part of the payload unless showPreview is true: lock screens are public.

export interface PushDevice {
  token: string;
  userId: string;
  tenantId: string;
  platform: "android" | "ios" | "web";
}

export interface PushMessage {
  title: string;
  body: string;
  /** What the app needs to open the right chat (deep link). Never message content. */
  data: { tenantId: string; conversationId: string };
}

export interface PushResult {
  sent: number;
  /** Tokens the provider reported as invalid; the caller deletes them. */
  invalidTokens: string[];
  skipped?: string;
}

export interface PushSender {
  send(devices: PushDevice[], message: PushMessage): Promise<PushResult>;
}

/** The default: no provider configured, nothing leaves the server. */
export class NullPushSender implements PushSender {
  send(): Promise<PushResult> {
    return Promise.resolve({ sent: 0, invalidTokens: [], skipped: "no push provider is configured" });
  }
}

/** Devices that may be notified about a message of `tenantId`. Never includes the person who sent it. */
export function selectPushTargets(devices: PushDevice[], tenantId: string, exceptUserId?: string | null): PushDevice[] {
  const seen = new Set<string>();
  const targets: PushDevice[] = [];
  for (const device of devices) {
    if (device.tenantId !== tenantId) continue;
    if (exceptUserId && device.userId === exceptUserId) continue;
    if (seen.has(device.token)) continue;
    seen.add(device.token);
    targets.push(device);
  }
  return targets;
}

export interface IncomingForPush {
  tenantId: string;
  conversationId: string;
  contactName: string;
  text: string | null;
}

/** Builds the notification. The text of the message is included only when the tenant asked for previews. */
export function buildPushMessage(incoming: IncomingForPush, showPreview = false): PushMessage {
  return {
    title: incoming.contactName.slice(0, 80) || "New message",
    body: showPreview && incoming.text ? incoming.text.slice(0, 120) : "New message",
    data: { tenantId: incoming.tenantId, conversationId: incoming.conversationId },
  };
}

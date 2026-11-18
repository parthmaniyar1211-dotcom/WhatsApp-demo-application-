// Row shapes of the Supabase tables (see whatsapp_setup.sql). The APK uses the same tables.

export interface Staff {
  user_id: string;
  staff_id: string;
  display_name: string;
  role: "admin" | "staff";
  disabled: boolean;
  /** True while the login still has an administrator-issued temporary password (enforced by the database). */
  must_change_password: boolean;
  created_at: string;
}

export interface Conversation {
  id: string;
  /** Phone number (digits), or Meta's business-scoped user id when the number is hidden. */
  wa_id: string;
  wa_user_id: string | null;
  customer_name: string | null;
  /** The name saved for this number (wins over the WhatsApp profile name). */
  contact_name: string | null;
  last_message_preview: string | null;
  last_message_at: string;
  last_inbound_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  notes: string;
  labels: string[];
  created_at: string;
}

export type MessageStatus = "received" | "sending" | "sent" | "delivered" | "read" | "played" | "failed";

export type MessageType =
  | "text"
  | "image"
  | "document"
  | "audio"
  | "video"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "button"
  | "template"
  | "other";

export interface MessageLocation {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
  url: string | null;
}

export interface MessageContact {
  name: string;
  phones: string[];
}

export interface Message {
  id: string;
  conversation_id: string;
  wa_message_id: string | null;
  direction: "in" | "out";
  type: MessageType;
  body: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_filename: string | null;
  media_size: number | null;
  media_voice: boolean;
  status: MessageStatus;
  error: string | null;
  sent_by: string | null;
  sent_by_staff_id: string | null;
  reply_to_wa_message_id: string | null;
  forwarded: boolean;
  location: MessageLocation | null;
  contacts: MessageContact[] | null;
  reaction_customer: string | null;
  reaction_business: string | null;
  reaction_business_by: string | null;
  created_at: string;
}

/** Per-staff flags on a message. */
export interface MessageFlag {
  message_id: string;
  starred: boolean;
  hidden: boolean;
}

export interface QuickReply {
  id: string;
  shortcut: string;
  body: string;
}

/** The newest message of a chat that this user has not deleted (for the chat list preview). */
export interface VisibleLast {
  conversation_id: string;
  message_id: string;
  direction: "in" | "out";
  type: MessageType;
  body: string | null;
  media_filename: string | null;
  media_voice: boolean;
  created_at: string;
}

// ---- Multi-tenant platform (see supabase/migrations/20261118*) ----

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended";
  created_at: string;
}

export type ConnectionStatus = "pending" | "connected" | "disconnected" | "revoked" | "error";

/** A WhatsApp number of a client. The token is never part of this row (it lives in Vault). */
export interface WhatsAppConnection {
  id: string;
  tenant_id: string;
  label: string;
  display_phone_number: string | null;
  waba_id: string | null;
  phone_number_id: string | null;
  credential_source: "vault" | "platform_env";
  status: ConnectionStatus;
  onboarding_method: "manual" | "embedded_signup" | "legacy";
  coexistence: "unknown" | "eligible" | "active" | "not_eligible";
  token_expires_at: string | null;
  last_webhook_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TenantSummary {
  tenant_id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  staff_count: number;
  staff_active: number;
  connection_count: number;
  connections_connected: number;
  last_webhook_at: string | null;
  messages_24h_in: number;
  messages_24h_out: number;
  failed_24h: number;
}

export interface AdminOverview {
  tenants: number;
  tenants_active: number;
  staff_total: number;
  staff_active: number;
  connections: Record<string, number>;
  messages_24h: { in: number; out: number; failed: number };
  tokens_expiring_7d: number;
  unrouted_events_24h: number;
  generated_at: string;
}

export interface AuditEntry {
  id: number;
  tenant_id: string | null;
  actor_staff_id: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface Membership {
  tenant_id: string;
  user_id: string;
  role: "owner" | "agent";
  disabled: boolean;
}

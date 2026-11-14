// Row shapes of the Supabase tables (see whatsapp_setup.sql). The APK uses the same tables.

export interface Staff {
  user_id: string;
  staff_id: string;
  display_name: string;
  role: "admin" | "staff";
  disabled: boolean;
  created_at: string;
}

export interface Conversation {
  id: string;
  /** Phone number (digits), or Meta's business-scoped user id when the number is hidden. */
  wa_id: string;
  wa_user_id: string | null;
  customer_name: string | null;
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

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
  wa_id: string;
  customer_name: string | null;
  last_message_preview: string | null;
  last_message_at: string;
  last_inbound_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  created_at: string;
}

export type MessageStatus = "received" | "sending" | "sent" | "delivered" | "read" | "failed";

export interface Message {
  id: string;
  conversation_id: string;
  wa_message_id: string | null;
  direction: "in" | "out";
  type: "text" | "image" | "document" | "template" | "other";
  body: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_filename: string | null;
  status: MessageStatus;
  error: string | null;
  sent_by: string | null;
  sent_by_staff_id: string | null;
  created_at: string;
}

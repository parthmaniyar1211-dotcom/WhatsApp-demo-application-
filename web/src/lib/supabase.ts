import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** True when web/.env is filled in. The app shows a setup screen otherwise. */
export const isConfigured = Boolean(url && anonKey && !url.includes("YOUR-PROJECT-REF"));

// Only the public anon key is used here. Everything the app may do is decided by
// row level security and the Edge Functions, never by this client.
export const supabase: SupabaseClient = createClient(
  isConfigured ? url! : "http://localhost:54321",
  isConfigured ? anonKey! : "not-configured",
);

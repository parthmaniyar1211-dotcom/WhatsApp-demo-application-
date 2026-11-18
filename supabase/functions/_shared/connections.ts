// Per-tenant WhatsApp connections as the Edge Functions see them.
//
// A connection is one WhatsApp Business number of one tenant. Its access token is stored in Supabase
// Vault (one secret per connection) and is decrypted only here, on the server, for the duration of a
// request. Nothing in this module ever returns a token to a browser or writes it to a log.
//
// The one exception is the legacy test number: its connection has credential_source = 'platform_env'
// and keeps using the global WA_TOKEN / WA_PHONE_ID secrets until that number is moved to Vault.

import { HttpError } from "./http.ts";

export interface ConnectionCredentials {
  connectionId: string;
  tenantId: string;
  /** Meta phone number id used in /<phone-number-id>/messages. */
  phoneId: string;
  /** Business access token. Never log, never return. */
  token: string;
}

export type CredentialFailure = "not_found" | "inactive" | "no_token" | "no_phone";

export type CredentialLookup =
  | { ok: true; credentials: ConnectionCredentials }
  | { ok: false; reason: CredentialFailure };

export interface ConnectionStore {
  /** Credentials of one connection, or the reason why it cannot be used. */
  getCredentials(connectionId: string): Promise<CredentialLookup>;
}

/** Looks the credentials up and turns every failure into a clear, token-free HTTP error. */
export async function requireCredentials(store: ConnectionStore, connectionId: string): Promise<ConnectionCredentials> {
  const lookup = await store.getCredentials(connectionId);
  if (lookup.ok) return lookup.credentials;
  switch (lookup.reason) {
    case "inactive":
      throw new HttpError(
        409,
        "This WhatsApp number is disconnected. Ask your administrator to reconnect it.",
        "connection_inactive",
      );
    case "not_found":
      throw new HttpError(404, "WhatsApp connection not found", "not_found");
    default:
      console.error(`connection ${connectionId}: ${lookup.reason}`);
      throw new HttpError(500, "WhatsApp is not configured for this account", "not_configured");
  }
}

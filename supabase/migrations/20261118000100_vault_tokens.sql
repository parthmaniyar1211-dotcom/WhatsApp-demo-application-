-- Multi-tenant foundation, part 2 of 4: per-connection WhatsApp access tokens in Supabase Vault.
--
-- One Vault secret per connection, named wa_conn_<connection id>. The connection row keeps only the
-- secret's id (vault_secret_id). Tokens are encrypted at rest by Vault and can be decrypted ONLY by
-- the three SECURITY DEFINER functions below, which are executable by the service role (Edge
-- Functions) and nobody else. The browser/APK can neither call them nor read the column
-- (see the column grants in part 3).
--
-- Requires the supabase_vault extension (enabled by default on Supabase projects and in the local stack).

create extension if not exists supabase_vault with schema vault;

-- Stores or replaces (rotates) the token of a connection.
create or replace function public.store_connection_token(
  p_connection_id uuid,
  p_token         text,
  p_expires_at    timestamptz default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
  v_source text;
begin
  if p_token is null or char_length(p_token) not between 20 and 2048 then
    raise exception 'token has an invalid length' using errcode = '22023';
  end if;

  select c.vault_secret_id, c.credential_source into v_secret, v_source
    from public.whatsapp_connections c
   where c.id = p_connection_id
     for update;
  if not found then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;
  if v_source <> 'vault' then
    raise exception 'this connection does not use Vault' using errcode = '22023';
  end if;

  if v_secret is null then
    v_secret := vault.create_secret(p_token, 'wa_conn_' || p_connection_id::text, 'WhatsApp access token');
  else
    perform vault.update_secret(v_secret, p_token);
  end if;

  update public.whatsapp_connections
     set vault_secret_id  = v_secret,
         token_expires_at = p_expires_at,
         token_rotated_at = now(),
         last_error       = null,
         updated_at       = now()
   where id = p_connection_id;
end $$;

-- Returns the decrypted token, or null when the connection has none (or is not a Vault connection).
create or replace function public.get_connection_token(p_connection_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select s.decrypted_secret into v_token
    from public.whatsapp_connections c
    join vault.decrypted_secrets s on s.id = c.vault_secret_id
   where c.id = p_connection_id
     and c.credential_source = 'vault'
     and c.status not in ('revoked');
  return v_token;
end $$;

-- Deletes the secret (revocation / disconnection). The connection stays, without a token.
create or replace function public.revoke_connection_token(p_connection_id uuid, p_status text default 'revoked')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  if p_status not in ('disconnected', 'revoked') then
    raise exception 'status must be disconnected or revoked' using errcode = '22023';
  end if;
  select c.vault_secret_id into v_secret from public.whatsapp_connections c where c.id = p_connection_id for update;
  if not found then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
  update public.whatsapp_connections
     set vault_secret_id = null, status = p_status, token_expires_at = null, updated_at = now()
   where id = p_connection_id;
end $$;

revoke all on function public.store_connection_token(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.get_connection_token(uuid)                      from public, anon, authenticated;
revoke all on function public.revoke_connection_token(uuid, text)              from public, anon, authenticated;
grant execute on function public.store_connection_token(uuid, text, timestamptz) to service_role;
grant execute on function public.get_connection_token(uuid)                      to service_role;
grant execute on function public.revoke_connection_token(uuid, text)              to service_role;

-- Direct access to the Vault tables. The platform itself grants service_role SELECT on
-- vault.decrypted_secrets, and only the platform role supabase_admin (not available to migrations)
-- could change that, so this migration does NOT pretend to restrict it. The protections that do hold:
--   * the vault schema is not exposed through the REST API (config.toml [api] schemas = ["public"]),
--   * anon and authenticated have no privilege on it,
--   * the application only reaches tokens through the three functions above,
--   * the service-role key exists only inside Edge Functions and the platform, never in a browser or APK.
-- Anyone holding the service-role key is therefore inside the trust boundary (documented in
-- docs/MULTI_TENANT_SECURITY.md).

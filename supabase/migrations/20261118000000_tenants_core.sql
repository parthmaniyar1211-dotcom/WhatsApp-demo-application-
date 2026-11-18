-- Multi-tenant foundation, part 1 of 4: tenants, memberships, WhatsApp connections, audit log,
-- webhook ledger, push devices, and the "Owner (test)" tenant that adopts all existing data.
--
-- Additive and idempotent: it only creates objects and fills NEW columns. No existing row is
-- changed or deleted, no existing column is altered. Enforcement (NOT NULL, new RLS policies,
-- tenant-aware functions) comes in 20261118000200_tenant_isolation.sql.
--
-- Model:
--   * tenant          one client of the platform (one business).
--   * membership      a staff login belongs to exactly one tenant (UNIQUE user_id) in this version.
--                     role owner/agent leaves room for several logins per client later.
--   * platform admin  staff.role = 'admin'. Sees tenants, connections, usage and the audit log, but
--                     reads message CONTENT only of the tenant it is a member of.
--   * connection      one WhatsApp Business number of a tenant (WABA id + phone number id). Tokens are
--                     never in this table: only a reference to a Vault secret (see part 2).

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        text not null check (char_length(name) between 1 and 120),
  status      text not null default 'active' check (status in ('active', 'suspended')),
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.tenant_memberships (
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  user_id     uuid not null references public.staff (user_id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner', 'agent')),
  disabled    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id),
  -- One tenant per login. Drop this constraint (and update current_tenant_id) to allow several.
  constraint tenant_memberships_one_tenant_per_user unique (user_id)
);

create table if not exists public.whatsapp_connections (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete restrict,
  label                 text not null default '',
  display_phone_number  text,
  waba_id               text,
  phone_number_id       text,
  -- 'vault'        the token lives in a Vault secret referenced by vault_secret_id (all new connections).
  -- 'platform_env' the single legacy connection that still uses the global WA_TOKEN secret (test number).
  credential_source     text not null default 'vault' check (credential_source in ('vault', 'platform_env')),
  vault_secret_id       uuid,
  status                text not null default 'pending'
                          check (status in ('pending', 'connected', 'disconnected', 'revoked', 'error')),
  onboarding_method     text not null default 'manual' check (onboarding_method in ('manual', 'embedded_signup', 'legacy')),
  coexistence           text not null default 'unknown' check (coexistence in ('unknown', 'eligible', 'active', 'not_eligible')),
  token_expires_at      timestamptz,
  token_rotated_at      timestamptz,
  last_webhook_at       timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Lets other tables reference (connection, tenant) together, so a row can never name a
  -- connection that belongs to another tenant.
  constraint whatsapp_connections_id_tenant_key unique (id, tenant_id)
);
-- A phone number id can belong to exactly one connection on the whole platform.
create unique index if not exists whatsapp_connections_phone_number_id_key
  on public.whatsapp_connections (phone_number_id) where phone_number_id is not null;
-- Only one connection may use the global WA_TOKEN secret.
create unique index if not exists whatsapp_connections_single_platform_env
  on public.whatsapp_connections (credential_source) where credential_source = 'platform_env';
create index if not exists whatsapp_connections_tenant_idx on public.whatsapp_connections (tenant_id);

-- Insert-only record of administrative operations. Never contains secrets.
create table if not exists public.audit_logs (
  id              bigint generated always as identity primary key,
  tenant_id       uuid references public.tenants (id) on delete set null,
  actor_user_id   uuid,
  actor_staff_id  text,
  action          text not null check (char_length(action) between 1 and 80),
  target          text,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_tenant_idx on public.audit_logs (tenant_id, created_at desc);

-- One row per webhook change set that reached us: routing outcome only, never message content.
create table if not exists public.webhook_events (
  id               bigint generated always as identity primary key,
  received_at      timestamptz not null default now(),
  phone_number_id  text,
  waba_id          text,
  field            text,
  connection_id    uuid references public.whatsapp_connections (id) on delete set null,
  outcome          text not null check (outcome in ('routed', 'unrouted', 'inactive', 'mismatch', 'error')),
  detail           text
);
create index if not exists webhook_events_received_idx on public.webhook_events (received_at desc);
create index if not exists webhook_events_connection_idx on public.webhook_events (connection_id, received_at desc);

-- FCM registration tokens (the push sender is added with the notification phase).
create table if not exists public.push_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.staff (user_id) on delete cascade,
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  fcm_token     text not null unique check (char_length(fcm_token) between 20 and 4096),
  platform      text not null default 'android' check (platform in ('android', 'ios', 'web')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index if not exists push_devices_user_idx on public.push_devices (user_id);

-- ---------------------------------------------------------------------------------------------
-- Tenant helpers (single source of truth for "which tenant is this login in?")
-- ---------------------------------------------------------------------------------------------

-- The tenant(s) of the logged-in user. Empty when the login is disabled, has no membership, or its
-- tenant is suspended. Always derived from the database, never from anything the client sends.
create or replace function public.current_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
    from public.tenant_memberships m
    join public.tenants t on t.id = m.tenant_id
    join public.staff s on s.user_id = m.user_id
   where m.user_id = (select auth.uid())
     and not m.disabled
     and not s.disabled
     and t.status = 'active';
$$;

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t from public.current_tenant_ids() as t limit 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- New columns on the existing tables (nullable here; made NOT NULL after the backfill below)
-- ---------------------------------------------------------------------------------------------

alter table public.conversations add column if not exists tenant_id uuid;
alter table public.conversations add column if not exists connection_id uuid;
alter table public.wa_messages   add column if not exists tenant_id uuid;
alter table public.quick_replies add column if not exists tenant_id uuid;

-- ---------------------------------------------------------------------------------------------
-- "Owner (test)" tenant: adopts everything that exists today
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_tenant uuid;
  v_conn   uuid;
begin
  select id into v_tenant from public.tenants where slug = 'owner-test';
  if v_tenant is null then
    insert into public.tenants (slug, name) values ('owner-test', 'Owner (test)') returning id into v_tenant;
  end if;

  -- Every existing login joins the tenant (the platform admin as owner).
  insert into public.tenant_memberships (tenant_id, user_id, role)
  select v_tenant, s.user_id, case when s.role = 'admin' then 'owner' else 'agent' end
    from public.staff s
   where not exists (select 1 from public.tenant_memberships m where m.user_id = s.user_id);

  -- The current test number keeps using the global WA_TOKEN / WA_PHONE_ID secrets. Its phone number
  -- id is learned by the first webhook or send that carries it (bind_legacy_connection, part 4), so
  -- no secret has to be read or copied here.
  select id into v_conn from public.whatsapp_connections where credential_source = 'platform_env';
  if v_conn is null then
    insert into public.whatsapp_connections
      (tenant_id, label, credential_source, status, onboarding_method, coexistence)
    values
      (v_tenant, 'Meta test number', 'platform_env', 'connected', 'legacy', 'unknown')
    returning id into v_conn;
  end if;

  update public.conversations set tenant_id = v_tenant, connection_id = v_conn where tenant_id is null;
  update public.wa_messages   set tenant_id = v_tenant where tenant_id is null;
  update public.quick_replies set tenant_id = v_tenant where tenant_id is null;
end $$;

// Calls of the platform admin console. Every one of them is checked again on the server:
// the admin RPCs and the admin Edge Functions refuse anyone who is not an active platform admin.

import { supabase } from "./supabase";
import { callFunction } from "./api";
import type {
  AdminOverview,
  AuditEntry,
  Membership,
  Staff,
  Tenant,
  TenantSummary,
  WhatsAppConnection,
} from "./types";

function rpcError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export async function loadOverview(): Promise<AdminOverview> {
  const { data, error } = await supabase.rpc("admin_overview");
  rpcError(error);
  return data as AdminOverview;
}

export async function loadTenantSummaries(): Promise<TenantSummary[]> {
  const { data, error } = await supabase.rpc("admin_tenant_summary");
  rpcError(error);
  return (data ?? []) as TenantSummary[];
}

export async function loadTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase.from("tenants").select("*").order("created_at");
  rpcError(error);
  return (data ?? []) as Tenant[];
}

export async function loadAllStaff(): Promise<Staff[]> {
  const { data, error } = await supabase.from("staff").select("*").order("created_at");
  rpcError(error);
  return (data ?? []) as Staff[];
}

export async function loadMemberships(): Promise<Membership[]> {
  const { data, error } = await supabase.from("tenant_memberships").select("tenant_id, user_id, role, disabled");
  rpcError(error);
  return (data ?? []) as Membership[];
}

/** Explicit column list: the Vault reference column is not readable by anyone but the server. */
export const CONNECTION_COLUMNS =
  "id, tenant_id, label, display_phone_number, waba_id, phone_number_id, credential_source, status, onboarding_method, coexistence, token_expires_at, last_webhook_at, last_error, created_at, updated_at";

export async function loadConnections(): Promise<WhatsAppConnection[]> {
  const { data, error } = await supabase.from("whatsapp_connections").select(CONNECTION_COLUMNS).order("created_at");
  rpcError(error);
  return (data ?? []) as unknown as WhatsAppConnection[];
}

export async function loadAudit(limit = 100): Promise<AuditEntry[]> {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, tenant_id, actor_staff_id, action, target, detail, created_at")
    .order("id", { ascending: false })
    .limit(limit);
  rpcError(error);
  return (data ?? []) as AuditEntry[];
}

export interface CreatedAccount {
  staff: Staff & { tenant_id: string | null };
  /** Present only when the server generated the password. Shown once, never stored. */
  temporary_password?: string;
}

export function createClientAccount(input: {
  clientName?: string;
  tenantId?: string;
  displayName: string;
  staffId?: string;
  password?: string;
}): Promise<CreatedAccount> {
  return callFunction<CreatedAccount>("admin-staff", {
    action: "create",
    ...(input.tenantId ? { tenant_id: input.tenantId } : { client_name: input.clientName }),
    display_name: input.displayName,
    ...(input.staffId ? { staff_id: input.staffId } : {}),
    ...(input.password ? { password: input.password } : {}),
  });
}

export function setStaffDisabled(userId: string, disabled: boolean): Promise<{ staff: Staff }> {
  return callFunction("admin-staff", { action: "set_disabled", user_id: userId, disabled });
}

export function resetStaffPassword(userId: string): Promise<{ staff: Staff; temporary_password: string }> {
  return callFunction("admin-staff", { action: "reset_password", user_id: userId });
}

export async function setTenantStatus(tenantId: string, status: "active" | "suspended"): Promise<void> {
  const { error } = await supabase.rpc("admin_set_tenant_status", { p_tenant_id: tenantId, p_status: status });
  rpcError(error);
}

export type ConnectionAction = "disconnect" | "revoke" | "reconnect";

export function createConnection(input: {
  tenantId: string;
  label: string;
  displayPhoneNumber?: string;
  wabaId?: string;
  phoneNumberId?: string;
}): Promise<{ connection: WhatsAppConnection }> {
  return callFunction("admin-connections", {
    action: "create",
    tenant_id: input.tenantId,
    label: input.label,
    display_phone_number: input.displayPhoneNumber || undefined,
    waba_id: input.wabaId || undefined,
    phone_number_id: input.phoneNumberId || undefined,
  });
}

export function connectionAction(action: ConnectionAction, connectionId: string): Promise<{ status: string }> {
  return callFunction("admin-connections", { action, connection_id: connectionId });
}

/** Development only: the server refuses it unless ALLOW_MANUAL_TOKEN is on. The token is never returned. */
export function setConnectionToken(connectionId: string, token: string, expiresAt?: string): Promise<{ status: string }> {
  return callFunction("admin-connections", {
    action: "set_token",
    connection_id: connectionId,
    token,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  });
}

/** Embedded Signup. Switched off on the server until Meta Tech Provider approval is confirmed. */
export function startOnboarding(tenantId: string): Promise<unknown> {
  return callFunction("admin-connections", { action: "start_onboarding", tenant_id: tenantId });
}

/** Metadata about webhook routing (counts, reasons, unknown Phone Number IDs). Never message text or customer numbers. */
export interface RoutingDiagnostics {
  generated_at: string;
  outcomes_24h: Record<string, number>;
  reasons_24h: Record<string, number>;
  unrouted_phone_numbers: Array<{
    phone_number_id: string | null;
    events: number;
    pending: number;
    first_seen: string;
    last_seen: string;
    reasons: string[];
  }>;
  quarantine: { pending: number; oldest_pending_seconds: number | null; replayed_24h: number; expiring_within_24h: number };
  connections: { legacy_unbound: boolean; without_phone_number_id: number; connected_without_webhook_7d: number };
  retention: { quarantine_days: number; ledger_days: number };
}

export async function loadRoutingDiagnostics(): Promise<RoutingDiagnostics> {
  const { data, error } = await supabase.rpc("admin_routing_diagnostics");
  rpcError(error);
  return data as RoutingDiagnostics;
}

/** Replays the quarantined events of one Phone Number ID after its connection was fixed. Counts only. */
export function replayQuarantine(phoneNumberId: string): Promise<{ claimed: number; replayed: number; still_unroutable: number; failed: number }> {
  return callFunction("webhook-replay", { phone_number_id: phoneNumberId });
}

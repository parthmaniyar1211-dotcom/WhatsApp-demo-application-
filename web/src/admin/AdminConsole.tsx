import { useState } from "react";
import { supabase } from "../lib/supabase";
import { brand } from "../brand";
import type { Staff } from "../lib/types";
import { AuditTab } from "./AuditTab";
import { ClientsTab } from "./ClientsTab";
import { ConnectionsTab } from "./ConnectionsTab";
import { OverviewTab } from "./OverviewTab";
import { WebhooksTab } from "./WebhooksTab";

type Tab = "overview" | "clients" | "connections" | "webhooks" | "audit";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "clients", label: "Clients" },
  { id: "connections", label: "WhatsApp numbers" },
  { id: "webhooks", label: "Webhooks" },
  { id: "audit", label: "Audit log" },
];

/**
 * The platform administrator's console. It is only offered to platform admins, and every call behind it is
 * checked again on the server (RLS + admin-only functions), so hiding it in the UI is a convenience, not security.
 */
export function AdminConsole({ me, onBackToChats }: { me: Staff; onBackToChats: (() => void) | null }) {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="admin" data-testid="admin-console">
      <header className="admin-header">
        <div>
          <h1>{brand.name} administration</h1>
          <span className="muted small">
            {brand.company} · signed in as {me.staff_id}
          </span>
        </div>
        <span className="spacer" />
        {onBackToChats && (
          <button type="button" className="button" onClick={onBackToChats} data-testid="admin-back">
            Back to chats
          </button>
        )}
        <button type="button" className="button" onClick={() => void supabase.auth.signOut()}>
          Log out
        </button>
      </header>
      <nav className="admin-tabs" role="tablist" aria-label="Administration">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)} data-testid={`tab-${t.id}`}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="admin-body">
        {tab === "overview" && <OverviewTab />}
        {tab === "clients" && <ClientsTab />}
        {tab === "connections" && <ConnectionsTab />}
        {tab === "webhooks" && <WebhooksTab />}
        {tab === "audit" && <AuditTab />}
      </main>
    </div>
  );
}

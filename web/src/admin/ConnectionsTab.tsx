import { useCallback, useState } from "react";
import {
  connectionAction,
  createConnection,
  loadConnections,
  loadTenants,
  setConnectionToken,
  startOnboarding,
  type ConnectionAction,
} from "../lib/adminApi";
import { errorMessage } from "../lib/format";
import type { Tenant, WhatsAppConnection } from "../lib/types";
import { ErrorBlock } from "./OverviewTab";
import { daysUntil, useLoader, when } from "./useLoader";

interface Data {
  connections: WhatsAppConnection[];
  tenants: Tenant[];
}

async function loadAll(): Promise<Data> {
  const [connections, tenants] = await Promise.all([loadConnections(), loadTenants()]);
  return { connections, tenants };
}

const STATUS_CLASS: Record<string, string> = { connected: "ok", pending: "", disconnected: "warn", revoked: "warn", error: "bad" };
const COEXISTENCE: Record<string, string> = {
  unknown: "Not checked",
  eligible: "Eligible",
  active: "Active",
  not_eligible: "Not eligible",
};
// Shown only in builds made for development; the server refuses it anyway unless ALLOW_MANUAL_TOKEN is on.
const SHOW_MANUAL_TOKEN = import.meta.env.VITE_ENABLE_MANUAL_TOKEN === "true";

export function ConnectionsTab() {
  const { result, reload } = useLoader<Data>(loadAll);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [tokenFor, setTokenFor] = useState<string | null>(null);

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      setMessage(null);
      try {
        await action();
        setMessage({ kind: "ok", text: label });
        reload();
      } catch (err) {
        setMessage({ kind: "error", text: errorMessage(err) });
      }
    },
    [reload],
  );

  if (result.state === "loading") return <p className="muted">Loading…</p>;
  if (result.state === "error") return <ErrorBlock message={result.message} onRetry={reload} />;
  const { connections, tenants } = result.data;
  const tenantName = (id: string) => tenants.find((t) => t.id === id)?.name ?? "Unknown client";

  function act(action: ConnectionAction, c: WhatsAppConnection) {
    const verb = { disconnect: "Disconnect", revoke: "Revoke the token of", reconnect: "Reconnect" }[action];
    if (action !== "reconnect" && !window.confirm(`${verb} ${c.label || c.display_phone_number || "this number"}? Messages stop immediately.`)) return;
    void run(`${verb} done.`, () => connectionAction(action, c.id));
  }

  return (
    <section aria-label="WhatsApp connections" data-testid="admin-connections">
      <div className="notice warning" data-testid="onboarding-flag">
        <strong>Connect with Meta (Embedded Signup) is not enabled.</strong> It needs an approved Meta Tech Provider app,
        which has not been verified. Until then a connection is created here and its token is added by an authorised
        person through the server. Real clients are not onboarded yet.{" "}
        <button
          type="button"
          className="button small"
          disabled
          title="Waiting for Meta Tech Provider approval"
          onClick={() => void run("", () => startOnboarding(tenants[0]?.id ?? ""))}
        >
          Connect with Meta
        </button>
      </div>
      <NewConnection tenants={tenants} onCreated={() => { setMessage({ kind: "ok", text: "Connection created. It stays pending until a token is added." }); reload(); }} />
      {message && (
        <p className={`notice ${message.kind === "ok" ? "success" : "error"}`} role="status" data-testid="admin-message">
          {message.text}
        </p>
      )}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Client / number</th>
              <th>Status</th>
              <th>Coexistence</th>
              <th>Token</th>
              <th>Last webhook</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {connections.map((c) => {
              const days = daysUntil(c.token_expires_at);
              return (
                <tr key={c.id} data-testid={`connection-${c.id}`}>
                  <td>
                    <strong>{tenantName(c.tenant_id)}</strong>
                    <br />
                    <span className="muted small">
                      {c.label || "Number"} {c.display_phone_number ? `· ${c.display_phone_number}` : ""}
                      {c.credential_source === "platform_env" ? " · test number (platform secret)" : ""}
                    </span>
                  </td>
                  <td>
                    <span className={`pill ${STATUS_CLASS[c.status] ?? ""}`}>{c.status}</span>
                    {c.last_error && <div className="muted small">{c.last_error}</div>}
                  </td>
                  <td>{COEXISTENCE[c.coexistence]}</td>
                  <td>
                    {c.credential_source === "platform_env"
                      ? "Platform secret"
                      : c.token_expires_at
                      ? days !== null && days < 0
                        ? <span className="pill bad">expired</span>
                        : <span className={`pill ${days !== null && days <= 7 ? "warn" : "ok"}`}>{days}d left</span>
                      : c.status === "connected"
                      ? "No expiry recorded"
                      : "None"}
                  </td>
                  <td>{when(c.last_webhook_at)}</td>
                  <td className="admin-actions">
                    {(c.status === "disconnected" || c.status === "error") && (
                      <button type="button" className="button small" onClick={() => act("reconnect", c)}>
                        Reconnect
                      </button>
                    )}
                    {c.status !== "disconnected" && c.status !== "revoked" && (
                      <button type="button" className="button small" onClick={() => act("disconnect", c)}>
                        Disconnect
                      </button>
                    )}
                    {c.credential_source === "vault" && c.status !== "revoked" && (
                      <button type="button" className="button small danger" onClick={() => act("revoke", c)}>
                        Revoke token
                      </button>
                    )}
                    {SHOW_MANUAL_TOKEN && c.credential_source === "vault" && (
                      <button type="button" className="button small" onClick={() => setTokenFor(tokenFor === c.id ? null : c.id)}>
                        Set token (dev)
                      </button>
                    )}
                    {tokenFor === c.id && <TokenForm connectionId={c.id} onDone={(text) => { setTokenFor(null); setMessage({ kind: "ok", text }); reload(); }} onError={(text) => setMessage({ kind: "error", text })} />}
                  </td>
                </tr>
              );
            })}
            {connections.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No connections yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NewConnection({ tenants, onCreated }: { tenants: Tenant[]; onCreated: () => void }) {
  const [tenantId, setTenantId] = useState("");
  const [label, setLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [waba, setWaba] = useState("");
  const [phoneId, setPhoneId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!tenantId) return setError("Choose the client.");
    setBusy(true);
    setError(null);
    try {
      await createConnection({ tenantId, label: label.trim(), displayPhoneNumber: phone.trim(), wabaId: waba.trim(), phoneNumberId: phoneId.trim() });
      setLabel("");
      setPhone("");
      setWaba("");
      setPhoneId("");
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="admin-form" onSubmit={submit} noValidate aria-label="New connection" data-testid="new-connection-form">
      <h3>New connection</h3>
      <div className="admin-form-grid">
        <label className="field">
          <span>Client</span>
          <select name="connTenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="">Choose…</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Label</span>
          <input name="connLabel" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </label>
        <label className="field">
          <span>Phone number (for display)</span>
          <input name="connPhone" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
        </label>
        <label className="field">
          <span>WABA ID</span>
          <input name="connWaba" value={waba} onChange={(e) => setWaba(e.target.value)} inputMode="numeric" />
        </label>
        <label className="field">
          <span>Phone number ID</span>
          <input name="connPhoneId" value={phoneId} onChange={(e) => setPhoneId(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button className="button primary" type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create connection"}
      </button>
    </form>
  );
}

function TokenForm({ connectionId, onDone, onError }: { connectionId: string; onDone: (text: string) => void; onError: (text: string) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await setConnectionToken(connectionId, token.trim());
      setToken(""); // never kept in the page
      onDone(`Token stored in Vault. Status: ${result.status}.`);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="row">
      <input name="devToken" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Access token" aria-label="Access token" />
      <button className="button small primary" type="submit" disabled={busy || token.length < 20}>
        Store
      </button>
    </form>
  );
}

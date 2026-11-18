import { useCallback, useState } from "react";
import {
  createClientAccount,
  loadAllStaff,
  loadMemberships,
  loadTenantSummaries,
  resetStaffPassword,
  setStaffDisabled,
  setTenantStatus,
} from "../lib/adminApi";
import { STAFF_ID_PATTERN } from "../lib/api";
import { errorMessage } from "../lib/format";
import type { Membership, Staff, TenantSummary } from "../lib/types";
import { CredentialDialog } from "./CredentialDialog";
import { ErrorBlock } from "./OverviewTab";
import { useLoader, when } from "./useLoader";

interface Data {
  summaries: TenantSummary[];
  staff: Staff[];
  memberships: Membership[];
}

async function loadAll(): Promise<Data> {
  const [summaries, staff, memberships] = await Promise.all([loadTenantSummaries(), loadAllStaff(), loadMemberships()]);
  return { summaries, staff, memberships };
}

export function ClientsTab() {
  const { result, reload } = useLoader<Data>(loadAll);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [credential, setCredential] = useState<{ staffId: string; password: string; heading: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
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
  const { summaries, staff, memberships } = result.data;

  return (
    <section aria-label="Clients" data-testid="admin-clients">
      <NewClient
        tenants={summaries}
        onCreated={(account) => {
          if (account.temporary_password) {
            setCredential({ staffId: account.staff.staff_id, password: account.temporary_password, heading: "Client account created" });
          }
          setMessage({ kind: "ok", text: `Created ${account.staff.staff_id}.` });
          reload();
        }}
      />
      {message && (
        <p className={`notice ${message.kind === "ok" ? "success" : "error"}`} role="status" data-testid="admin-message">
          {message.text}
        </p>
      )}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Status</th>
              <th>Logins</th>
              <th>WhatsApp numbers</th>
              <th>Last 24 h (in / out / failed)</th>
              <th>Last webhook</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {summaries.map((t) => {
              const members = memberships.filter((m) => m.tenant_id === t.tenant_id);
              const open = expanded === t.tenant_id;
              return (
                <Row key={t.tenant_id} open={open}>
                  <tr data-testid={`client-row-${t.slug}`}>
                    <td>
                      <button type="button" className="link-button" onClick={() => setExpanded(open ? null : t.tenant_id)} aria-expanded={open}>
                        {t.name}
                      </button>
                    </td>
                    <td>
                      <span className={`pill ${t.status === "active" ? "ok" : "warn"}`}>{t.status}</span>
                    </td>
                    <td>
                      {t.staff_active} / {t.staff_count}
                    </td>
                    <td>
                      {t.connections_connected} / {t.connection_count} connected
                    </td>
                    <td>
                      {t.messages_24h_in} / {t.messages_24h_out} / {t.failed_24h}
                    </td>
                    <td>{when(t.last_webhook_at)}</td>
                    <td className="admin-actions">
                      <button
                        type="button"
                        className="button small"
                        onClick={() => {
                          const next = t.status === "active" ? "suspended" : "active";
                          if (next === "suspended" && !window.confirm(`Suspend ${t.name}? All of its logins lose access immediately.`)) return;
                          void run(next === "suspended" ? `Suspended ${t.name}.` : `Reactivated ${t.name}.`, () => setTenantStatus(t.tenant_id, next));
                        }}
                      >
                        {t.status === "active" ? "Suspend" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="admin-subrow">
                      <td colSpan={7}>
                        <ul className="admin-staff-list">
                          {members.map((m) => {
                            const person = staff.find((s) => s.user_id === m.user_id);
                            if (!person) return null;
                            return (
                              <li key={m.user_id} data-testid={`staff-${person.staff_id}`}>
                                <strong>{person.staff_id}</strong> {person.display_name && <span className="muted">· {person.display_name}</span>}{" "}
                                <span className="pill">{m.role}</span>{" "}
                                <span className={`pill ${person.disabled ? "warn" : "ok"}`}>{person.disabled ? "disabled" : "active"}</span>
                                <span className="spacer" />
                                <button
                                  type="button"
                                  className="button small"
                                  onClick={() => {
                                    if (!person.disabled && !window.confirm(`Disable ${person.staff_id}? They are signed out of data access at once.`)) return;
                                    void run(`${person.disabled ? "Enabled" : "Disabled"} ${person.staff_id}.`, async () => {
                                      await setStaffDisabled(person.user_id, !person.disabled);
                                    });
                                  }}
                                >
                                  {person.disabled ? "Enable" : "Disable"}
                                </button>
                                <button
                                  type="button"
                                  className="button small"
                                  onClick={() => {
                                    if (!window.confirm(`Reset the password of ${person.staff_id}? The old password stops working.`)) return;
                                    void run(`Password of ${person.staff_id} reset.`, async () => {
                                      const reset = await resetStaffPassword(person.user_id);
                                      setCredential({ staffId: person.staff_id, password: reset.temporary_password, heading: "Password reset" });
                                    });
                                  }}
                                >
                                  Reset password
                                </button>
                              </li>
                            );
                          })}
                          {members.length === 0 && <li className="muted">No logins yet.</li>}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Row>
              );
            })}
          </tbody>
        </table>
      </div>
      {credential && <CredentialDialog {...credential} onClose={() => setCredential(null)} />}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode; open: boolean }) {
  return <>{children}</>;
}

function NewClient({ tenants, onCreated }: { tenants: TenantSummary[]; onCreated: (a: Awaited<ReturnType<typeof createClientAccount>>) => void }) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [clientName, setClientName] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [staffId, setStaffId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (mode === "new" && !clientName.trim()) return setError("Enter the client's business name.");
    if (mode === "existing" && !tenantId) return setError("Choose the client.");
    if (staffId && !STAFF_ID_PATTERN.test(staffId)) return setError("Staff ID must be 3 to 20 letters or digits.");
    setBusy(true);
    try {
      const account = await createClientAccount({
        ...(mode === "new" ? { clientName: clientName.trim() } : { tenantId }),
        displayName: displayName.trim(),
        staffId: staffId.trim() || undefined,
      });
      setClientName("");
      setDisplayName("");
      setStaffId("");
      onCreated(account);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="admin-form" onSubmit={submit} noValidate aria-label="New client" data-testid="new-client-form">
      <h3>{mode === "new" ? "New client" : "Add a login to a client"}</h3>
      <div className="admin-form-grid">
        {mode === "new" ? (
          <label className="field">
            <span>Business name</span>
            <input name="clientName" value={clientName} onChange={(e) => setClientName(e.target.value)} maxLength={120} />
          </label>
        ) : (
          <label className="field">
            <span>Client</span>
            <select name="tenantId" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">Choose…</option>
              {tenants.map((t) => (
                <option key={t.tenant_id} value={t.tenant_id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Contact name (optional)</span>
          <input name="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
        </label>
        <label className="field">
          <span>Staff ID (optional, generated if empty)</span>
          <input name="newStaffId" value={staffId} onChange={(e) => setStaffId(e.target.value.toUpperCase())} maxLength={20} />
        </label>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create login"}
        </button>
        <button type="button" className="link-button" onClick={() => setMode(mode === "new" ? "existing" : "new")}>
          {mode === "new" ? "Add a login to an existing client instead" : "Create a new client instead"}
        </button>
      </div>
      <p className="muted small">A temporary password is generated and shown once. The client must change it at the first sign-in.</p>
    </form>
  );
}

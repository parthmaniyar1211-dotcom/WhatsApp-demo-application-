import { useState } from "react";
import type { Staff } from "../lib/types";
import { adminCreateStaff, adminResetPassword, adminSetDisabled, STAFF_EMAIL_DOMAIN } from "../lib/api";
import { errorMessage } from "../lib/format";

interface Props {
  me: Staff;
  staff: Staff[];
  onChanged: () => void;
}

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Staff management. Every action is checked again on the server (admin-staff function). */
export function AdminPage({ me, staff, onChanged }: Props) {
  const [staffId, setStaffId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Staff["role"]>("staff");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const sorted = [...staff].sort((a, b) => a.staff_id.localeCompare(b.staff_id));

  async function run(action: () => Promise<unknown>, success: string, after?: () => void) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice({ kind: "ok", text: success });
      after?.();
      onChanged();
    } catch (err) {
      setNotice({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  function create(event: React.FormEvent) {
    event.preventDefault();
    const id = staffId.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,20}$/.test(id)) {
      setNotice({ kind: "error", text: "Staff ID must be 3-20 letters or digits, for example EMP1001." });
      return;
    }
    if (password.length < 8) {
      setNotice({ kind: "error", text: "Password must be at least 8 characters." });
      return;
    }
    void run(
      () => adminCreateStaff({ staffId: id, password, displayName: displayName.trim(), role }),
      `Created ${id}. Give the staff member their ID and password.`,
      () => {
        setStaffId("");
        setDisplayName("");
        setPassword("");
        setRole("staff");
      },
    );
  }

  return (
    <div className="admin" data-testid="admin-page">
      <header className="conversation-header">
        <a className="back" href="#/" aria-label="Back to inbox">
          ‹
        </a>
        <div className="conversation-title">
          <h2>Staff accounts</h2>
          <p className="muted small">Admins only. No public signup.</p>
        </div>
      </header>

      <div className="admin-body">
        {notice && (
          <p className={`notice ${notice.kind === "ok" ? "success" : "error"}`} role="status" data-testid="admin-notice">
            {notice.text}
          </p>
        )}

        <form className="panel" onSubmit={create}>
          <h3>Create staff login</h3>
          <div className="form-grid">
            <label className="field">
              <span>Staff ID</span>
              <input
                name="new-staff-id"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                placeholder="EMP1002"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Name</span>
              <input name="new-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              <span>Password (min 8)</span>
              <span className="input-with-button">
                <input
                  name="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="button small" onClick={() => setPassword(generatePassword())}>
                  Generate
                </button>
              </span>
            </label>
            <label className="field">
              <span>Role</span>
              <select name="new-role" value={role} onChange={(e) => setRole(e.target.value as Staff["role"])}>
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          <p className="muted small">
            {staffId.trim() ? staffId.trim().toUpperCase() : "EMP1002"} signs in with this ID (stored as{" "}
            {(staffId.trim() || "emp1002").toLowerCase()}@{STAFF_EMAIL_DOMAIN}).
          </p>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "Working…" : "Create"}
          </button>
        </form>

        <div className="panel">
          <h3>All staff ({sorted.length})</h3>
          <ul className="staff-list">
            {sorted.map((s) => (
              <li key={s.user_id} className={s.disabled ? "disabled" : ""} data-testid="staff-row" data-staff-id={s.staff_id}>
                <div className="staff-info">
                  <strong>{s.staff_id}</strong>
                  <span className="muted">{s.display_name || "No name"}</span>
                  <span className="chip">{s.role}</span>
                  {s.disabled && <span className="chip danger">Disabled</span>}
                  {s.user_id === me.user_id && <span className="chip">You</span>}
                </div>
                <div className="staff-actions">
                  <button
                    className="button small"
                    disabled={busy}
                    onClick={() => {
                      setResetFor(resetFor === s.user_id ? null : s.user_id);
                      setNewPassword("");
                    }}
                  >
                    Reset password
                  </button>
                  {s.user_id !== me.user_id && (
                    <button
                      className={`button small ${s.disabled ? "" : "danger"}`}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => adminSetDisabled(s.user_id, !s.disabled),
                          s.disabled ? `${s.staff_id} can sign in again.` : `${s.staff_id} is disabled and can no longer read or send.`,
                        )
                      }
                    >
                      {s.disabled ? "Enable" : "Disable"}
                    </button>
                  )}
                </div>
                {resetFor === s.user_id && (
                  <form
                    className="reset-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newPassword.length < 8) {
                        setNotice({ kind: "error", text: "Password must be at least 8 characters." });
                        return;
                      }
                      void run(
                        () => adminResetPassword(s.user_id, newPassword),
                        `Password of ${s.staff_id} changed.`,
                        () => setResetFor(null),
                      );
                    }}
                  >
                    <input
                      name="reset-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="New password (min 8)"
                      aria-label={`New password for ${s.staff_id}`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button type="button" className="button small" onClick={() => setNewPassword(generatePassword())}>
                      Generate
                    </button>
                    <button type="submit" className="button small primary" disabled={busy}>
                      Save
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

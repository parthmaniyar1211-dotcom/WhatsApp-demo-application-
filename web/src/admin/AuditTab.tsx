import { loadAudit } from "../lib/adminApi";
import type { AuditEntry } from "../lib/types";
import { ErrorBlock } from "./OverviewTab";
import { useLoader, when } from "./useLoader";

const load = () => loadAudit(100);

export function AuditTab() {
  const { result, reload } = useLoader<AuditEntry[]>(load);
  if (result.state === "loading") return <p className="muted">Loading…</p>;
  if (result.state === "error") return <ErrorBlock message={result.message} onRetry={reload} />;
  return (
    <section aria-label="Audit log" data-testid="admin-audit">
      <p className="muted small">
        The last {result.data.length} administrative operations. Entries cannot be changed or deleted. They never contain passwords or tokens.{" "}
        <button type="button" className="link-button" onClick={reload}>
          Refresh
        </button>
      </p>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {result.data.map((a) => (
              <tr key={a.id}>
                <td>{when(a.created_at)}</td>
                <td>{a.actor_staff_id ?? "system"}</td>
                <td>
                  <code>{a.action}</code>
                </td>
                <td>{a.target ?? ""}</td>
              </tr>
            ))}
            {result.data.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Nothing recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

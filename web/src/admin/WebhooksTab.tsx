import { useState } from "react";
import { loadRoutingDiagnostics, replayQuarantine, type RoutingDiagnostics } from "../lib/adminApi";
import { errorMessage } from "../lib/format";
import { ErrorBlock } from "./OverviewTab";
import { useLoader, when } from "./useLoader";

/** Routing health of the shared WhatsApp webhook. Metadata only: no message text, no customer numbers. */
export function WebhooksTab() {
  const { result, reload } = useLoader<RoutingDiagnostics>(loadRoutingDiagnostics);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function replay(phoneNumberId: string) {
    setBusy(phoneNumberId);
    setNote(null);
    try {
      const r = await replayQuarantine(phoneNumberId);
      setNote(`Replayed ${r.replayed} of ${r.claimed}. Still unroutable: ${r.still_unroutable}. Failed: ${r.failed}.`);
      reload();
    } catch (err) {
      setNote(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (result.state === "loading") return <p className="muted">Loading…</p>;
  if (result.state === "error") return <ErrorBlock message={result.message} onRetry={reload} />;
  const d = result.data;
  return (
    <section aria-label="Webhook routing" data-testid="admin-webhooks">
      <p className="muted small">
        Events that could not be routed to a client are kept for {d.retention.quarantine_days} days, not discarded. Nothing here shows message text or customer numbers.{" "}
        <button type="button" className="link-button" onClick={reload}>
          Refresh
        </button>
      </p>
      {d.connections.legacy_unbound && (
        <p className="notice error" role="alert">
          The test number is not bound to its Phone Number ID yet. Check the WA_PHONE_ID secret.
        </p>
      )}
      <p>
        Waiting in quarantine: <strong>{d.quarantine.pending}</strong> · expiring within 24 hours: {d.quarantine.expiring_within_24h} · replayed in the last 24 hours: {d.quarantine.replayed_24h}
      </p>
      <p className="muted small">
        Connections without a Phone Number ID: {d.connections.without_phone_number_id} · connected but silent for 7 days: {d.connections.connected_without_webhook_7d}
      </p>
      <h3>Last 24 hours</h3>
      <p className="small">
        {Object.entries(d.outcomes_24h).map(([k, v]) => `${k}: ${v}`).join(" · ") || "No events."}
        {Object.keys(d.reasons_24h).length > 0 && <> — reasons: {Object.entries(d.reasons_24h).map(([k, v]) => `${k}: ${v}`).join(" · ")}</>}
      </p>
      {note && <p className="notice" role="status">{note}</p>}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Phone Number ID</th>
              <th>Events</th>
              <th>Waiting</th>
              <th>Last seen</th>
              <th>Reason</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.unrouted_phone_numbers.map((u) => (
              <tr key={u.phone_number_id ?? "none"}>
                <td>{u.phone_number_id ?? "(missing)"}</td>
                <td>{u.events}</td>
                <td>{u.pending}</td>
                <td>{when(u.last_seen)}</td>
                <td>{u.reasons.join(", ")}</td>
                <td>
                  {u.phone_number_id && u.pending > 0 && (
                    <button type="button" className="button" disabled={busy !== null} onClick={() => void replay(u.phone_number_id!)}>
                      {busy === u.phone_number_id ? "Replaying…" : "Replay"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {d.unrouted_phone_numbers.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No unrouted events in the last 7 days.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

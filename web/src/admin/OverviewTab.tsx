import { loadOverview } from "../lib/adminApi";
import type { AdminOverview } from "../lib/types";
import { useLoader, when } from "./useLoader";

export function OverviewTab() {
  const { result, reload } = useLoader<AdminOverview>(loadOverview);
  if (result.state === "loading") return <p className="muted">Loading…</p>;
  if (result.state === "error") return <ErrorBlock message={result.message} onRetry={reload} />;
  const o = result.data;
  const connected = o.connections.connected ?? 0;
  const problems = (o.connections.error ?? 0) + (o.connections.disconnected ?? 0) + (o.connections.revoked ?? 0);
  return (
    <section aria-label="Overview" data-testid="admin-overview">
      <div className="admin-tiles">
        <Tile label="Clients" value={`${o.tenants_active} active`} note={`${o.tenants} in total`} />
        <Tile label="Logins" value={`${o.staff_active} active`} note={`${o.staff_total} client logins`} />
        <Tile label="WhatsApp numbers" value={`${connected} connected`} note={problems ? `${problems} need attention` : "none need attention"} warn={problems > 0} />
        <Tile label="Messages, last 24 h" value={`${o.messages_24h.in} in · ${o.messages_24h.out} out`} note={`${o.messages_24h.failed} failed`} warn={o.messages_24h.failed > 0} />
        <Tile label="Tokens expiring within 7 days" value={String(o.tokens_expiring_7d)} note="Reconnect before they stop working" warn={o.tokens_expiring_7d > 0} />
        <Tile label="Unrouted webhook events, 24 h" value={String(o.unrouted_events_24h)} note="Events for numbers we do not know" warn={o.unrouted_events_24h > 0} />
      </div>
      <p className="muted small">
        Updated {when(o.generated_at)}.{" "}
        <button type="button" className="link-button" onClick={reload}>
          Refresh
        </button>
      </p>
    </section>
  );
}

function Tile({ label, value, note, warn }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <div className={`admin-tile ${warn ? "warn" : ""}`}>
      <span className="admin-tile-label">{label}</span>
      <strong className="admin-tile-value">{value}</strong>
      <span className="admin-tile-note">{note}</span>
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="notice error">
      {message}{" "}
      <button type="button" className="link-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

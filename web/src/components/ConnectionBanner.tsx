import type { WhatsAppConnection } from "../lib/types";

/**
 * Tells a client when their WhatsApp number cannot send or receive. It is an overlay, so the chat layout
 * does not move, and it only appears when something needs attention. No technical detail is shown to clients.
 */
export function ConnectionBanner({ connections, onRetry }: { connections: WhatsAppConnection[]; onRetry: () => void }) {
  if (connections.some((c) => c.status === "connected")) return null;
  const message = connections.length === 0
    ? "No WhatsApp number is connected to this account yet. Your administrator will set it up."
    : connections.some((c) => c.status === "pending")
    ? "Your WhatsApp number is being set up. You can add contacts now; sending starts when it is connected."
    : "Your WhatsApp number is disconnected. Messages cannot be sent or received. Contact your administrator.";
  return (
    <div className="connection-banner" role="status" data-testid="connection-banner">
      <span>{message}</span>
      <button type="button" className="link-button" onClick={onRetry}>
        Check again
      </button>
    </div>
  );
}

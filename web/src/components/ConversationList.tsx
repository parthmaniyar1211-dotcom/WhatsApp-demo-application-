import { useState } from "react";
import type { Inbox } from "../hooks/useInbox";
import type { Staff } from "../lib/types";
import { customerLabel, formatListTime, formatPhone } from "../lib/format";

interface Props {
  inbox: Inbox;
  me: Staff;
  openId: string | null;
  onOpen: (conversationId: string) => void;
}

export function ConversationList({ inbox, me, openId, onOpen }: Props) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const digits = query.replace(/[^0-9]/g, "");

  const visible = inbox.conversations.filter((c) => {
    if (!query) return true;
    if ((c.customer_name ?? "").toLowerCase().includes(query)) return true;
    return digits.length > 0 && c.wa_id.includes(digits);
  });

  return (
    <>
      <div className="search">
        <input
          type="search"
          placeholder="Search name or number"
          aria-label="Search conversations by name or number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {inbox.error && (
        <div className="notice error list-notice" role="alert">
          <span>Could not load conversations: {inbox.error}</span>
          <button className="button small" onClick={inbox.reload}>
            Retry
          </button>
        </div>
      )}

      {!inbox.loaded && !inbox.error ? (
        <div className="empty" role="status">
          <div className="spinner" />
          <p className="muted">Loading conversations…</p>
        </div>
      ) : inbox.loaded && inbox.conversations.length === 0 ? (
        <div className="empty">
          <p>No conversations yet.</p>
          <p className="muted small">When a customer messages the business number, the chat appears here by itself.</p>
        </div>
      ) : inbox.loaded && visible.length === 0 ? (
        <div className="empty">
          <p className="muted">No conversation matches “{search.trim()}”.</p>
        </div>
      ) : (
        <ul className="conversation-list" data-testid="conversation-list">
          {visible.map((c) => {
            const unread = c.id === openId ? 0 : (inbox.unread[c.id] ?? 0);
            const owner = c.assigned_to ? inbox.staff[c.assigned_to] : undefined;
            return (
              <li key={c.id}>
                <button
                  className={`conversation-item ${c.id === openId ? "selected" : ""} ${unread ? "unread" : ""}`}
                  onClick={() => onOpen(c.id)}
                  data-testid="conversation-item"
                  data-wa-id={c.wa_id}
                >
                  <span className="avatar" aria-hidden="true">
                    {customerLabel(c).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "#"}
                  </span>
                  <span className="conversation-main">
                    <span className="conversation-top">
                      <span className="conversation-name">{customerLabel(c)}</span>
                      <time className="conversation-time" dateTime={c.last_message_at}>
                        {formatListTime(c.last_message_at)}
                      </time>
                    </span>
                    <span className="conversation-bottom">
                      <span className="conversation-preview">{c.last_message_preview || formatPhone(c.wa_id)}</span>
                      {unread > 0 && (
                        <span className="badge" data-testid="unread-badge" aria-label={`${unread} unread`}>
                          {unread > 99 ? "99+" : unread}
                        </span>
                      )}
                    </span>
                    {c.assigned_to && (
                      <span className={`owner-tag ${c.assigned_to === me.user_id ? "mine" : ""}`}>
                        {c.assigned_to === me.user_id ? "You" : (owner?.staff_id ?? "Assigned")}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

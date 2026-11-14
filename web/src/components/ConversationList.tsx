import { useEffect, useState } from "react";
import type { Inbox } from "../hooks/useInbox";
import type { Message, Staff } from "../lib/types";
import { loadMessagesByIds, searchMessages } from "../lib/api";
import { customerLabel, formatListTime, formatPhone, messageSummary } from "../lib/format";
import { navigate } from "../hooks/useBrowserState";
import { Icon } from "./Icons";

interface Props {
  inbox: Inbox;
  me: Staff;
  openId: string | null;
}

/** Sidebar: chats (with search in names, numbers, labels and message text) or starred messages. */
export function ConversationList({ inbox, me, openId }: Props) {
  const [tab, setTab] = useState<"chats" | "starred">("chats");
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const digits = query.replace(/[^0-9]/g, "");
  const nameOf = (conversationId: string) => {
    const conversation = inbox.conversations.find((c) => c.id === conversationId);
    return conversation ? customerLabel(conversation) : "Customer";
  };

  const visible = inbox.conversations.filter((c) => {
    if (!query) return true;
    if ((c.customer_name ?? "").toLowerCase().includes(query)) return true;
    if (c.labels.some((label) => label.toLowerCase().includes(query))) return true;
    return digits.length > 0 && c.wa_id.includes(digits);
  });

  // Message text search across all chats (server side, debounced).
  const [found, setFound] = useState<{ query: string; rows: Message[] } | null>(null);
  useEffect(() => {
    if (tab !== "chats" || query.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMessages(query).then(
        (rows) => !cancelled && setFound({ query, rows }),
        () => !cancelled && setFound({ query, rows: [] }),
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, tab]);
  const messageResults = query.length >= 2 && found?.query === query ? found.rows : null;

  // Starred messages (all chats).
  const starredKey = Object.entries(inbox.flags)
    .filter(([, flag]) => flag.starred)
    .map(([id]) => id)
    .join(",");
  const [starred, setStarred] = useState<{ key: string; rows: Message[] } | null>(null);
  useEffect(() => {
    if (tab !== "starred") return;
    let cancelled = false;
    loadMessagesByIds(starredKey ? starredKey.split(",") : []).then(
      (rows) => !cancelled && setStarred({ key: starredKey, rows }),
      () => !cancelled && setStarred({ key: starredKey, rows: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [starredKey, tab]);

  const messageButton = (message: Message, testId: string) => (
    <li key={message.id}>
      <button
        type="button"
        className="conversation-item result"
        data-testid={testId}
        onClick={() => navigate(`#/c/${message.conversation_id}/m/${message.id}`)}
      >
        <span className="conversation-main">
          <span className="conversation-top">
            <span className="conversation-name">{nameOf(message.conversation_id)}</span>
            <time className="conversation-time">{formatListTime(message.created_at)}</time>
          </span>
          <span className="conversation-preview">
            {message.direction === "out" ? `${message.sent_by_staff_id ?? "Staff"}: ` : ""}
            {messageSummary(message)}
          </span>
        </span>
      </button>
    </li>
  );

  return (
    <>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "chats"} className={tab === "chats" ? "active" : ""} onClick={() => setTab("chats")}>
          Chats
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "starred"}
          className={tab === "starred" ? "active" : ""}
          onClick={() => setTab("starred")}
          data-testid="starred-tab"
        >
          <Icon name="starFilled" size={14} /> Starred
        </button>
      </div>

      {tab === "starred" ? (
        starred?.key !== starredKey ? (
          <div className="empty" role="status">
            <div className="spinner" />
          </div>
        ) : starred.rows.length === 0 ? (
          <div className="empty">
            <p>No starred messages.</p>
            <p className="muted small">Open a message’s menu and choose Star. Stars are private to you.</p>
          </div>
        ) : (
          <ul className="conversation-list" data-testid="starred-list">
            {starred.rows.map((message) => messageButton(message, "starred-item"))}
          </ul>
        )
      ) : (
        <>
          <div className="search">
            <input
              type="search"
              placeholder="Search chats and messages"
              aria-label="Search chats and messages"
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
          ) : inbox.loaded && visible.length === 0 && (messageResults?.length ?? 0) === 0 ? (
            <div className="empty">
              <p className="muted">
                {messageResults === null && query.length >= 2 ? "Searching…" : `No chat or message matches “${search.trim()}”.`}
              </p>
            </div>
          ) : (
            <ul className="conversation-list" data-testid="conversation-list">
              {query && visible.length > 0 && <li className="list-heading">Chats</li>}
              {visible.map((c) => {
                const unread = c.id === openId ? 0 : (inbox.unread[c.id] ?? 0);
                const owner = c.assigned_to ? inbox.staff[c.assigned_to] : undefined;
                return (
                  <li key={c.id}>
                    <button
                      className={`conversation-item ${c.id === openId ? "selected" : ""} ${unread ? "unread" : ""}`}
                      onClick={() => navigate(`#/c/${c.id}`)}
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
                        {(c.assigned_to || c.labels.length > 0) && (
                          <span className="tag-row">
                            {c.assigned_to && (
                              <span className={`owner-tag ${c.assigned_to === me.user_id ? "mine" : ""}`}>
                                {c.assigned_to === me.user_id ? "You" : (owner?.staff_id ?? "Assigned")}
                              </span>
                            )}
                            {c.labels.map((label) => (
                              <span className="label small" key={label}>
                                {label}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
              {messageResults && messageResults.length > 0 && <li className="list-heading">Messages</li>}
              {messageResults?.map((message) => messageButton(message, "message-result"))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

import { useEffect, useState } from "react";
import type { Inbox } from "../hooks/useInbox";
import type { Message } from "../lib/types";
import { loadMessagesByIds, searchMessages } from "../lib/api";
import { customerLabel, formatListTime, formatPhone, messageSummary, previewText } from "../lib/format";
import { navigate } from "../hooks/useBrowserState";
import { Avatar } from "./Avatar";
import { Icon } from "./Icons";

interface Props {
  inbox: Inbox;
  openId: string | null;
  onNewChat: () => void;
  menu: React.ReactNode;
}

type Filter = "all" | "unread" | "starred";

/** Left column: title, new chat, menu, search, filter chips and the chat list. */
export function ConversationList({ inbox, openId, onNewChat, menu }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const digits = query.replace(/[^0-9]/g, "");
  const looksLikeNumber = /^[\d\s+()-]+$/.test(query);
  const nameOf = (conversationId: string) => {
    const conversation = inbox.conversations.find((c) => c.id === conversationId);
    return conversation ? customerLabel(conversation) : "Chat";
  };

  const visible = inbox.conversations.filter((c) => {
    if (filter === "unread" && !(inbox.unread[c.id] > 0)) return false;
    if (!query) return true;
    if (customerLabel(c).toLowerCase().includes(query)) return true;
    // Only a query that looks like a phone number (digits, +, spaces, dashes) matches numbers.
    return looksLikeNumber && digits.length > 0 && c.wa_id.includes(digits);
  });

  // Message text search across all chats (server side, debounced).
  const [found, setFound] = useState<{ query: string; rows: Message[] } | null>(null);
  useEffect(() => {
    if (filter === "starred" || query.length < 2) return;
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
  }, [query, filter]);
  const messageResults = query.length >= 2 && found?.query === query ? found.rows : null;

  // Starred messages (all chats).
  const starredKey = Object.entries(inbox.flags)
    .filter(([, flag]) => flag.starred && !flag.hidden)
    .map(([id]) => id)
    .join(",");
  const [starred, setStarred] = useState<{ key: string; rows: Message[] } | null>(null);
  useEffect(() => {
    if (filter !== "starred") return;
    let cancelled = false;
    loadMessagesByIds(starredKey ? starredKey.split(",") : []).then(
      (rows) => !cancelled && setStarred({ key: starredKey, rows }),
      () => !cancelled && setStarred({ key: starredKey, rows: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [starredKey, filter]);

  // The chat-list line is derived per user from the newest message THEY have not deleted,
  // so a deleted message never shows up as a preview.
  const previewFor = (c: Inbox["conversations"][number]): { text: string; time: string; deleted: boolean } => {
    // A chat that just changed shows the server's preview (its newest message is new, so it cannot be one that was
    // deleted) until the per-user preview has been refreshed.
    if (inbox.previewDirty.has(c.id)) return { text: c.last_message_preview || formatPhone(c.wa_id), time: c.last_message_at, deleted: false };
    const visibleLast = inbox.previews?.[c.id];
    if (visibleLast) return { text: previewText(visibleLast), time: visibleLast.created_at, deleted: false };
    if (inbox.previews && c.last_message_preview) return { text: "You deleted all messages", time: c.last_message_at, deleted: true };
    return { text: c.last_message_preview || formatPhone(c.wa_id), time: c.last_message_at, deleted: false };
  };

  const messageRow = (message: Message, testId: string) => {
    const conversation = inbox.conversations.find((c) => c.id === message.conversation_id);
    return (
      <li key={message.id}>
        <button
          type="button"
          className="chat-item"
          data-testid={testId}
          onClick={() => navigate(`#/c/${message.conversation_id}/m/${message.id}`)}
        >
          <Avatar name={nameOf(message.conversation_id)} seed={conversation?.wa_id} />
          <span className="chat-main">
            <span className="chat-top">
              <span className="chat-name">{nameOf(message.conversation_id)}</span>
              <time className="chat-time">{formatListTime(message.created_at)}</time>
            </span>
            <span className="chat-preview">
              {message.direction === "out" ? "You: " : ""}
              {messageSummary(message)}
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <>
      <header className="list-header">
        <h1>Chats</h1>
        <span className="spacer" />
        <button type="button" className="round-button" onClick={onNewChat} aria-label="New chat" title="New chat" data-testid="new-chat-button">
          <Icon name="newchat" size={22} />
        </button>
        {menu}
      </header>

      <div className="search">
        <label className="search-box">
          <Icon name="search" size={18} />
          <input
            type="search"
            placeholder="Search or start a new chat"
            aria-label="Search chats and messages"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      <div className="chips" role="tablist">
        {(["all", "unread", "starred"] as Filter[]).map((value) => (
          <button
            type="button"
            role="tab"
            key={value}
            aria-selected={filter === value}
            className={`chip-button ${filter === value ? "active" : ""}`}
            onClick={() => setFilter(value)}
            data-testid={`filter-${value}`}
          >
            {value === "all" ? "All" : value === "unread" ? "Unread" : "Starred"}
          </button>
        ))}
      </div>

      {filter === "starred" ? (
        starred?.key !== starredKey ? (
          <div className="empty" role="status">
            <div className="spinner" />
          </div>
        ) : starred.rows.length === 0 ? (
          <div className="empty">
            <p>No starred messages</p>
            <p className="muted small">Open a message’s menu and choose Star.</p>
          </div>
        ) : (
          <ul className="chat-list" data-testid="starred-list">
            {starred.rows.map((message) => messageRow(message, "starred-item"))}
          </ul>
        )
      ) : (
        <>
          {inbox.error && (
            <div className="notice error list-notice" role="alert">
              <span>Could not load chats: {inbox.error}</span>
              <button className="button small" onClick={inbox.reload}>
                Retry
              </button>
            </div>
          )}

          {!inbox.loaded && !inbox.error ? (
            <div className="empty" role="status">
              <div className="spinner" />
              <p className="muted">Loading chats…</p>
            </div>
          ) : inbox.loaded && inbox.conversations.length === 0 ? (
            <div className="empty">
              <p>No chats yet</p>
              <p className="muted small">Start one with the new chat button, or wait for a customer to message you.</p>
              <button type="button" className="button primary" onClick={onNewChat}>
                New chat
              </button>
            </div>
          ) : inbox.loaded && visible.length === 0 && (messageResults?.length ?? 0) === 0 ? (
            <div className="empty">
              {filter === "unread" && !query ? (
                <p className="muted">No unread chats</p>
              ) : (
                <>
                  <p className="muted">
                    {messageResults === null && query.length >= 2 ? "Searching…" : `No chat or message matches “${search.trim()}”.`}
                  </p>
                  {digits.length >= 7 && (
                    <button type="button" className="button" onClick={onNewChat}>
                      Start a chat with +{digits}
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <ul className="chat-list" data-testid="conversation-list">
              {query && visible.length > 0 && <li className="list-heading">Chats</li>}
              {visible.map((c) => {
                const unread = c.id === openId ? 0 : (inbox.unread[c.id] ?? 0);
                const preview = previewFor(c);
                return (
                  <li key={c.id}>
                    <button
                      className={`chat-item ${c.id === openId ? "selected" : ""} ${unread ? "unread" : ""}`}
                      onClick={() => navigate(`#/c/${c.id}`)}
                      data-testid="conversation-item"
                      data-wa-id={c.wa_id}
                    >
                      <Avatar name={customerLabel(c)} seed={c.wa_id} />
                      <span className="chat-main">
                        <span className="chat-top">
                          <span className="chat-name">{customerLabel(c)}</span>
                          <time className="chat-time" dateTime={preview.time}>
                            {formatListTime(preview.time)}
                          </time>
                        </span>
                        <span className="chat-bottom">
                          <span className={`chat-preview ${preview.deleted ? "deleted" : ""}`} data-testid="chat-preview">
                            {preview.text}
                          </span>
                          {unread > 0 && (
                            <span className="badge" data-testid="unread-badge" aria-label={`${unread} unread`}>
                              {unread > 99 ? "99+" : unread}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {messageResults && messageResults.length > 0 && <li className="list-heading">Messages</li>}
              {messageResults?.map((message) => messageRow(message, "message-result"))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

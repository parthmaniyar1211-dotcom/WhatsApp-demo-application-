import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Conversation, Message, QuickReply, Staff } from "../lib/types";
import { Avatar } from "./Avatar";
import { markReadAtWhatsApp, searchMessages, sendReaction } from "../lib/api";
import {
  customerLabel,
  dayKey,
  errorMessage,
  formatDay,
  formatListTime,
  formatPhone,
  formatRemaining,
  isWindowOpen,
  messageSummary,
} from "../lib/format";
import { useMessages } from "../hooks/useMessages";
import type { Flags } from "../hooks/useInbox";
import { useNow, useVisible } from "../hooks/useBrowserState";
import { Lightbox, MessageBubble } from "./MessageBubble";
import { Composer, type ComposerHandle } from "./Composer";
import { InfoPanel } from "./InfoPanel";
import { Icon } from "./Icons";

interface Props {
  conversation: Conversation;
  me: Staff;
  flags: Flags;
  setFlag: (messageId: string, patch: Partial<{ starred: boolean; hidden: boolean }>) => Promise<void>;
  quickReplies: QuickReply[];
  onManageQuickReplies: () => void;
  /** Unread messages at the moment the chat was opened (for the "unread" divider). */
  initialUnread: number;
  /** Message to jump to (from search or the starred list). */
  focusMessageId: string | null;
}

const GROUP_GAP_MS = 5 * 60 * 1000;

export function ConversationPane(props: Props) {
  const { conversation, me, flags, setFlag } = props;
  const stream = useMessages(conversation.id);
  const now = useNow(30_000);
  const visible = useVisible();
  const windowOpen = isWindowOpen(conversation.last_inbound_at, now);
  const name = customerLabel(conversation);

  // Messages deleted for me are only hidden in this view.
  const messages = useMemo(() => stream.messages.filter((m) => !flags[m.id]?.hidden), [stream.messages, flags]);
  const byWaId = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of stream.messages) if (m.wa_message_id) map.set(m.wa_message_id, m);
    return map;
  }, [stream.messages]);

  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [highlight, setHighlight] = useState<{ id: string } | null>(null); // a new object per jump
  const highlighted = highlight?.id ?? null;
  const composer = useRef<ComposerHandle>(null);

  // --- "Unread messages" divider: decided once, when the chat is first shown.
  const [initialUnread] = useState(props.initialUnread);
  const [dividerBefore, setDividerBefore] = useState<string | null | undefined>(undefined);
  if (dividerBefore === undefined && stream.loaded) {
    const incoming = messages.filter((m) => m.direction === "in");
    setDividerBefore(initialUnread > 0 ? (incoming[Math.max(incoming.length - initialUnread, 0)]?.id ?? null) : null);
  }

  // --- Scrolling: stay at the bottom unless the user scrolled up to read history.
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previousHeight = useRef(0);
  const firstScroll = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [anchorId, setAnchorId] = useState<string | null>(null); // last message seen at the bottom
  const lastId = messages[messages.length - 1]?.id ?? null;
  const firstId = messages[0]?.id;

  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stream.loaded) return;
    if (firstScroll.current) {
      firstScroll.current = false;
      const divider = el.querySelector<HTMLElement>("[data-unread-divider]");
      if (divider) {
        // Open at the first unread message, like WhatsApp.
        el.scrollTop = Math.max(divider.offsetTop - 80, 0);
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        return;
      }
    }
    scrollToBottom();
  }, [lastId, stream.loaded, scrollToBottom]);

  useEffect(() => {
    // The list got smaller or taller (banner, attachment row, phone keyboard): stay at the bottom.
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    // Earlier messages were added on top: keep the same message under the user's eyes.
    const el = scroller.current;
    if (el && !stickToBottom.current && previousHeight.current) {
      el.scrollTop += el.scrollHeight - previousHeight.current;
    }
    previousHeight.current = 0;
  }, [firstId]);

  function onScroll(el: HTMLDivElement) {
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottom.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    // Remember the newest message the user has seen, to count what arrives after it.
    if ((bottom || anchorId === null) && lastId !== anchorId) setAnchorId(lastId);
    // Infinite scroll: near the top, fetch the previous page.
    if (el.scrollTop < 200 && stream.hasEarlier && !stream.loadingEarlier) loadEarlier();
  }

  function loadEarlier() {
    previousHeight.current = scroller.current?.scrollHeight ?? 0;
    stream.loadEarlier();
  }

  // New customer messages that arrived below while the user was reading older ones.
  const anchorIndex = anchorId ? messages.findIndex((m) => m.id === anchorId) : -1;
  const newBelow = atBottom || anchorIndex < 0
    ? 0
    : messages.slice(anchorIndex + 1).filter((m) => m.direction === "in").length;

  function goToLatest() {
    stickToBottom.current = true;
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  // --- Jump to a message (search result, starred message, quoted message)
  const { ensureLoaded } = stream;
  const jumpTo = useCallback(
    async (messageId: string) => {
      const found = await ensureLoaded(messageId);
      if (!found) {
        setNotice({ text: "That message could not be found." });
        return;
      }
      stickToBottom.current = false;
      setHighlight({ id: messageId });
    },
    [ensureLoaded],
  );
  useEffect(() => {
    if (!highlight) return;
    const element = scroller.current?.querySelector(`[data-message-id="${highlight.id}"]`);
    element?.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(timer);
  }, [highlight, messages.length]);

  const { focusMessageId } = props;
  useEffect(() => {
    if (!focusMessageId || !stream.loaded) return;
    const timer = setTimeout(() => void jumpTo(focusMessageId), 0);
    return () => clearTimeout(timer);
  }, [focusMessageId, stream.loaded, jumpTo]);

  // --- Tell WhatsApp the customer's messages were read (blue ticks on their phone).
  const lastIncomingId = [...stream.messages].reverse().find((m) => m.direction === "in")?.id;
  useEffect(() => {
    if (visible && lastIncomingId) void markReadAtWhatsApp(conversation.id);
  }, [visible, lastIncomingId, conversation.id]);

  // --- Search inside this chat
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; rows: Message[] } | null>(null);
  useEffect(() => {
    const text = query.trim();
    if (!searchOpen || text.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMessages(text, conversation.id).then(
        (rows) => !cancelled && setResults({ query: text, rows }),
        () => !cancelled && setResults({ query: text, rows: [] }),
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, searchOpen, conversation.id]);
  const shownResults = searchOpen && results && results.query === query.trim() ? results.rows : null;

  // --- Message actions
  const actions = {
    onReply: (message: Message) => setReplyTo(message),
    onReact: (message: Message, emoji: string) => {
      sendReaction(conversation.id, message.id, emoji).then(stream.upsert, (err) =>
        setNotice({ text: `Reaction not sent: ${errorMessage(err)}` }),
      );
    },
    onToggleStar: (message: Message) => {
      setFlag(message.id, { starred: !flags[message.id]?.starred }).catch((err) => setNotice({ text: errorMessage(err) }));
    },
    onHide: (message: Message) => {
      setFlag(message.id, { hidden: true }).then(
        () =>
          setNotice({
            text: "Deleted for you only. WhatsApp does not delete it for the other person.",
            undo: () => {
              void setFlag(message.id, { hidden: false });
              setNotice(null);
            },
          }),
        (err) => setNotice({ text: errorMessage(err) }),
      );
    },
    onJumpToQuoted: (waMessageId: string) => {
      const target = byWaId.get(waMessageId);
      if (target) void jumpTo(target.id);
    },
    onOpenImage: setLightbox,
    onMediaLoad: scrollToBottom,
  };

  // --- Drag and drop a file onto the chat
  const [dragging, setDragging] = useState(false);
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

  return (
    <div className="conversation-layout">
      <div
        className={`conversation ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          if (!hasFiles(e) || !windowOpen) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e) || !windowOpen) return;
          e.preventDefault();
          setDragging(false);
          const dropped = e.dataTransfer.files[0];
          if (dropped) composer.current?.attach(dropped);
        }}
      >
        <header className="conversation-header">
          <a className="back" href="#/" aria-label="Back to chats">
            <Icon name="back" size={26} />
          </a>
          <button type="button" className="conversation-title" onClick={() => setInfoOpen((open) => !open)} title="Contact info">
            <Avatar name={name} seed={conversation.wa_id} size={40} />
            <span className="title-text">
              <h2 data-testid="conversation-title">{name}</h2>
              <p className="muted small">{formatPhone(conversation.wa_id)}</p>
            </span>
          </button>
          <button
            type="button"
            className={`round-button ${searchOpen ? "active" : ""}`}
            onClick={() => {
              setSearchOpen((open) => !open);
              setQuery("");
            }}
            aria-label="Search in this chat"
            aria-expanded={searchOpen}
            data-testid="chat-search-button"
          >
            <Icon name="search" size={20} />
          </button>
          <button
            type="button"
            className={`round-button ${infoOpen ? "active" : ""}`}
            onClick={() => setInfoOpen((open) => !open)}
            aria-label="Contact info"
            aria-expanded={infoOpen}
            data-testid="info-button"
          >
            <Icon name="info" size={20} />
          </button>
        </header>

        {searchOpen && (
          <div className="chat-search" data-testid="chat-search">
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search in this chat"
              aria-label="Search in this chat"
            />
            {query.trim().length >= 2 && (
              <ul className="search-results">
                {shownResults === null && <li className="muted small">Searching…</li>}
                {shownResults?.length === 0 && <li className="muted small">No message contains “{query.trim()}”.</li>}
                {shownResults?.map((message) => (
                  <li key={message.id}>
                    <button
                      type="button"
                      data-testid="chat-search-result"
                      onClick={() => {
                        setSearchOpen(false);
                        void jumpTo(message.id);
                      }}
                    >
                      <span className="result-text">
                        <strong>{message.direction === "out" ? "You" : name}:</strong>{" "}
                        {messageSummary(message)}
                      </span>
                      <time className="muted small">{formatListTime(message.created_at)}</time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {notice && (
          <div className="banner info" role="status" data-testid="chat-notice">
            <span>{notice.text}</span>
            {notice.undo && (
              <button type="button" className="button small" onClick={notice.undo}>
                Undo
              </button>
            )}
            <button type="button" className="button icon small" onClick={() => setNotice(null)} aria-label="Dismiss">
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {stream.loaded && stream.live === "reconnecting" && (
          <div className="banner warning" role="status">
            Reconnecting… new messages will appear when the connection is back.
          </div>
        )}

        <div className="messages-wrap">
          <div className="messages" ref={scroller} data-testid="messages" onScroll={(e) => onScroll(e.currentTarget)}>
            {stream.error && (
              <div className="notice error" role="alert">
                <span>Could not load messages: {stream.error}</span>
                <button className="button small" onClick={stream.reload}>
                  Retry
                </button>
              </div>
            )}
            {!stream.loaded && !stream.error && (
              <div className="empty" role="status">
                <div className="spinner" />
                <p className="muted">Loading messages…</p>
              </div>
            )}
            {stream.loaded && messages.length === 0 && (
              <div className="empty">
                <p className="muted">No messages in this conversation yet.</p>
              </div>
            )}
            {stream.hasEarlier && (
              <button className="button small load-earlier" disabled={stream.loadingEarlier} onClick={loadEarlier} data-testid="load-earlier">
                {stream.loadingEarlier ? "Loading earlier messages…" : "Load earlier messages"}
              </button>
            )}
            {stream.loaded && !stream.hasEarlier && messages.length > 0 && (
              <p className="history-start">Start of the conversation</p>
            )}
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const showDay = !previous || dayKey(previous.created_at) !== dayKey(message.created_at);
              const showUnread = dividerBefore === message.id;
              const grouped =
                Boolean(previous) &&
                !showDay &&
                !showUnread &&
                previous.direction === message.direction &&
                previous.sent_by_staff_id === message.sent_by_staff_id &&
                new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < GROUP_GAP_MS;
              return (
                <div key={message.id} className="message-row-wrap">
                  {showDay && <div className="day-divider">{formatDay(message.created_at)}</div>}
                  {showUnread && (
                    <div className="unread-divider" data-unread-divider data-testid="unread-divider">
                      {initialUnread} unread message{initialUnread === 1 ? "" : "s"}
                    </div>
                  )}
                  <MessageBubble
                    message={message}
                    grouped={grouped}
                    customerName={name}
                    quoted={
                      message.reply_to_wa_message_id ? (byWaId.get(message.reply_to_wa_message_id) ?? null) : undefined
                    }
                    starred={Boolean(flags[message.id]?.starred)}
                    highlighted={highlighted === message.id}
                    windowOpen={windowOpen}
                    {...actions}
                  />
                </div>
              );
            })}
          </div>

          {!atBottom && (
            <button type="button" className="scroll-latest" onClick={goToLatest} aria-label="Scroll to latest message" data-testid="scroll-latest">
              {newBelow > 0 && <span className="badge">{newBelow}</span>}
              <Icon name="down" size={22} />
            </button>
          )}
          {dragging && <div className="drop-overlay">Drop the file to attach it</div>}
        </div>

        {windowOpen ? (
          conversation.last_inbound_at && (
            <div className="window-note" data-testid="window-open">
              You can reply freely for another {formatRemaining(conversation.last_inbound_at, now)} left
            </div>
          )
        ) : (
          <div className="banner closed" role="status" data-testid="window-closed">
            <strong>Send a template message to start.</strong>{" "}
            {conversation.last_inbound_at
              ? "This person last wrote more than 24 hours ago."
              : "This person has not written to you yet."}{" "}
            WhatsApp only allows an approved template message until they reply. Then you can type freely for 24 hours.
          </div>
        )}

        <Composer
          ref={composer}
          conversationId={conversation.id}
          userId={me.user_id}
          windowOpen={windowOpen}
          customerName={name}
          quickReplies={props.quickReplies}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onManageQuickReplies={props.onManageQuickReplies}
          onSent={(message) => {
            stickToBottom.current = true;
            stream.upsert(message);
          }}
        />
      </div>

      {infoOpen && (
        <InfoPanel
          conversation={conversation}
          flags={flags}
          messages={stream.messages}
          onClose={() => setInfoOpen(false)}
          onJump={(id) => {
            if (window.matchMedia("(max-width: 1099px)").matches) setInfoOpen(false);
            void jumpTo(id);
          }}
          onUnhide={(ids) => ids.forEach((id) => void setFlag(id, { hidden: false }))}
        />
      )}
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

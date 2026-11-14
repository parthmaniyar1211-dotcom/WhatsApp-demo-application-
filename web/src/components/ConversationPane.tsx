import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Conversation, Staff } from "../lib/types";
import { customerLabel, dayKey, errorMessage, formatDay, formatPhone, formatRemaining, isWindowOpen } from "../lib/format";
import { useMessages } from "../hooks/useMessages";
import { useNow } from "../hooks/useBrowserState";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";

interface Props {
  conversation: Conversation;
  me: Staff;
  staff: Record<string, Staff>;
}

export function ConversationPane({ conversation, me, staff }: Props) {
  const stream = useMessages(conversation.id);
  const now = useNow(30_000);
  const windowOpen = isWindowOpen(conversation.last_inbound_at, now);

  // --- Scrolling: stay at the bottom unless the user scrolled up to read history.
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previousHeight = useRef(0);
  const scrollToBottom = () => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  };
  const lastId = stream.messages[stream.messages.length - 1]?.id;
  const firstId = stream.messages[0]?.id;
  useLayoutEffect(() => {
    scrollToBottom();
  }, [lastId, stream.loaded]);
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

  // --- Take / release chat
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const owner = conversation.assigned_to ? staff[conversation.assigned_to] : undefined;
  const mine = conversation.assigned_to === me.user_id;

  async function changeOwner(action: "take_conversation" | "release_conversation") {
    setOwnerBusy(true);
    setOwnerError(null);
    const { error } = await supabase.rpc(action, { p_conversation_id: conversation.id });
    setOwnerBusy(false);
    if (error) setOwnerError(errorMessage(error));
    // The new owner arrives through Realtime for everyone, including this user.
  }

  return (
    <div className="conversation">
      <header className="conversation-header">
        <a className="back" href="#/" aria-label="Back to inbox">
          ‹
        </a>
        <div className="conversation-title">
          <h2 data-testid="conversation-title">{customerLabel(conversation)}</h2>
          <p className="muted small">{formatPhone(conversation.wa_id)}</p>
        </div>
        <div className="owner" data-testid="owner">
          {conversation.assigned_to ? (
            <span className={`owner-tag ${mine ? "mine" : ""}`}>
              Owner: {mine ? `You (${me.staff_id})` : (owner?.staff_id ?? "another staff member")}
            </span>
          ) : (
            <span className="owner-tag none">Unassigned</span>
          )}
          {mine ? (
            <button className="button small" disabled={ownerBusy} onClick={() => void changeOwner("release_conversation")}>
              Release
            </button>
          ) : (
            <button
              className="button small primary"
              disabled={ownerBusy}
              onClick={() => void changeOwner("take_conversation")}
            >
              {conversation.assigned_to ? "Take over" : "Take chat"}
            </button>
          )}
          {conversation.assigned_to && !mine && me.role === "admin" && (
            <button className="button small" disabled={ownerBusy} onClick={() => void changeOwner("release_conversation")}>
              Release
            </button>
          )}
        </div>
      </header>

      {ownerError && (
        <div className="banner error" role="alert">
          Could not change the owner: {ownerError}
        </div>
      )}
      {stream.loaded && stream.live === "reconnecting" && (
        <div className="banner warning" role="status">
          Reconnecting… new messages will appear when the connection is back.
        </div>
      )}

      <div
        className="messages"
        ref={scroller}
        data-testid="messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
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
        {stream.loaded && stream.messages.length === 0 && (
          <div className="empty">
            <p className="muted">No messages in this conversation yet.</p>
          </div>
        )}
        {stream.hasEarlier && (
          <button
            className="button small load-earlier"
            disabled={stream.loadingEarlier}
            onClick={() => {
              previousHeight.current = scroller.current?.scrollHeight ?? 0;
              stream.loadEarlier();
            }}
          >
            {stream.loadingEarlier ? "Loading…" : "Load earlier messages"}
          </button>
        )}
        {stream.messages.map((message, index) => {
          const previous = stream.messages[index - 1];
          const showDay = !previous || dayKey(previous.created_at) !== dayKey(message.created_at);
          return (
            <div key={message.id} className="message-row-wrap">
              {showDay && <div className="day-divider">{formatDay(message.created_at)}</div>}
              <MessageBubble message={message} onMediaLoad={scrollToBottom} />
            </div>
          );
        })}
      </div>

      {windowOpen ? (
        conversation.last_inbound_at && (
          <div className="window-note" data-testid="window-open">
            Reply window open: {formatRemaining(conversation.last_inbound_at, now)} left
          </div>
        )
      ) : (
        <div className="banner closed" role="status" data-testid="window-closed">
          <strong>24-hour window closed.</strong>{" "}
          {conversation.last_inbound_at
            ? "The customer last wrote more than 24 hours ago."
            : "The customer has not written yet."}{" "}
          WhatsApp only allows an approved template message until the customer replies.
        </div>
      )}

      <Composer
        conversationId={conversation.id}
        userId={me.user_id}
        windowOpen={windowOpen}
        onSent={(message) => {
          stickToBottom.current = true;
          stream.upsert(message);
        }}
      />
    </div>
  );
}

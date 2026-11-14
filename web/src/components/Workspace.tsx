import { useEffect } from "react";
import { supabase } from "../lib/supabase";
import type { Staff } from "../lib/types";
import { useInbox } from "../hooks/useInbox";
import { navigate, useOnline, useRoute, useVisible } from "../hooks/useBrowserState";
import { ConversationList } from "./ConversationList";
import { ConversationPane } from "./ConversationPane";
import { AdminPage } from "./AdminPage";

/** The signed-in app: header, conversation list, open conversation or admin page. */
export function Workspace({ me }: { me: Staff }) {
  const route = useRoute();
  const online = useOnline();
  const visible = useVisible();
  const inbox = useInbox(me.user_id);

  const isAdminPage = route.page === "admin" && me.role === "admin";
  const openId = route.page === "inbox" ? route.conversationId : null;
  const openConversation = openId ? inbox.conversations.find((c) => c.id === openId) : undefined;
  const openUnread = openId ? (inbox.unread[openId] ?? 0) : 0;

  // Reading a chat (tab in the foreground) marks it as read for this user.
  const { markRead } = inbox;
  useEffect(() => {
    if (openId && openConversation && visible && openUnread > 0) markRead(openId);
  }, [openId, openConversation, visible, openUnread, markRead]);

  const totalUnread = Object.entries(inbox.unread).reduce((sum, [id, n]) => sum + (id === openId ? 0 : n), 0);
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Shared Inbox` : "Shared Inbox";
  }, [totalUnread]);

  const detailOpen = isAdminPage || Boolean(openId);

  return (
    <div className={`app ${detailOpen ? "detail-open" : ""}`}>
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Inbox">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Shared Inbox</span>
        </a>
        <span
          className={`live-pill ${!online ? "offline" : inbox.live}`}
          role="status"
          data-testid="live-status"
          title="Realtime connection"
        >
          {!online ? "Offline" : inbox.live === "live" ? "Live" : inbox.live === "connecting" ? "Connecting…" : "Reconnecting…"}
        </span>
        <span className="spacer" />
        {me.role === "admin" && (
          <a className={`button small ${isAdminPage ? "active" : ""}`} href={isAdminPage ? "#/" : "#/admin"}>
            {isAdminPage ? "Inbox" : "Admin"}
          </a>
        )}
        <span className="me" title={me.display_name || me.staff_id} data-testid="me">
          {me.staff_id}
        </span>
        <button className="button small" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      {!online && (
        <div className="banner warning" role="status">
          You are offline. Messages will appear again when the connection is back.
        </div>
      )}

      <div className="panes">
        <aside className="sidebar" aria-label="Conversations">
          <ConversationList inbox={inbox} me={me} openId={openId} onOpen={(id) => navigate(`#/c/${id}`)} />
        </aside>
        <section className="detail">
          {isAdminPage ? (
            <AdminPage me={me} staff={Object.values(inbox.staff)} onChanged={inbox.reload} />
          ) : openId && openConversation ? (
            <ConversationPane key={openId} conversation={openConversation} me={me} staff={inbox.staff} />
          ) : openId && inbox.loaded ? (
            <div className="empty">
              <p>This conversation does not exist any more.</p>
              <a className="button" href="#/">
                Back to inbox
              </a>
            </div>
          ) : openId ? (
            <div className="empty" role="status">
              <div className="spinner" />
            </div>
          ) : (
            <div className="empty">
              <span className="brand-mark large" aria-hidden="true" />
              <p>Select a conversation to read and reply.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

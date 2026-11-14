import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { QuickReply, Staff } from "../lib/types";
import { loadQuickReplies } from "../lib/api";
import { notificationPermission, playSound, requestNotificationPermission } from "../lib/notify";
import { type Settings, updateSettings, useSettings } from "../lib/settings";
import { useInbox } from "../hooks/useInbox";
import { navigate, useOnline, useRoute, useVisible } from "../hooks/useBrowserState";
import { ConversationList } from "./ConversationList";
import { ConversationPane } from "./ConversationPane";
import { AdminPage } from "./AdminPage";
import { QuickRepliesDialog } from "./QuickRepliesDialog";
import { Icon } from "./Icons";

/** The signed-in app: header, conversation list, open conversation or admin page. */
export function Workspace({ me }: { me: Staff }) {
  const route = useRoute();
  const online = useOnline();
  const visible = useVisible();
  const openId = route.page === "inbox" ? route.conversationId : null;
  const openConversationById = useCallback((id: string) => navigate(`#/c/${id}`), []);
  const inbox = useInbox(me.user_id, openId, openConversationById);

  const isAdminPage = route.page === "admin" && me.role === "admin";
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

  // Quick replies are shared by all staff; reloaded after the dialog changes them.
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [quickDialog, setQuickDialog] = useState(false);
  const reloadQuickReplies = useCallback(() => {
    loadQuickReplies().then(setQuickReplies, () => {});
  }, []);
  useEffect(reloadQuickReplies, [reloadQuickReplies]);

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
        <span className="me" title={me.display_name || me.staff_id} data-testid="me">
          {me.staff_id}
        </span>
        <SettingsMenu me={me} isAdminPage={isAdminPage} onQuickReplies={() => setQuickDialog(true)} />
      </header>

      {!online && (
        <div className="banner warning" role="status">
          You are offline. Messages will appear again when the connection is back.
        </div>
      )}

      <div className="panes">
        <aside className="sidebar" aria-label="Conversations">
          <ConversationList inbox={inbox} me={me} openId={openId} />
        </aside>
        <section className="detail">
          {isAdminPage ? (
            <AdminPage me={me} staff={Object.values(inbox.staff)} onChanged={inbox.reload} />
          ) : openId && openConversation ? (
            <ConversationPane
              key={openId}
              conversation={openConversation}
              me={me}
              staff={inbox.staff}
              flags={inbox.flags}
              setFlag={inbox.setFlag}
              quickReplies={quickReplies}
              onManageQuickReplies={() => setQuickDialog(true)}
              initialUnread={openUnread}
              focusMessageId={route.page === "inbox" ? route.messageId : null}
            />
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

      {quickDialog && (
        <QuickRepliesDialog quickReplies={quickReplies} onChanged={reloadQuickReplies} onClose={() => setQuickDialog(false)} />
      )}
    </div>
  );
}

/** Gear menu: theme, notifications, sound, quick replies, admin, sign out. */
function SettingsMenu({ me, isAdminPage, onQuickReplies }: { me: Staff; isAdminPage: boolean; onQuickReplies: () => void }) {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState(notificationPermission);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  async function toggleNotifications(on: boolean) {
    if (!on) return updateSettings({ notifications: false });
    const granted = await requestNotificationPermission();
    setPermission(notificationPermission());
    updateSettings({ notifications: granted });
  }

  return (
    <div className="settings" ref={root}>
      <button
        type="button"
        className={`button icon small ${open ? "active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-label="Settings"
        aria-expanded={open}
        data-testid="settings-button"
      >
        <Icon name="settings" size={18} />
      </button>
      {open && (
        <div className="popover settings-popover" data-testid="settings-menu">
          <label className="setting">
            <span>Theme</span>
            <select
              value={settings.theme}
              onChange={(e) => updateSettings({ theme: e.target.value as Settings["theme"] })}
              aria-label="Theme"
            >
              <option value="system">Same as device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="setting">
            <span>Sound for new messages</span>
            <input
              type="checkbox"
              checked={settings.sound}
              onChange={(e) => {
                updateSettings({ sound: e.target.checked });
                if (e.target.checked) playSound();
              }}
            />
          </label>
          <label className="setting">
            <span>Browser notifications</span>
            <input
              type="checkbox"
              checked={settings.notifications}
              disabled={permission === "unsupported"}
              onChange={(e) => void toggleNotifications(e.target.checked)}
            />
          </label>
          {permission === "denied" && (
            <p className="menu-note">Notifications are blocked for this site in the browser settings.</p>
          )}
          {permission === "unsupported" && <p className="menu-note">This browser does not support notifications.</p>}
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onQuickReplies();
            }}
          >
            Quick replies…
          </button>
          {me.role === "admin" && (
            <a role="menuitem" href={isAdminPage ? "#/" : "#/admin"} onClick={() => setOpen(false)}>
              {isAdminPage ? "Back to inbox" : "Admin: staff accounts"}
            </a>
          )}
          <button type="button" role="menuitem" onClick={() => void supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

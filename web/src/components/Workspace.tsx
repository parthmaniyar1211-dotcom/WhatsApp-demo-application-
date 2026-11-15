import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { QuickReply, Staff } from "../lib/types";
import { changePassword, loadQuickReplies } from "../lib/api";
import { errorMessage } from "../lib/format";
import { notificationPermission, playSound, requestNotificationPermission } from "../lib/notify";
import { type Settings, updateSettings, useSettings } from "../lib/settings";
import { useInbox } from "../hooks/useInbox";
import { navigate, useOnline, useRoute, useVisible } from "../hooks/useBrowserState";
import { ConversationList } from "./ConversationList";
import { ConversationPane } from "./ConversationPane";
import { NewChatDialog } from "./NewChatDialog";
import { QuickRepliesDialog } from "./QuickRepliesDialog";
import { Icon } from "./Icons";

/** The signed-in app: chat list on the left, the open chat on the right. */
export function Workspace({ me }: { me: Staff }) {
  const route = useRoute();
  const online = useOnline();
  const visible = useVisible();
  const openId = route.page === "inbox" ? route.conversationId : null;
  const openConversationById = useCallback((id: string) => navigate(`#/c/${id}`), []);
  const inbox = useInbox(me.user_id, openId, openConversationById);

  const openConversation = openId ? inbox.conversations.find((c) => c.id === openId) : undefined;
  const openUnread = openId ? (inbox.unread[openId] ?? 0) : 0;

  // Reading a chat (tab in the foreground) marks it as read.
  const { markRead } = inbox;
  useEffect(() => {
    if (openId && openConversation && visible && openUnread > 0) markRead(openId);
  }, [openId, openConversation, visible, openUnread, markRead]);

  const totalUnread = Object.entries(inbox.unread).reduce((sum, [id, n]) => sum + (id === openId ? 0 : n), 0);
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Chats` : "Chats";
  }, [totalUnread]);

  // Quick replies; reloaded after the dialog changes them.
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [dialog, setDialog] = useState<"new" | "quick" | "password" | null>(null);
  const reloadQuickReplies = useCallback(() => {
    loadQuickReplies().then(setQuickReplies, () => {});
  }, []);
  useEffect(reloadQuickReplies, [reloadQuickReplies]);

  return (
    <div className={`app ${openId ? "detail-open" : ""}`}>
      {!online && (
        <div className="banner warning top-banner" role="status">
          You are offline. Messages will appear again when the connection is back.
        </div>
      )}
      <div className="panes">
        <aside className="sidebar" aria-label="Chats">
          <ConversationList
            inbox={inbox}
            openId={openId}
            onNewChat={() => setDialog("new")}
            menu={
              <SettingsMenu
                live={!online ? "offline" : inbox.live}
                onQuickReplies={() => setDialog("quick")}
                onPassword={() => setDialog("password")}
              />
            }
          />
        </aside>
        <section className="detail">
          {openId && openConversation ? (
            <ConversationPane
              key={openId}
              conversation={openConversation}
              me={me}
              flags={inbox.flags}
              setFlag={inbox.setFlag}
              quickReplies={quickReplies}
              onManageQuickReplies={() => setDialog("quick")}
              initialUnread={openUnread}
              focusMessageId={route.page === "inbox" ? route.messageId : null}
            />
          ) : openId && inbox.loaded ? (
            <div className="empty">
              <p>This chat does not exist any more.</p>
              <a className="button" href="#/">
                Back to chats
              </a>
            </div>
          ) : openId ? (
            <div className="empty" role="status">
              <div className="spinner" />
            </div>
          ) : (
            <div className="welcome">
              <span className="welcome-logo" aria-hidden="true">
                <Icon name="chat" size={64} />
              </span>
              <h2>Chats for WhatsApp</h2>
              <p className="muted">Send and receive messages through your WhatsApp Business number.</p>
              <button type="button" className="button primary" onClick={() => setDialog("new")}>
                New chat
              </button>
              <p className="muted small welcome-note">
                <Icon name="lock" size={13} /> Messages go through the official WhatsApp Business API.
              </p>
            </div>
          )}
        </section>
      </div>

      {dialog === "new" && <NewChatDialog onClose={() => setDialog(null)} />}
      {dialog === "quick" && (
        <QuickRepliesDialog quickReplies={quickReplies} onChanged={reloadQuickReplies} onClose={() => setDialog(null)} />
      )}
      {dialog === "password" && <PasswordDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await changePassword(password);
      setMessage({ kind: "ok", text: "Password changed." });
      setPassword("");
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-label="Change password" onSubmit={submit}>
        <header className="info-header">
          <h3>Change password</h3>
          <span className="spacer" />
          <button type="button" className="round-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="dialog-body">
          <label className="field">
            <span>New password (at least 8 characters)</span>
            <input name="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
          </label>
          {message && (
            <p className={`notice ${message.kind === "ok" ? "success" : "error"}`} role="status" data-testid="password-status">
              {message.text}
            </p>
          )}
          <button type="submit" className="button primary wide" disabled={busy || password.length < 8}>
            Change password
          </button>
        </div>
      </form>
    </div>
  );
}

/** The ⋯ menu: connection, theme, sound, notifications, quick replies, password, log out. */
function SettingsMenu({
  live,
  onQuickReplies,
  onPassword,
}: {
  live: string;
  onQuickReplies: () => void;
  onPassword: () => void;
}) {
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

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="settings" ref={root}>
      <button
        type="button"
        className={`round-button ${open ? "active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-label="Menu"
        aria-expanded={open}
        title="Menu"
        data-testid="settings-button"
      >
        <Icon name="more" size={22} />
      </button>
      {open && (
        <div className="popover settings-popover" data-testid="settings-menu">
          <p className={`conn ${live}`} role="status" data-testid="live-status">
            {live === "offline" ? "Offline" : live === "live" ? "Live" : live === "connecting" ? "Connecting…" : "Reconnecting…"}
          </p>
          <label className="setting">
            <span>Theme</span>
            <select
              value={settings.theme}
              onChange={(e) => updateSettings({ theme: e.target.value as Settings["theme"] })}
              aria-label="Theme"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Same as device</option>
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
            <span>Desktop notifications</span>
            <input
              type="checkbox"
              checked={settings.notifications}
              disabled={permission === "unsupported"}
              onChange={(e) => void toggleNotifications(e.target.checked)}
            />
          </label>
          {permission === "denied" && <p className="menu-note">Notifications are blocked for this site in the browser settings.</p>}
          {permission === "unsupported" && <p className="menu-note">This browser does not support notifications.</p>}
          <hr />
          <button type="button" role="menuitem" onClick={run(onQuickReplies)}>
            Quick replies
          </button>
          <button type="button" role="menuitem" onClick={run(onPassword)}>
            Change password
          </button>
          <button type="button" role="menuitem" onClick={() => void supabase.auth.signOut()}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

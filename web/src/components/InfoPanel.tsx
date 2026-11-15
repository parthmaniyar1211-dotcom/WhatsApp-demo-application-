import { useEffect, useState } from "react";
import type { Conversation, Message } from "../lib/types";
import { loadMessagesByIds, renameContact } from "../lib/api";
import { customerLabel, errorMessage, formatListTime, formatPhone, messageSummary } from "../lib/format";
import type { Flags } from "../hooks/useInbox";
import { Avatar } from "./Avatar";
import { Icon } from "./Icons";

interface Props {
  conversation: Conversation;
  flags: Flags;
  /** Messages of this chat that are loaded right now (to count deleted ones). */
  messages: Message[];
  onClose: () => void;
  onJump: (messageId: string) => void;
  onUnhide: (messageIds: string[]) => void;
}

/** Contact info: name (editable), number, starred messages, messages deleted for me, API limits. */
export function InfoPanel({ conversation, flags, messages, onClose, onJump, onUnhide }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(conversation.contact_name ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      await renameContact(conversation.id, name);
      setEditing(false);
      setStatus({ kind: "ok", text: "Name saved" });
    } catch (err) {
      setStatus({ kind: "error", text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  // Starred messages of this chat (they may be older than what is loaded).
  const starredIds = Object.entries(flags)
    .filter(([, flag]) => flag.starred)
    .map(([id]) => id);
  const starredKey = starredIds.join(",");
  const [starred, setStarred] = useState<Message[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadMessagesByIds(starredKey ? starredKey.split(",") : []).then(
      (rows) => !cancelled && setStarred(rows.filter((m) => m.conversation_id === conversation.id)),
      () => !cancelled && setStarred([]),
    );
    return () => {
      cancelled = true;
    };
  }, [starredKey, conversation.id]);

  const hiddenIds = messages.filter((m) => flags[m.id]?.hidden).map((m) => m.id);
  const label = customerLabel(conversation);

  return (
    <aside className="info-panel" aria-label="Contact info" data-testid="info-panel">
      <header className="info-header">
        <button type="button" className="round-button" onClick={onClose} aria-label="Close contact info">
          <Icon name="close" size={20} />
        </button>
        <h3>Contact info</h3>
      </header>
      <div className="info-body">
        <div className="info-identity">
          <Avatar name={label} seed={conversation.wa_id} size={110} />
          {editing ? (
            <form className="inline-form" onSubmit={save}>
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Contact name" maxLength={80} autoFocus placeholder="Name" />
              <button type="submit" className="button small primary" disabled={saving}>
                Save
              </button>
            </form>
          ) : (
            <strong className="info-name" data-testid="info-name">
              {label}{" "}
              <button type="button" className="round-button small-round" onClick={() => setEditing(true)} aria-label="Edit name" data-testid="edit-name">
                <Icon name="edit" size={16} />
              </button>
            </strong>
          )}
          <span className="muted" data-testid="info-number">
            {formatPhone(conversation.wa_id)}
          </span>
          {conversation.customer_name && conversation.contact_name && conversation.customer_name !== conversation.contact_name && (
            <span className="muted small">WhatsApp name: {conversation.customer_name}</span>
          )}
          {status && (
            <span className={status.kind === "ok" ? "muted small" : "error-text small"} role="status" data-testid="info-status">
              {status.text}
            </span>
          )}
        </div>

        <section>
          <h4>Starred messages ({starred.length})</h4>
          {starred.length === 0 && <p className="muted small">Star a message from its menu to find it again here.</p>}
          <ul className="mini-list">
            {starred.map((message) => (
              <li key={message.id}>
                <button type="button" onClick={() => onJump(message.id)} data-testid="info-starred">
                  <span>{messageSummary(message) || "Message"}</span>
                  <time className="muted small">{formatListTime(message.created_at)}</time>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h4>Deleted for you</h4>
          {hiddenIds.length === 0 ? (
            <p className="muted small">Nothing deleted in the loaded part of this chat.</p>
          ) : (
            <button type="button" className="button small" onClick={() => onUnhide(hiddenIds)} data-testid="unhide-all">
              Show {hiddenIds.length} message{hiddenIds.length === 1 ? "" : "s"} again
            </button>
          )}
          <p className="muted small">“Delete for me” only hides a message here. WhatsApp does not let a business delete a message for the other person.</p>
        </section>

        <section className="limits" data-testid="limits">
          <h4>What the WhatsApp Business API does not allow</h4>
          <ul>
            <li>Online and “last seen” status of a contact are not shared with businesses.</li>
            <li>Sent messages cannot be edited or deleted for the other person.</li>
            <li>Status updates, groups and voice or video calls are not available.</li>
            <li>The first message to a number must be an approved template; free text is possible for 24 hours after they reply.</li>
          </ul>
        </section>
      </div>
    </aside>
  );
}

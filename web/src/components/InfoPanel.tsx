import { useEffect, useState } from "react";
import type { Conversation, Message, Staff } from "../lib/types";
import { loadMessagesByIds, updateConversationInfo } from "../lib/api";
import { customerLabel, errorMessage, formatListTime, formatPhone, messageSummary } from "../lib/format";
import type { Flags } from "../hooks/useInbox";
import { Icon } from "./Icons";

interface Props {
  conversation: Conversation;
  me: Staff;
  staff: Record<string, Staff>;
  flags: Flags;
  /** Messages of this chat that are loaded right now (to count hidden ones). */
  messages: Message[];
  onClose: () => void;
  onJump: (messageId: string) => void;
  onUnhide: (messageIds: string[]) => void;
}

/** Customer details: name, number, owner, internal notes, labels, starred and hidden messages. */
export function InfoPanel({ conversation, me, staff, flags, messages, onClose, onJump, onUnhide }: Props) {
  const [notes, setNotes] = useState(conversation.notes);
  const [labelDraft, setLabelDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const owner = conversation.assigned_to ? staff[conversation.assigned_to] : undefined;
  const dirty = notes !== conversation.notes;

  async function save(nextNotes: string, nextLabels: string[], message: string) {
    setSaving(true);
    setStatus(null);
    try {
      await updateConversationInfo(conversation.id, nextNotes, nextLabels);
      setStatus({ kind: "ok", text: message });
    } catch (err) {
      setStatus({ kind: "error", text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  function addLabel(event: React.FormEvent) {
    event.preventDefault();
    const label = labelDraft.trim().slice(0, 30);
    if (!label || conversation.labels.includes(label)) return setLabelDraft("");
    if (conversation.labels.length >= 10) return setStatus({ kind: "error", text: "A chat can have at most 10 labels." });
    setLabelDraft("");
    void save(conversation.notes, [...conversation.labels, label], "Label added");
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

  return (
    <aside className="info-panel" aria-label="Customer details" data-testid="info-panel">
      <header className="info-header">
        <button type="button" className="button icon small" onClick={onClose} aria-label="Close customer details">
          <Icon name="close" size={18} />
        </button>
        <h3>Customer details</h3>
      </header>
      <div className="info-body">
        <div className="info-identity">
          <span className="avatar large" aria-hidden="true">
            {customerLabel(conversation).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "#"}
          </span>
          <strong data-testid="info-name">{customerLabel(conversation)}</strong>
          <span className="muted" data-testid="info-number">
            {formatPhone(conversation.wa_id)}
          </span>
          <span className="muted small">First contact {formatListTime(conversation.created_at)}</span>
        </div>

        <section>
          <h4>Owner</h4>
          <p data-testid="info-owner">
            {conversation.assigned_to
              ? conversation.assigned_to === me.user_id
                ? `You (${me.staff_id})`
                : `${owner?.staff_id ?? "Another staff member"}${owner?.display_name ? ` · ${owner.display_name}` : ""}`
              : "Unassigned"}
          </p>
        </section>

        <section>
          <h4>Labels</h4>
          <div className="labels" data-testid="info-labels">
            {conversation.labels.length === 0 && <span className="muted small">No labels</span>}
            {conversation.labels.map((label) => (
              <span className="label" key={label}>
                {label}
                <button
                  type="button"
                  aria-label={`Remove label ${label}`}
                  disabled={saving}
                  onClick={() => void save(conversation.notes, conversation.labels.filter((l) => l !== label), "Label removed")}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <form className="inline-form" onSubmit={addLabel}>
            <input
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              placeholder="Add a label, e.g. VIP"
              aria-label="New label"
              maxLength={30}
            />
            <button type="submit" className="button small" disabled={saving || !labelDraft.trim()}>
              Add
            </button>
          </form>
        </section>

        <section>
          <h4>Notes</h4>
          <textarea
            className="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes. The customer never sees these."
            aria-label="Internal notes"
            rows={4}
            maxLength={5000}
          />
          <div className="row">
            <button
              type="button"
              className="button small primary"
              disabled={saving || !dirty}
              onClick={() => void save(notes, conversation.labels, "Notes saved")}
            >
              Save notes
            </button>
            {status && (
              <span className={status.kind === "ok" ? "muted small" : "error-text small"} role="status" data-testid="info-status">
                {status.text}
              </span>
            )}
          </div>
        </section>

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
          <h4>Hidden for you</h4>
          {hiddenIds.length === 0 ? (
            <p className="muted small">Nothing hidden in the loaded part of this chat.</p>
          ) : (
            <button type="button" className="button small" onClick={() => onUnhide(hiddenIds)} data-testid="unhide-all">
              Show {hiddenIds.length} hidden message{hiddenIds.length === 1 ? "" : "s"} again
            </button>
          )}
          <p className="muted small">
            “Hide for me” only hides a message in your own view. The customer and your colleagues still see it.
          </p>
        </section>

        <section className="limits" data-testid="limits">
          <h4>What WhatsApp does not allow here</h4>
          <ul>
            <li>Online and “last seen” status of the customer are not shared with businesses.</li>
            <li>Sent messages cannot be edited or deleted for the customer.</li>
            <li>Status / Stories and voice or video calls are not available.</li>
            <li>Free text is only possible within 24 hours of the customer’s last message.</li>
          </ul>
        </section>
      </div>
    </aside>
  );
}

import { useState } from "react";
import type { QuickReply } from "../lib/types";
import { deleteQuickReply, saveQuickReply } from "../lib/api";
import { errorMessage } from "../lib/format";
import { Icon } from "./Icons";

interface Props {
  quickReplies: QuickReply[];
  onChanged: () => void;
  onClose: () => void;
}

/** Create, change and delete the saved snippets all staff can insert with "/shortcut". */
export function QuickRepliesDialog({ quickReplies, onChanged, onClose }: Props) {
  const [editing, setEditing] = useState<string | null>(null); // id being edited, "new", or null
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start(reply: QuickReply | null) {
    setEditing(reply?.id ?? "new");
    setShortcut(reply?.shortcut ?? "");
    setBody(reply?.body ?? "");
    setError(null);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setEditing(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Quick replies" data-testid="quick-dialog">
        <header className="info-header">
          <h3>Quick replies</h3>
          <span className="spacer" />
          <button type="button" className="button icon small" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="dialog-body">
          <p className="muted small">
            Shared by all staff. Type <code>/</code> in the reply box to insert one.
          </p>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <ul className="quick-admin">
            {quickReplies.map((reply) =>
              editing === reply.id ? null : (
                <li key={reply.id} data-testid="quick-row">
                  <div>
                    <strong>/{reply.shortcut}</strong>
                    <p className="muted small">{reply.body}</p>
                  </div>
                  <button type="button" className="button small" disabled={busy} onClick={() => start(reply)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="button small danger"
                    disabled={busy}
                    onClick={() => void run(() => deleteQuickReply(reply.id))}
                    aria-label={`Delete /${reply.shortcut}`}
                  >
                    Delete
                  </button>
                </li>
              ),
            )}
            {quickReplies.length === 0 && <li className="muted small">No quick replies yet.</li>}
          </ul>

          {editing ? (
            <form
              className="quick-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => saveQuickReply(editing === "new" ? null : editing, shortcut, body));
              }}
            >
              <label className="field">
                <span>Shortcut (letters, digits, - and _)</span>
                <input
                  name="quick-shortcut"
                  value={shortcut}
                  onChange={(e) => setShortcut(e.target.value)}
                  placeholder="thanks"
                  maxLength={31}
                  autoFocus
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>Text</span>
                <textarea name="quick-body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={4096} />
              </label>
              <div className="row">
                <button type="submit" className="button primary" disabled={busy || !shortcut.trim() || !body.trim()}>
                  Save
                </button>
                <button type="button" className="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="button primary" onClick={() => start(null)}>
              New quick reply
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

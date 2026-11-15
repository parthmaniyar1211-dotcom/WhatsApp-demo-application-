import { useState } from "react";
import { startConversation } from "../lib/api";
import { errorMessage } from "../lib/format";
import { navigate } from "../hooks/useBrowserState";
import { Icon } from "./Icons";

const DEFAULT_COUNTRY = "91";

/** Add a contact by phone number and open the chat. */
export function NewChatDialog({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A number typed without country code gets the default one (10 digits = a local number).
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  const full = digits.length === 10 ? DEFAULT_COUNTRY + digits : digits;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (full.length < 7 || full.length > 15) {
      setError("Enter the phone number with country code, for example +91 98765 43210.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const chat = await startConversation(full, name.trim());
      navigate(`#/c/${chat.id}`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-label="New chat" data-testid="new-chat-dialog" onSubmit={submit}>
        <header className="info-header">
          <h3>New chat</h3>
          <span className="spacer" />
          <button type="button" className="round-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="dialog-body">
          <label className="field">
            <span>Phone number</span>
            <input
              name="new-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              autoComplete="off"
              autoFocus
            />
          </label>
          <label className="field">
            <span>Name (optional)</span>
            <input name="new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Save as…" maxLength={80} autoComplete="off" />
          </label>
          {full.length >= 7 && <p className="muted small">Chat with +{full}</p>}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <p className="muted small hint">
            WhatsApp only lets a business start a chat with an approved template message. After you send it, you can
            type freely for 24 hours once the person replies. A Meta test number can only message numbers you added
            under WhatsApp → API Setup.
          </p>
          <button type="submit" className="button primary wide" disabled={busy || full.length < 7}>
            {busy ? "Opening…" : "Start chat"}
          </button>
        </div>
      </form>
    </div>
  );
}

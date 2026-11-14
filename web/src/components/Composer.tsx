import { useEffect, useRef, useState } from "react";
import type { Message } from "../lib/types";
import { ALLOWED_FILE_TYPES, MAX_CAPTION_LENGTH, MAX_TEXT_LENGTH, sendMessage, validateFile } from "../lib/api";
import { errorMessage } from "../lib/format";
import { useOnline } from "../hooks/useBrowserState";

interface Props {
  conversationId: string;
  userId: string;
  windowOpen: boolean;
  onSent: (message: Message) => void;
}

/** Reply box. Inside the 24-hour window: text and files. Outside: only the template sender. */
export function Composer({ conversationId, userId, windowOpen, onSent }: Props) {
  const online = useOnline();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);

  // The chosen file, with a local preview URL for photos.
  const [attachment, setAttachment] = useState<{ file: File; preview: string | null } | null>(null);
  const file = attachment?.file ?? null;
  const preview = attachment?.preview ?? null;
  const previewRef = useRef<string | null>(null);
  function setFile(next: File | null) {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = next && next.type.startsWith("image/") ? URL.createObjectURL(next) : null;
    setAttachment(next ? { file: next, preview: previewRef.current } : null);
  }
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const limit = file ? MAX_CAPTION_LENGTH : MAX_TEXT_LENGTH;
  const trimmed = text.trim();
  const tooLong = trimmed.length > limit;
  const canSend = online && !busy && !tooLong && (trimmed.length > 0 || file !== null);

  function chooseFile(chosen: File | undefined) {
    if (fileInput.current) fileInput.current.value = "";
    if (!chosen) return;
    const problem = validateFile(chosen);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setFile(chosen);
  }

  async function run(action: () => Promise<Message>, onSuccess: () => void) {
    setBusy(true);
    setError(null);
    try {
      onSent(await action());
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function send() {
    if (!canSend) return;
    void run(
      () => sendMessage(userId, { conversationId, text: trimmed || undefined, file: file ?? undefined }),
      () => {
        setText("");
        setFile(null);
        textArea.current?.focus();
      },
    );
  }

  if (!windowOpen) {
    return (
      <div className="composer closed" data-testid="template-sender">
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="template-row">
          <div>
            <strong>hello_world</strong>
            <p className="muted small">Approved template (English). Re-opens the chat when the customer answers.</p>
          </div>
          <button
            className="button primary"
            disabled={busy || !online}
            onClick={() => void run(() => sendMessage(userId, { conversationId, template: "hello_world" }), () => {})}
            data-testid="send-template"
          >
            {busy ? "Sending…" : "Send template"}
          </button>
        </div>
        <textarea disabled rows={1} placeholder="Free text is disabled until the customer replies" aria-label="Reply" />
      </div>
    );
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {error && (
        <p className="notice error" role="alert" data-testid="composer-error">
          {error}
        </p>
      )}
      {file && (
        <div className="attachment" data-testid="attachment">
          {preview ? <img src={preview} alt="" /> : <span className="document-icon">PDF</span>}
          <span className="attachment-name">
            {file.name} <span className="muted">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
          </span>
          <button type="button" className="button small" onClick={() => setFile(null)} disabled={busy}>
            Remove
          </button>
        </div>
      )}
      <div className="composer-row">
        <input
          ref={fileInput}
          type="file"
          accept={ALLOWED_FILE_TYPES.join(",")}
          hidden
          onChange={(e) => chooseFile(e.target.files?.[0])}
          data-testid="file-input"
        />
        <button
          type="button"
          className="button icon"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          aria-label="Attach a photo or PDF (max 10 MB)"
          title="Attach a photo or PDF (max 10 MB)"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5.5a3 3 0 0 1 6 0v10.25a1.5 1.5 0 0 1-3 0V6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <textarea
          ref={textArea}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={file ? "Add a caption (optional)" : "Type a reply"}
          aria-label="Reply"
          enterKeyHint="send"
          disabled={busy}
          data-testid="reply-input"
        />
        <button className="button primary" type="submit" disabled={!canSend} data-testid="send-button">
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {tooLong && (
        <p className="error-text small">
          Too long: {trimmed.length} / {limit} characters.
        </p>
      )}
      {!online && <p className="muted small">You are offline. Sending is paused.</p>}
    </form>
  );
}

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Message, QuickReply } from "../lib/types";
import {
  ALLOWED_FILE_TYPES,
  markReadAtWhatsApp,
  MAX_CAPTION_LENGTH,
  MAX_TEXT_LENGTH,
  sendMessage,
  validateFile,
} from "../lib/api";
import { errorMessage, formatBytes, formatDuration, messageSummary } from "../lib/format";
import { EMOJIS } from "../lib/emoji";
import { canRecord, type Recording, startRecording } from "../lib/voice";
import { useOnline } from "../hooks/useBrowserState";
import { Icon } from "./Icons";

interface Props {
  conversationId: string;
  userId: string;
  windowOpen: boolean;
  customerName: string;
  quickReplies: QuickReply[];
  replyTo: Message | null;
  onCancelReply: () => void;
  onSent: (message: Message) => void;
  onManageQuickReplies: () => void;
}

export interface ComposerHandle {
  /** Attach a file chosen elsewhere (drag and drop onto the chat). */
  attach: (file: File) => void;
}

const TYPING_EVERY_MS = 20_000; // WhatsApp hides the indicator after 25 s

/**
 * Reply box. Inside the 24-hour window: text, emoji, files, voice notes, quick replies.
 * Outside: only the template sender.
 */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
  const { conversationId, userId, windowOpen, customerName, quickReplies, replyTo, onCancelReply, onSent } = props;
  const online = useOnline();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [quickIndex, setQuickIndex] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);

  // The chosen file, with a local preview URL for photos and recordings.
  const [attachment, setAttachment] = useState<{ file: File; preview: string | null; voice: boolean } | null>(null);
  const file = attachment?.file ?? null;
  const previewRef = useRef<string | null>(null);
  function setFile(next: File | null, voice = false) {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const previewable = next && (next.type.startsWith("image/") || next.type.startsWith("audio/"));
    previewRef.current = previewable ? URL.createObjectURL(next) : null;
    setAttachment(next ? { file: next, preview: previewRef.current, voice } : null);
  }
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  function chooseFile(chosen: File | undefined, voice = false) {
    if (fileInput.current) fileInput.current.value = "";
    if (!chosen) return;
    const problem = validateFile(chosen);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setFile(chosen, voice);
    textArea.current?.focus();
  }
  useImperativeHandle(ref, () => ({ attach: (dropped) => chooseFile(dropped) }));

  // --- Voice recording
  const recording = useRef<Recording | null>(null);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (recordingSince === null) return;
    const timer = setInterval(() => setElapsed((Date.now() - recordingSince) / 1000), 250);
    return () => clearInterval(timer);
  }, [recordingSince]);
  useEffect(() => () => void recording.current?.stop(true), []);

  async function record() {
    setError(null);
    try {
      recording.current = await startRecording();
      setElapsed(0);
      setRecordingSince(Date.now());
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function stopRecording(cancel: boolean) {
    const active = recording.current;
    recording.current = null;
    setRecordingSince(null);
    if (!active) return;
    try {
      const recorded = await active.stop(cancel);
      if (recorded) chooseFile(recorded, true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // --- Quick replies: "/" at the start of the box opens the list
  const slash = /^\/([a-z0-9_-]*)$/i.exec(text);
  const matches = slash ? quickReplies.filter((q) => q.shortcut.startsWith(slash[1].toLowerCase())).slice(0, 6) : [];
  const quickOpen = Boolean(slash) && !file;
  const activeQuick = Math.min(quickIndex, Math.max(matches.length - 1, 0));
  function insertQuick(reply: QuickReply) {
    setText(reply.body);
    setQuickIndex(0);
    textArea.current?.focus();
  }

  // --- "typing…" on the customer's phone while staff write (also marks the chat read at WhatsApp)
  const lastTyping = useRef(0);
  function onTextChange(value: string) {
    setText(value);
    setQuickIndex(0);
    if (value.trim() && !value.startsWith("/") && Date.now() - lastTyping.current > TYPING_EVERY_MS) {
      lastTyping.current = Date.now();
      void markReadAtWhatsApp(conversationId, true);
    }
  }

  function insertEmoji(emoji: string) {
    const area = textArea.current;
    const start = area?.selectionStart ?? text.length;
    const end = area?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  const isAudio = file?.type.startsWith("audio/") ?? false;
  const limit = file ? MAX_CAPTION_LENGTH : MAX_TEXT_LENGTH;
  const trimmed = text.trim();
  const tooLong = trimmed.length > limit;
  const canSend = online && !busy && !tooLong && !quickOpen && (trimmed.length > 0 || file !== null) && !(isAudio && trimmed);

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
      () =>
        sendMessage(userId, {
          conversationId,
          text: trimmed || undefined,
          file: file ?? undefined,
          voice: attachment?.voice,
          replyTo: replyTo?.id,
        }),
      () => {
        setText("");
        setFile(null);
        onCancelReply();
        setEmojiOpen(false);
        lastTyping.current = 0;
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

  if (recordingSince !== null) {
    return (
      <div className="composer recording" data-testid="recording">
        <span className="record-dot" aria-hidden="true" />
        <span className="record-time" role="timer">
          Recording {formatDuration(elapsed)}
        </span>
        <span className="spacer" />
        <button type="button" className="button" onClick={() => void stopRecording(true)}>
          <Icon name="trash" size={16} /> Cancel
        </button>
        <button type="button" className="button primary" onClick={() => void stopRecording(false)} data-testid="stop-recording">
          <Icon name="stop" size={16} /> Done
        </button>
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

      {replyTo && (
        <div className="reply-preview" data-testid="reply-preview">
          <div className="quote static">
            <span className="quote-author">
              Replying to {replyTo.direction === "out" ? (replyTo.sent_by_staff_id ?? "Staff") : customerName}
            </span>
            <span className="quote-text">{messageSummary(replyTo) || "Message"}</span>
          </div>
          <button type="button" className="button icon small" onClick={onCancelReply} aria-label="Cancel reply">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {attachment && (
        <div className="attachment" data-testid="attachment">
          {attachment.preview && file!.type.startsWith("image/") ? (
            <img src={attachment.preview} alt="" />
          ) : isAudio && attachment.preview ? (
            <audio src={attachment.preview} controls preload="metadata" data-testid="attachment-audio" />
          ) : (
            <span className="document-icon pdf">{file!.type === "application/pdf" ? "PDF" : "FILE"}</span>
          )}
          <span className="attachment-name">
            {attachment.voice ? "Voice note" : file!.name} <span className="muted">({formatBytes(file!.size)})</span>
          </span>
          <button type="button" className="button small" onClick={() => setFile(null)} disabled={busy}>
            Remove
          </button>
        </div>
      )}

      {quickOpen && (
        <div className="quick-list" role="listbox" aria-label="Quick replies" data-testid="quick-replies">
          {matches.length === 0 && <p className="muted small">No quick reply starts with “{text}”.</p>}
          {matches.map((reply, index) => (
            <button
              type="button"
              key={reply.id}
              role="option"
              aria-selected={index === activeQuick}
              className={index === activeQuick ? "active" : ""}
              onClick={() => insertQuick(reply)}
            >
              <strong>/{reply.shortcut}</strong>
              <span>{reply.body}</span>
            </button>
          ))}
          <button type="button" className="quick-manage" onClick={props.onManageQuickReplies}>
            Manage quick replies…
          </button>
        </div>
      )}

      {emojiOpen && (
        <div className="emoji-picker" data-testid="emoji-picker">
          {EMOJIS.map((emoji) => (
            <button type="button" key={emoji} onClick={() => insertEmoji(emoji)} aria-label={`Insert ${emoji}`}>
              {emoji}
            </button>
          ))}
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
          className={`button icon ${emojiOpen ? "active" : ""}`}
          onClick={() => setEmojiOpen((open) => !open)}
          disabled={busy}
          aria-label="Emoji"
          aria-expanded={emojiOpen}
          data-testid="emoji-button"
        >
          <Icon name="emoji" />
        </button>
        <button
          type="button"
          className="button icon"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          aria-label="Attach a photo, video, PDF or audio file"
          title="Attach a photo (max 5 MB), video, PDF or audio file (max 10 MB)"
        >
          <Icon name="attach" />
        </button>
        <textarea
          ref={textArea}
          rows={1}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onPaste={(e) => {
            // Pasting a screenshot or copied picture attaches it.
            const pasted = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
            if (pasted) {
              e.preventDefault();
              chooseFile(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (quickOpen && matches.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setQuickIndex((activeQuick + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertQuick(matches[activeQuick]);
                return;
              }
            }
            if (e.key === "Escape" && (emojiOpen || replyTo)) {
              setEmojiOpen(false);
              onCancelReply();
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={isAudio ? "Audio is sent without text" : file ? "Add a caption (optional)" : "Type a reply or /shortcut"}
          aria-label="Reply"
          enterKeyHint="send"
          disabled={busy || isAudio}
          data-testid="reply-input"
        />
        {!trimmed && !file && canRecord() ? (
          <button
            type="button"
            className="button primary icon"
            onClick={() => void record()}
            disabled={busy || !online}
            aria-label="Record a voice note"
            title="Record a voice note"
            data-testid="record-button"
          >
            <Icon name="mic" />
          </button>
        ) : (
          <button className="button primary" type="submit" disabled={!canSend} data-testid="send-button">
            {busy ? "Sending…" : "Send"}
          </button>
        )}
      </div>
      {tooLong && (
        <p className="error-text small">
          Too long: {trimmed.length} / {limit} characters.
        </p>
      )}
      {!online && <p className="muted small">You are offline. Sending is paused.</p>}
    </form>
  );
});

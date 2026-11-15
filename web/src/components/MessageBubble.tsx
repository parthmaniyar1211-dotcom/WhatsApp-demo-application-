import { useEffect, useRef, useState } from "react";
import type { Message } from "../lib/types";
import { signedFileUrl } from "../lib/api";
import { formatBytes, formatTime, messageSummary } from "../lib/format";
import { REACTION_EMOJIS } from "../lib/emoji";
import { Icon, Ticks } from "./Icons";

export interface BubbleActions {
  onReply: (message: Message) => void;
  onReact: (message: Message, emoji: string) => void;
  onToggleStar: (message: Message) => void;
  onHide: (message: Message) => void;
  onJumpToQuoted: (waMessageId: string) => void;
  onOpenImage: (url: string) => void;
  onMediaLoad: () => void;
}

interface Props extends BubbleActions {
  message: Message;
  /** Follows a message from the same sender within a few minutes: drawn closer, without a tail. */
  grouped: boolean;
  customerName: string;
  /** The quoted message: undefined = this is not a reply, null = the quoted message is not loaded. */
  quoted: Message | null | undefined;
  starred: boolean;
  highlighted: boolean;
  /** Replies and reactions need an open 24-hour window. */
  windowOpen: boolean;
}

export function MessageBubble(props: Props) {
  const { message, grouped, customerName, quoted, starred, highlighted, windowOpen } = props;
  const outgoing = message.direction === "out";
  const hasFile = Boolean(message.media_path);
  const isMedia = ["image", "video", "audio", "document", "sticker"].includes(message.type);
  const sticker = message.type === "sticker" && hasFile;

  return (
    <div
      className={`message-row ${outgoing ? "out" : "in"} ${grouped ? "grouped" : ""} ${highlighted ? "highlighted" : ""}`}
      data-testid={outgoing ? "message-out" : "message-in"}
      data-status={message.status}
      data-message-id={message.id}
    >
      <div className={`bubble ${message.status === "failed" ? "failed" : ""} ${sticker ? "sticker" : ""}`}>
        {message.forwarded && (
          <p className="forwarded">
            <Icon name="forward" size={13} /> Forwarded
          </p>
        )}

        {quoted !== undefined && (
          <button
            type="button"
            className="quote"
            data-testid="quote"
            disabled={!quoted}
            onClick={() => quoted?.wa_message_id && props.onJumpToQuoted(quoted.wa_message_id)}
          >
            <span className="quote-author">
              {quoted ? (quoted.direction === "out" ? "You" : customerName) : "Earlier message"}
            </span>
            <span className="quote-text">{quoted ? messageSummary(quoted) || "Message" : "Not loaded. Scroll up to see it."}</span>
          </button>
        )}

        {hasFile && message.type === "image" && (
          <ImageFile path={message.media_path!} onLoad={props.onMediaLoad} onOpen={props.onOpenImage} />
        )}
        {sticker && <ImageFile path={message.media_path!} onLoad={props.onMediaLoad} sticker />}
        {hasFile && message.type === "video" && <VideoFile path={message.media_path!} onLoad={props.onMediaLoad} />}
        {hasFile && message.type === "audio" && <AudioFile path={message.media_path!} voice={message.media_voice} />}
        {hasFile && message.type === "document" && (
          <DocumentFile
            path={message.media_path!}
            filename={message.media_filename ?? "Document"}
            size={message.media_size}
            mime={message.media_mime}
          />
        )}
        {!hasFile && isMedia && (
          <p className="file-missing">
            {messageSummary(message) || "File"}
            {message.error ? "" : " (file is being fetched…)"}
          </p>
        )}

        {message.type === "location" && message.location && (
          <a
            className="mcard location"
            data-testid="message-location"
            href={`https://www.google.com/maps/search/?api=1&query=${message.location.latitude},${message.location.longitude}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="card-icon pin">
              <Icon name="pin" />
            </span>
            <span className="card-main">
              <span className="card-title">{message.location.name ?? "Location"}</span>
              {message.location.address && <span className="card-sub">{message.location.address}</span>}
              <span className="card-sub">
                {message.location.latitude.toFixed(5)}, {message.location.longitude.toFixed(5)}
              </span>
              <span className="card-action">Open in Google Maps</span>
            </span>
          </a>
        )}

        {message.type === "contacts" &&
          (message.contacts ?? []).map((contact, index) => (
            <div className="mcard" key={index} data-testid="message-contact">
              <span className="card-icon">
                <Icon name="contact" />
              </span>
              <span className="card-main">
                <span className="card-title">{contact.name}</span>
                {contact.phones.map((phone) => (
                  <span className="card-sub" key={phone}>
                    {phone}
                  </span>
                ))}
              </span>
            </div>
          ))}

        {message.type === "template" ? (
          <p className="body template">
            <span className="chip">Template</span> {message.body}
          </p>
        ) : (
          message.body &&
          message.type !== "location" &&
          message.type !== "contacts" && (
            <p className={`body ${message.type === "other" ? "muted" : ""}`}>
              {(message.type === "interactive" || message.type === "button") && <span className="chip">Button reply</span>}{" "}
              {message.body}
            </p>
          )
        )}

        {/* Incoming: a file that could not be stored. Outgoing: why WhatsApp refused the message. */}
        {message.error && (
          <p className="reason" data-testid="message-error">
            {outgoing ? `Not delivered: ${message.error}` : message.error}
          </p>
        )}

        <p className="meta">
          {starred && (
            <span className="star-mark" title="Starred" data-testid="star-mark">
              <Icon name="starFilled" size={12} />
            </span>
          )}
          <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
          {outgoing && <Ticks status={message.status} />}
        </p>

        {(message.reaction_customer || message.reaction_business) && (
          <div className="reactions" data-testid="reactions">
            {message.reaction_customer && (
              <span className="reaction" title={`${customerName} reacted`} data-testid="reaction-customer">
                {message.reaction_customer}
              </span>
            )}
            {message.reaction_business && (
              <button
                type="button"
                className="reaction ours"
                title="You reacted. Click to remove."
                data-testid="reaction-business"
                disabled={!windowOpen}
                onClick={() => props.onReact(message, "")}
              >
                {message.reaction_business}
              </button>
            )}
          </div>
        )}

        <MessageMenu {...props} />
      </div>
    </div>
  );
}

/** The "⋯" menu of a message: react, reply, star, copy, hide. */
function MessageMenu({ message, starred, windowOpen, onReply, onReact, onToggleStar, onHide }: Props) {
  const [open, setOpen] = useState(false);
  const [upward, setUpward] = useState(false); // open above the button when it is low on the screen
  const root = useRef<HTMLDivElement>(null);
  const canAnswer = Boolean(message.wa_message_id) && windowOpen;

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

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className={`message-menu ${open ? "open" : ""}`} ref={root}>
      <button
        type="button"
        className="menu-button"
        aria-label="Message actions"
        aria-expanded={open}
        data-testid="message-menu"
        onClick={(event) => {
          setUpward(event.currentTarget.getBoundingClientRect().top > window.innerHeight * 0.55);
          setOpen((value) => !value);
        }}
      >
        <Icon name="down" size={18} />
      </button>
      {open && (
        <div className={`popover ${upward ? "upward" : ""}`} role="menu">
          {canAnswer && (
            <div className="reaction-picker" data-testid="reaction-picker">
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  className={message.reaction_business === emoji ? "active" : ""}
                  aria-label={`React with ${emoji}`}
                  onClick={run(() => onReact(message, message.reaction_business === emoji ? "" : emoji))}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
          {canAnswer && (
            <button type="button" role="menuitem" onClick={run(() => onReply(message))}>
              <Icon name="reply" size={16} /> Reply
            </button>
          )}
          <button type="button" role="menuitem" onClick={run(() => onToggleStar(message))}>
            <Icon name={starred ? "starFilled" : "star"} size={16} /> {starred ? "Unstar" : "Star"}
          </button>
          {message.body && (
            <button type="button" role="menuitem" onClick={run(() => void navigator.clipboard?.writeText(message.body ?? ""))}>
              <Icon name="copy" size={16} /> Copy text
            </button>
          )}
          <button type="button" role="menuitem" onClick={run(() => onHide(message))}>
            <Icon name="trash" size={16} /> Delete for me
          </button>
          {!windowOpen && Boolean(message.wa_message_id) && (
            <p className="menu-note">Reply and react need an open 24-hour window.</p>
          )}
          <p className="menu-note">WhatsApp does not let a business edit or delete a sent message.</p>
        </div>
      )}
    </div>
  );
}

type FileUrl = { state: "loading" } | { state: "ok"; url: string } | { state: "error" };

/** Files live in a private bucket: ask for a short-lived signed URL when the message is shown. */
function useFileUrl(path: string): FileUrl {
  const [result, setResult] = useState<{ path: string; value: FileUrl } | null>(null);
  useEffect(() => {
    let cancelled = false;
    signedFileUrl(path).then(
      (url) => !cancelled && setResult({ path, value: { state: "ok", url } }),
      () => !cancelled && setResult({ path, value: { state: "error" } }),
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return result && result.path === path ? result.value : { state: "loading" };
}

function ImageFile({
  path,
  onLoad,
  onOpen,
  sticker = false,
}: {
  path: string;
  onLoad: () => void;
  onOpen?: (url: string) => void;
  sticker?: boolean;
}) {
  const file = useFileUrl(path);
  if (file.state === "error") return <p className="file-missing">{sticker ? "Sticker" : "Photo"} is not available</p>;
  if (file.state === "loading") return <div className={sticker ? "sticker-placeholder" : "image-placeholder"} aria-label="Loading" />;
  if (sticker) return <img className="sticker-image" src={file.url} alt="Sticker" onLoad={onLoad} data-testid="message-sticker" />;
  return (
    <button type="button" className="image-link" onClick={() => onOpen?.(file.url)} aria-label="Open photo">
      <img src={file.url} alt="Photo" loading="lazy" onLoad={onLoad} data-testid="message-image" />
    </button>
  );
}

function VideoFile({ path, onLoad }: { path: string; onLoad: () => void }) {
  const file = useFileUrl(path);
  if (file.state === "error") return <p className="file-missing">Video is not available</p>;
  if (file.state === "loading") return <div className="image-placeholder" aria-label="Loading video" />;
  return (
    <video
      className="video"
      src={file.url}
      controls
      preload="metadata"
      playsInline
      onLoadedMetadata={onLoad}
      data-testid="message-video"
    />
  );
}

function AudioFile({ path, voice }: { path: string; voice: boolean }) {
  const file = useFileUrl(path);
  if (file.state === "error") return <p className="file-missing">Audio is not available</p>;
  return (
    <div className="audio" data-testid="message-audio">
      <span className={`card-icon ${voice ? "voice" : ""}`}>
        <Icon name="mic" />
      </span>
      <div className="audio-main">
        <span className="card-sub">{voice ? "Voice message" : "Audio"}</span>
        {file.state === "ok" ? <audio src={file.url} controls preload="metadata" /> : <div className="audio-placeholder" />}
      </div>
    </div>
  );
}

function fileKind(filename: string, mime: string | null): string {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(filename)?.[1];
  if (extension) return extension.toUpperCase();
  return (mime?.split("/")[1] ?? "file").slice(0, 4).toUpperCase();
}

function DocumentFile({
  path,
  filename,
  size,
  mime,
}: {
  path: string;
  filename: string;
  size: number | null;
  mime: string | null;
}) {
  const file = useFileUrl(path);
  const kind = fileKind(filename, mime);
  const details = [kind, formatBytes(size)].filter(Boolean).join(" · ");
  const content = (
    <>
      <span className={`document-icon ${kind === "PDF" ? "pdf" : ""}`} aria-hidden="true">
        {kind.slice(0, 4)}
      </span>
      <span className="card-main">
        <span className="document-name">{filename}</span>
        <span className="card-sub" data-testid="document-details">
          {details}
        </span>
      </span>
    </>
  );
  if (file.state === "error") return <p className="file-missing">{filename} is not available</p>;
  if (file.state === "loading") return <div className="document muted">{content}</div>;
  return (
    <a
      className="document"
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      download={filename}
      data-testid="message-document"
    >
      {content}
      <span className="document-action">Download</span>
    </a>
  );
}

/** Full-screen photo preview. Close with the button, a click outside the photo, or Escape. */
export function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label="Photo preview" data-testid="lightbox" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <a className="button small" href={url} target="_blank" rel="noopener noreferrer">
          Open original
        </a>
        <button type="button" className="button small" onClick={onClose} aria-label="Close preview">
          <Icon name="close" size={16} /> Close
        </button>
      </div>
      <img src={url} alt="Photo" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

import { useEffect, useState } from "react";
import type { Message } from "../lib/types";
import { signedFileUrl } from "../lib/api";
import { formatTime } from "../lib/format";

const STATUS_LABEL: Record<string, string> = {
  sending: "Sending…",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
};

export function MessageBubble({ message, onMediaLoad }: { message: Message; onMediaLoad: () => void }) {
  const outgoing = message.direction === "out";
  const hasFile = Boolean(message.media_path);

  return (
    <div
      className={`message-row ${outgoing ? "out" : "in"}`}
      data-testid={outgoing ? "message-out" : "message-in"}
      data-status={message.status}
    >
      <div className={`bubble ${message.status === "failed" ? "failed" : ""}`}>
        {hasFile && message.type === "image" && <ImageFile path={message.media_path!} onLoad={onMediaLoad} />}
        {hasFile && message.type === "document" && (
          <DocumentFile path={message.media_path!} filename={message.media_filename ?? "Document"} />
        )}
        {!hasFile && (message.type === "image" || message.type === "document") && (
          <p className="file-missing">
            {message.type === "image" ? "Photo" : (message.media_filename ?? "Document")}
            {message.error ? "" : " (file is being fetched…)"}
          </p>
        )}

        {message.type === "template" ? (
          <p className="body template">
            <span className="chip">Template</span> {message.body}
          </p>
        ) : (
          message.body && <p className={`body ${message.type === "other" ? "muted" : ""}`}>{message.body}</p>
        )}

        {/* Incoming: a file that could not be stored. Outgoing: why WhatsApp refused the message. */}
        {message.error && (
          <p className="reason" data-testid="message-error">
            {outgoing ? `Not delivered: ${message.error}` : message.error}
          </p>
        )}

        <p className="meta">
          {outgoing && <span className="sender">{message.sent_by_staff_id ?? "Staff"}</span>}
          <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
          {outgoing && (
            <span className={`status ${message.status}`} data-testid="message-status">
              {STATUS_LABEL[message.status] ?? message.status}
            </span>
          )}
        </p>
      </div>
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

function ImageFile({ path, onLoad }: { path: string; onLoad: () => void }) {
  const file = useFileUrl(path);
  if (file.state === "error") return <p className="file-missing">Photo is not available</p>;
  if (file.state === "loading") return <div className="image-placeholder" aria-label="Loading photo" />;
  return (
    <a href={file.url} target="_blank" rel="noopener noreferrer" className="image-link">
      <img src={file.url} alt="Photo" loading="lazy" onLoad={onLoad} data-testid="message-image" />
    </a>
  );
}

function DocumentFile({ path, filename }: { path: string; filename: string }) {
  const file = useFileUrl(path);
  if (file.state === "error") return <p className="file-missing">{filename} is not available</p>;
  if (file.state === "loading") return <p className="document muted">{filename}</p>;
  return (
    <a
      className="document"
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      download={filename}
      data-testid="message-document"
    >
      <span className="document-icon" aria-hidden="true">
        PDF
      </span>
      <span className="document-name">{filename}</span>
      <span className="document-action">Download</span>
    </a>
  );
}

import { useEffect, useRef } from "react";
import { Icon } from "./Icons";

/** Escape closes a dialog; focus moves into it and returns to where it was. */
function useDialogBehaviour(onClose: () => void, locked: boolean) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !locked && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, locked]);
  return root;
}

interface DeleteProps {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** "Delete message?" for Delete for me. Nothing happens until the button is pressed. */
export function DeleteForMeDialog({ busy, error, onCancel, onConfirm }: DeleteProps) {
  const root = useDialogBehaviour(onCancel, busy);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()} ref={root}>
      <div className="dialog narrow" role="alertdialog" aria-labelledby="delete-title" aria-describedby="delete-text" data-testid="delete-dialog">
        <div className="dialog-body confirm-body">
          <h3 id="delete-title">Delete message?</h3>
          <p id="delete-text" className="muted">
            This message will be removed from your application. The original WhatsApp message will remain unchanged.
          </p>
          {error && (
            <p className="notice error" role="alert" data-testid="delete-error">
              {error}
            </p>
          )}
          <div className="confirm-buttons">
            <button type="button" className="button" onClick={onCancel} disabled={busy} data-autofocus data-testid="delete-cancel">
              Cancel
            </button>
            <button type="button" className="button primary" onClick={onConfirm} disabled={busy} data-testid="delete-confirm">
              {busy ? "Deleting…" : error ? "Try again" : "Delete for me"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Delete for everyone is not possible with the Cloud API. This only explains; it never calls anything. */
export function DeleteForEveryoneDialog({ onClose, onDeleteForMe }: { onClose: () => void; onDeleteForMe: () => void }) {
  const root = useDialogBehaviour(onClose, false);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} ref={root}>
      <div className="dialog narrow" role="dialog" aria-labelledby="everyone-title" data-testid="everyone-dialog">
        <div className="dialog-body confirm-body">
          <h3 id="everyone-title">
            <Icon name="info" size={20} /> Delete for everyone is unavailable
          </h3>
          <p className="muted">Delete for everyone is not supported through the current WhatsApp Cloud API integration.</p>
          <p className="muted">
            The message can only be removed from this application’s view using Delete for me. The person you are
            chatting with will still see it in WhatsApp.
          </p>
          <div className="confirm-buttons">
            <button type="button" className="button" onClick={onClose} data-autofocus data-testid="everyone-close">
              Close
            </button>
            <button type="button" className="button primary" onClick={onDeleteForMe} data-testid="everyone-delete-me">
              Delete for me instead
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

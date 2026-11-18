import { useState } from "react";

/**
 * Shows a temporary password exactly once. It is not stored anywhere readable; closing the dialog
 * discards it. Share it with the client through a private channel, never through a group chat.
 */
export function CredentialDialog({
  staffId,
  password,
  heading,
  onClose,
}: {
  staffId: string;
  password: string;
  heading: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`Staff ID: ${staffId}\nTemporary password: ${password}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="dialog-backdrop">
      <div className="dialog narrow" role="alertdialog" aria-labelledby="cred-title" data-testid="credential-dialog">
        <div className="dialog-body confirm-body">
          <h3 id="cred-title">{heading}</h3>
          <p className="muted">
            This password is shown <strong>only once</strong>. The client must change it at the first sign-in.
          </p>
          <dl className="credential">
            <dt>Staff ID</dt>
            <dd data-testid="credential-staff-id">{staffId}</dd>
            <dt>Temporary password</dt>
            <dd data-testid="credential-password">{password}</dd>
          </dl>
          <div className="confirm-buttons">
            <button type="button" className="button" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="button primary" onClick={onClose} data-testid="credential-close">
              I have saved it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

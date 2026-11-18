import { useState } from "react";
import { supabase } from "../lib/supabase";
import { completePasswordChange } from "../lib/api";
import { errorMessage } from "../lib/format";
import { brand } from "../brand";
import { Icon } from "./Icons";

/**
 * Shown right after the first sign-in with a temporary password (set by the administrator when the account
 * was created or reset). Nothing else in the app is reachable until the password has been changed.
 */
export function ForcePasswordChange({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== again) return setError("The two passwords are not the same.");
    setBusy(true);
    setError(null);
    try {
      const { data } = await supabase.auth.getUser();
      const email = data.user?.email;
      await completePasswordChange(password);
      // The server lifted the lock and ended the old sessions: sign in again with the new password for a fresh one.
      if (email) {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw new Error("Your password was saved. Sign in again with the new password.");
      }
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center-page">
      <form className="card login" onSubmit={submit} noValidate data-testid="force-password">
        <span className="login-logo" aria-hidden="true">
          <Icon name="chat" size={34} />
        </span>
        <h1>Choose your password</h1>
        <p className="muted">
          You signed in with a temporary password. Choose your own to start using {brand.name}.
        </p>
        <label className="field">
          <span>New password (at least 8 characters)</span>
          <input name="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
        </label>
        <label className="field">
          <span>Repeat the new password</span>
          <input name="repeat-password" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </label>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary wide" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save password"}
        </button>
        <button type="button" className="button wide" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </form>
    </main>
  );
}

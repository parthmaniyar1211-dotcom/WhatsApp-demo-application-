import { useState } from "react";
import { supabase } from "../lib/supabase";
import { OWNER_EMAIL } from "../lib/api";
import { useOnline } from "../hooks/useBrowserState";
import { Icon } from "./Icons";

export function LoginPage() {
  const online = useOnline();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: OWNER_EMAIL, password });
    setBusy(false);
    if (!signInError) return; // App switches to the chats when the session appears
    if (signInError.status === 400) setError("Wrong password.");
    else if (signInError.status === 429) setError("Too many attempts. Wait a minute and try again.");
    else setError(navigator.onLine ? "Could not sign in. Try again." : "You are offline.");
  }

  return (
    <main className="center-page">
      <form className="card login" onSubmit={submit} noValidate>
        <span className="login-logo" aria-hidden="true">
          <Icon name="chat" size={34} />
        </span>
        <h1>Chats</h1>
        <p className="muted">Send and receive WhatsApp messages from your computer.</p>
        {!online && <p className="notice warning">You are offline.</p>}
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </label>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary wide" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

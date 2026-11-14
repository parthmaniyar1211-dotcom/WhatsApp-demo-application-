import { useState } from "react";
import { supabase } from "../lib/supabase";
import { staffEmail } from "../lib/api";
import { useOnline } from "../hooks/useBrowserState";

export function LoginPage() {
  const online = useOnline();
  const [staffId, setStaffId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const email = staffEmail(staffId);
    if (!email) {
      setError("Enter your staff ID, for example EMP1001.");
      return;
    }
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (!signInError) return; // App switches to the inbox when the session appears
    if (signInError.status === 400) setError("Wrong staff ID or password, or the account is disabled.");
    else if (signInError.status === 429) setError("Too many attempts. Wait a minute and try again.");
    else setError(navigator.onLine ? "Could not sign in. Try again." : "You are offline.");
  }

  return (
    <main className="center-page">
      <form className="card login" onSubmit={submit} noValidate>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>Shared Inbox</h1>
        </div>
        <p className="muted">Sign in with the staff ID your admin gave you.</p>

        {!online && <p className="notice warning">You are offline.</p>}

        <label className="field">
          <span>Staff ID</span>
          <input
            name="staff-id"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            placeholder="EMP1001"
            autoCapitalize="characters"
            autoComplete="username"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
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
        <p className="muted small">No account? Accounts are created by an admin. There is no public signup.</p>
      </form>
    </main>
  );
}

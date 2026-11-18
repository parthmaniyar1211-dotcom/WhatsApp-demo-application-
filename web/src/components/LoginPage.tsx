import { useState } from "react";
import { supabase } from "../lib/supabase";
import { STAFF_ID_PATTERN, staffEmail } from "../lib/api";
import { brand } from "../brand";
import { useOnline } from "../hooks/useBrowserState";
import { Icon } from "./Icons";

const REMEMBER_KEY = "last-staff-id";

function remembered(): string {
  try {
    return localStorage.getItem(REMEMBER_KEY) ?? "";
  } catch {
    return ""; // private mode: just type it
  }
}

export function LoginPage() {
  const online = useOnline();
  const [staffId, setStaffId] = useState(remembered);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const id = staffId.trim();
    if (!STAFF_ID_PATTERN.test(id)) {
      setError("Enter your Staff ID (3 to 20 letters or digits).");
      return;
    }
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: staffEmail(id), password });
    setBusy(false);
    if (!signInError) {
      try {
        localStorage.setItem(REMEMBER_KEY, id.toUpperCase());
      } catch {
        // not remembered
      }
      return; // App switches to the chats when the session appears
    }
    // One message for "unknown Staff ID" and "wrong password": the form must not reveal which IDs exist.
    if (signInError.status === 400) setError("Wrong Staff ID or password.");
    else if (signInError.status === 429) setError("Too many attempts. Wait a minute and try again.");
    else if (signInError.status === 403) setError("This account is switched off. Contact your administrator.");
    else setError(navigator.onLine ? "Could not sign in. Try again." : "You are offline.");
  }

  return (
    <main className="center-page">
      <form className="card login" onSubmit={submit} noValidate>
        <span className="login-logo" aria-hidden="true">
          <Icon name="chat" size={34} />
        </span>
        <h1 data-testid="brand-name">{brand.name}</h1>
        <p className="muted">{brand.tagline}</p>
        {!online && <p className="notice warning">You are offline.</p>}
        <label className="field">
          <span>Staff ID</span>
          <input
            name="staffId"
            type="text"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            autoComplete="username"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus={!staffId}
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
            autoFocus={!!staffId}
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
        <p className="muted small login-footer">{brand.company}</p>
      </form>
    </main>
  );
}

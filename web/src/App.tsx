import { useEffect } from "react";
import { isConfigured, supabase } from "./lib/supabase";
import { clearFileUrlCache } from "./lib/api";
import { useProfile, useSession } from "./hooks/useAuth";
import { LoginPage } from "./components/LoginPage";
import { Workspace } from "./components/Workspace";

export function App() {
  const { session, ready } = useSession();
  const userId = session?.user.id ?? null;
  const { profile, reload } = useProfile(userId);

  // Signed file links belong to the previous user: forget them on sign out.
  useEffect(() => {
    if (!userId) clearFileUrlCache();
  }, [userId]);

  if (!isConfigured) {
    return (
      <CenterCard title="Setup needed">
        <p>
          Copy <code>web/.env.example</code> to <code>web/.env</code>, fill in <code>VITE_SUPABASE_URL</code> and{" "}
          <code>VITE_SUPABASE_ANON_KEY</code>, then restart <code>npm run dev</code>.
        </p>
      </CenterCard>
    );
  }
  if (!ready) return <FullPageSpinner label="Loading" />;
  if (!session || !userId) return <LoginPage />;

  if (profile.state === "loading") return <FullPageSpinner label="Loading your account" />;
  if (profile.state === "error") {
    return (
      <CenterCard title="Could not load your account">
        <p className="error-text">{profile.message}</p>
        <div className="row">
          <button className="button primary" onClick={reload}>
            Try again
          </button>
          <button className="button" onClick={() => void supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </CenterCard>
    );
  }
  if (profile.state === "not-staff") {
    return (
      <CenterCard title="Account not active">
        <p>This login is disabled or is not a staff account. Ask your admin for access.</p>
        <button className="button primary" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </CenterCard>
    );
  }

  return <Workspace key={userId} me={profile.staff} />;
}

function CenterCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="center-page">
      <div className="card">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function FullPageSpinner({ label }: { label: string }) {
  return (
    <main className="center-page" role="status" aria-live="polite">
      <div className="spinner" />
      <p className="muted">{label}…</p>
    </main>
  );
}

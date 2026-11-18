import { useEffect, useState } from "react";
import { isConfigured, supabase } from "./lib/supabase";
import "./lib/settings"; // applies the saved theme before the first paint
import { clearFileUrlCache } from "./lib/api";
import { useProfile, useSession } from "./hooks/useAuth";
import { useTenantContext } from "./hooks/useTenantContext";
import { AdminConsole } from "./admin/AdminConsole";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ForcePasswordChange } from "./components/ForcePasswordChange";
import { LoginPage } from "./components/LoginPage";
import { Workspace } from "./components/Workspace";

export function App() {
  const { session, ready } = useSession();
  const userId = session?.user.id ?? null;
  const { profile, reload } = useProfile(userId);
  const { context: tenant, reload: reloadTenant } = useTenantContext(userId);
  const [view, setView] = useState<"inbox" | "admin" | null>(null);

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
      <CenterCard title="Login not active">
        <p>This login is not active.</p>
        <button className="button primary" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </CenterCard>
    );
  }

  // A login that still has the temporary password must choose its own before anything else.
  // The DATABASE enforces this (it returns no data to such a login); this screen is only how the person gets out of it.
  if (profile.staff.must_change_password) return <ForcePasswordChange onDone={() => { reload(); reloadTenant(); }} />;

  if (tenant.state === "loading") return <FullPageSpinner label="Loading your account" />;
  if (tenant.state === "error") {
    return (
      <CenterCard title="Could not load your account">
        <p className="error-text">{tenant.message}</p>
        <div className="row">
          <button className="button primary" onClick={reloadTenant}>
            Try again
          </button>
          <button className="button" onClick={() => void supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </CenterCard>
    );
  }
  const hasTenant = tenant.state === "ok";
  const isAdmin = profile.staff.role === "admin";

  // Platform admins see the console; without a client account of their own it is the only screen they have.
  if (isAdmin && (view ? view === "admin" : !hasTenant)) {
    return <AdminConsole key={userId} me={profile.staff} onBackToChats={hasTenant ? () => setView("inbox") : null} />;
  }
  if (!hasTenant) {
    return (
      <CenterCard title="No client account">
        <p>This login is not connected to a client account, or the account is switched off. Contact your administrator.</p>
        <button className="button primary" onClick={() => void supabase.auth.signOut()}>
          Sign out
        </button>
      </CenterCard>
    );
  }

  return (
    <>
      <Workspace key={userId} me={profile.staff} onOpenAdmin={isAdmin ? () => setView("admin") : undefined} />
      <ConnectionBanner connections={tenant.connections} onRetry={reloadTenant} />
    </>
  );
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

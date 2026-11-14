import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { Staff } from "../lib/types";
import { errorMessage } from "../lib/format";

/** The Supabase session. `ready` is false until the stored session has been checked. */
export function useSession(): { session: Session | null; ready: boolean } {
  const [state, setState] = useState<{ session: Session | null; ready: boolean }>({ session: null, ready: false });
  useEffect(() => {
    // Fires once with the stored session (INITIAL_SESSION), then on sign in / out / token refresh.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setState({ session, ready: true }));
    return () => data.subscription.unsubscribe();
  }, []);
  return state;
}

export type Profile =
  | { state: "loading" }
  | { state: "ok"; staff: Staff }
  | { state: "not-staff" } // signed in, but no staff row or disabled
  | { state: "error"; message: string };

/** The signed-in user's staff row (role, staff ID). */
export function useProfile(userId: string | null): { profile: Profile; reload: () => void } {
  const [result, setResult] = useState<{ userId: string; profile: Profile } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    supabase
      .from("staff")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        let profile: Profile;
        if (error) profile = { state: "error", message: errorMessage(error) };
        else if (!data || (data as Staff).disabled) profile = { state: "not-staff" };
        else profile = { state: "ok", staff: data as Staff };
        setResult({ userId, profile });
      });
    return () => {
      cancelled = true;
    };
  }, [userId, nonce]);

  const reload = useCallback(() => {
    setResult(null);
    setNonce((n) => n + 1);
  }, []);

  const profile: Profile = result && result.userId === userId ? result.profile : { state: "loading" };
  return { profile, reload };
}

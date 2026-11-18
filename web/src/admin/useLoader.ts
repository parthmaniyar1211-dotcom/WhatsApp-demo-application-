import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/format";

export type Loaded<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error"; message: string };

/** Loads data once and again on demand. Errors are shown, never swallowed. */
export function useLoader<T>(load: () => Promise<T>): { result: Loaded<T>; reload: () => void } {
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => !cancelled && setResult({ state: "ok", data }),
      (err) => !cancelled && setResult({ state: "error", message: errorMessage(err) }),
    );
    return () => {
      cancelled = true;
    };
    // `load` is a stable module-level function in every caller
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { result, reload };
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  return Number.isNaN(ms) ? null : Math.floor(ms / 86_400_000);
}

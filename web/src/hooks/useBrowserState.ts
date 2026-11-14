import { useEffect, useState, useSyncExternalStore } from "react";

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/** False while the browser reports no network connection. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine);
}

function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

/** True while the tab is in the foreground. */
export function useVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");
}

function subscribeHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export type Route =
  | { page: "inbox"; conversationId: string | null; messageId: string | null }
  | { page: "admin" };

function parseRoute(hash: string): Route {
  if (hash === "#/admin") return { page: "admin" };
  const match = /^#\/c\/([0-9a-f-]{36})(?:\/m\/([0-9a-f-]{36}))?$/i.exec(hash);
  return { page: "inbox", conversationId: match ? match[1] : null, messageId: match?.[2] ?? null };
}

/**
 * Minimal hash routing, so the phone's back button closes a chat:
 * #/c/<conversation id>, #/c/<conversation id>/m/<message id> (jump to a message), #/admin.
 */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return parseRoute(hash);
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

/** A clock that ticks every intervalMs, for things like the 24-hour window. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

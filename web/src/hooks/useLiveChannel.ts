import { useEffect, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

export type LiveStatus = "connecting" | "live" | "reconnecting";
export type Change = RealtimePostgresChangesPayload<Record<string, unknown>>;

export interface TableSpec {
  table: string;
  filter?: string;
}

const RETRY_MS = 5000;

/**
 * Subscribes to Postgres changes over Supabase Realtime and keeps the subscription alive.
 *
 * - onChange runs for every insert / update / delete.
 * - onSync runs every time the channel (re)connects, when the browser comes back online
 *   and when the tab becomes visible again. Callers reload their data there, so nothing
 *   that happened while disconnected is missed.
 *
 * Pass name = null to stay unsubscribed.
 */
export function useLiveChannel(
  name: string | null,
  tables: TableSpec[],
  onChange: (change: Change) => void,
  onSync: () => void,
): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [attempt, setAttempt] = useState(0);
  const onChangeRef = useRef(onChange);
  const onSyncRef = useRef(onSync);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSyncRef.current = onSync;
  });

  const tablesKey = JSON.stringify(tables);

  useEffect(() => {
    if (!name) return;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let subscribed = false;

    // A unique topic per subscription, so a new channel never collides with one being removed.
    const channel = supabase.channel(`${name}:${attempt}:${Math.random().toString(36).slice(2, 8)}`);
    for (const spec of JSON.parse(tablesKey) as TableSpec[]) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: spec.table, ...(spec.filter ? { filter: spec.filter } : {}) },
        (change) => onChangeRef.current(change as Change),
      );
    }

    // The server confirms the database subscription a moment after the join (it can take
    // seconds after a server restart). Changes in that gap are not delivered, so reload again.
    channel.on("system", {}, (message: { extension?: string; status?: string }) => {
      if (!stopped && message.extension === "postgres_changes" && message.status === "ok") onSyncRef.current();
    });

    channel.subscribe((state) => {
      if (stopped) return;
      if (state === "SUBSCRIBED") {
        subscribed = true;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        setStatus("live");
        onSyncRef.current();
        return;
      }
      // CHANNEL_ERROR, TIMED_OUT or CLOSED. The client retries by itself; if that has
      // not worked after a few seconds, throw the channel away and build a new one.
      subscribed = false;
      setStatus("reconnecting");
      retryTimer ??= setTimeout(() => {
        if (!stopped) setAttempt((n) => n + 1);
      }, RETRY_MS);
    });

    const resync = () => {
      if (!stopped && subscribed && document.visibilityState === "visible") onSyncRef.current();
    };
    window.addEventListener("online", resync);
    document.addEventListener("visibilitychange", resync);

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      window.removeEventListener("online", resync);
      document.removeEventListener("visibilitychange", resync);
      void supabase.removeChannel(channel);
    };
  }, [name, tablesKey, attempt]);

  return name ? status : "connecting";
}

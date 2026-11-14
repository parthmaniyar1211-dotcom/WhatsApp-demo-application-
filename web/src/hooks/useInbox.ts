import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Conversation, Staff } from "../lib/types";
import { errorMessage } from "../lib/format";
import { type Change, type LiveStatus, useLiveChannel } from "./useLiveChannel";

const TABLES = [{ table: "conversations" }, { table: "wa_messages" }];
const MAX_CONVERSATIONS = 500;

function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
}

function applyConversationChange(list: Conversation[], change: Change): Conversation[] {
  if (change.eventType === "DELETE") {
    const id = (change.old as { id?: string }).id;
    return list.filter((c) => c.id !== id);
  }
  const row = change.new as unknown as Conversation;
  return sortConversations([...list.filter((c) => c.id !== row.id), row]);
}

export interface Inbox {
  conversations: Conversation[];
  unread: Record<string, number>;
  staff: Record<string, Staff>;
  loaded: boolean;
  error: string | null;
  live: LiveStatus;
  reload: () => void;
  markRead: (conversationId: string) => void;
}

/** The conversation list, unread counts and staff directory, kept live through Realtime. */
export function useInbox(userId: string): Inbox {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [staff, setStaff] = useState<Record<string, Staff>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Changes that arrive while a full reload is in flight are replayed on top of it,
  // so a slow reload can never overwrite something newer.
  const pending = useRef<{ loads: number; changes: Change[] }>({ loads: 0, changes: [] });
  const unreadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadUnread = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc("unread_counts");
    if (rpcError) return; // the next sync will try again
    const counts: Record<string, number> = {};
    for (const row of (data ?? []) as { conversation_id: string; unread: number }[]) {
      counts[row.conversation_id] = Number(row.unread);
    }
    setUnread(counts);
  }, []);

  const reload = useCallback(async () => {
    pending.current.loads++;
    const [conversationResult, staffResult] = await Promise.all([
      supabase.from("conversations").select("*").order("last_message_at", { ascending: false }).limit(MAX_CONVERSATIONS),
      supabase.from("staff").select("*"),
      loadUnread(),
    ]);
    // Replay everything that arrived since the oldest reload still in flight started.
    const queued = [...pending.current.changes];
    if (--pending.current.loads === 0) pending.current.changes = [];

    const failure = conversationResult.error ?? staffResult.error;
    if (failure) {
      setError(navigator.onLine ? errorMessage(failure) : "You are offline.");
      return;
    }
    let list = (conversationResult.data ?? []) as Conversation[];
    for (const change of queued) list = applyConversationChange(list, change);
    setConversations(list);
    setStaff(Object.fromEntries(((staffResult.data ?? []) as Staff[]).map((s) => [s.user_id, s])));
    setError(null);
    setLoaded(true);
  }, [loadUnread]);

  const onChange = useCallback(
    (change: Change) => {
      if (change.table === "conversations") {
        if (pending.current.loads > 0) pending.current.changes.push(change);
        setConversations((list) => applyConversationChange(list, change));
      } else if (change.table === "wa_messages" && change.eventType === "INSERT") {
        // A new incoming message changes the unread counts. Ask the server (debounced)
        // instead of counting locally, so the badge can never drift.
        if ((change.new as { direction?: string }).direction === "in") {
          clearTimeout(unreadTimer.current);
          unreadTimer.current = setTimeout(() => void loadUnread(), 250);
        }
      }
    },
    [loadUnread],
  );

  useEffect(() => () => clearTimeout(unreadTimer.current), []);

  const live = useLiveChannel(`inbox:${userId}`, TABLES, onChange, reload);

  const markRead = useCallback((conversationId: string) => {
    setUnread((counts) => (counts[conversationId] ? { ...counts, [conversationId]: 0 } : counts));
    void supabase.rpc("mark_conversation_read", { p_conversation_id: conversationId }).then(({ error: rpcError }) => {
      if (rpcError) console.warn("Could not mark the conversation as read");
    });
  }, []);

  return { conversations, unread, staff, loaded, error, live, reload, markRead };
}

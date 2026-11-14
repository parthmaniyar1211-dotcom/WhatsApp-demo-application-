import { useCallback, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Message } from "../lib/types";
import { errorMessage } from "../lib/format";
import { type Change, type LiveStatus, useLiveChannel } from "./useLiveChannel";

const PAGE_SIZE = 100;

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

function applyChange(list: Message[], change: Change): Message[] {
  if (change.eventType === "DELETE") {
    const id = (change.old as { id?: string }).id;
    return list.filter((m) => m.id !== id);
  }
  return mergeMessages(list, [change.new as unknown as Message]);
}

export interface MessageStream {
  messages: Message[];
  loaded: boolean;
  error: string | null;
  live: LiveStatus;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  reload: () => void;
  /** Adds or replaces a message right away (used for the reply returned by send-whatsapp). */
  upsert: (message: Message) => void;
}

/**
 * The live message stream of one conversation.
 * Render the component that uses this with key={conversationId} so state resets between chats.
 */
export function useMessages(conversationId: string): MessageStream {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const pending = useRef<{ loads: number; changes: Change[] }>({ loads: 0, changes: [] });
  const firstLoad = useRef(true);

  const reload = useCallback(async () => {
    pending.current.loads++;
    const { data, error: queryError } = await supabase
      .from("wa_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    // Replay everything that arrived since the oldest reload still in flight started.
    const queued = [...pending.current.changes];
    if (--pending.current.loads === 0) pending.current.changes = [];

    if (queryError) {
      setError(navigator.onLine ? errorMessage(queryError) : "You are offline.");
      return;
    }
    const latest = (data ?? []) as Message[];
    // Merge (not replace): keeps earlier pages the user already loaded.
    setMessages((current) => {
      let list = mergeMessages(current, latest);
      for (const change of queued) list = applyChange(list, change);
      return list;
    });
    if (firstLoad.current) {
      firstLoad.current = false;
      setHasEarlier(latest.length === PAGE_SIZE);
    }
    setError(null);
    setLoaded(true);
  }, [conversationId]);

  const onChange = useCallback((change: Change) => {
    if (pending.current.loads > 0) pending.current.changes.push(change);
    setMessages((list) => applyChange(list, change));
  }, []);

  const live = useLiveChannel(
    `messages:${conversationId}`,
    [{ table: "wa_messages", filter: `conversation_id=eq.${conversationId}` }],
    onChange,
    reload,
  );

  const oldest = messages[0]?.created_at;
  const loadEarlier = useCallback(async () => {
    if (!oldest) return;
    setLoadingEarlier(true);
    const { data, error: queryError } = await supabase
      .from("wa_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .lt("created_at", oldest)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    setLoadingEarlier(false);
    if (queryError) {
      setError(errorMessage(queryError));
      return;
    }
    const earlier = (data ?? []) as Message[];
    setHasEarlier(earlier.length === PAGE_SIZE);
    setMessages((current) => mergeMessages(current, earlier));
  }, [conversationId, oldest]);

  const upsert = useCallback((message: Message) => {
    setMessages((current) => mergeMessages(current, [message]));
  }, []);

  return { messages, loaded, error, live, hasEarlier, loadingEarlier, loadEarlier, reload, upsert };
}

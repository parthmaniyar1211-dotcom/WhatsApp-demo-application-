import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Message } from "../lib/types";
import { errorMessage } from "../lib/format";
import { type Change, type LiveStatus, useLiveChannel } from "./useLiveChannel";

export const PAGE_SIZE = 50;

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
  /** Makes sure an older message is loaded (with everything after it). False when it does not exist. */
  ensureLoaded: (messageId: string) => Promise<boolean>;
}

/**
 * The live message stream of one conversation, newest page first, older pages on demand.
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
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });
  const busyEarlier = useRef(false);

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

  const loadEarlier = useCallback(async () => {
    const oldest = messagesRef.current[0]?.created_at;
    if (!oldest || busyEarlier.current) return;
    busyEarlier.current = true;
    setLoadingEarlier(true);
    const { data, error: queryError } = await supabase
      .from("wa_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .lt("created_at", oldest)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    busyEarlier.current = false;
    setLoadingEarlier(false);
    if (queryError) {
      setError(errorMessage(queryError));
      return;
    }
    const earlier = (data ?? []) as Message[];
    setHasEarlier(earlier.length === PAGE_SIZE);
    setMessages((current) => mergeMessages(current, earlier));
  }, [conversationId]);

  const upsert = useCallback((message: Message) => {
    setMessages((current) => mergeMessages(current, [message]));
  }, []);

  const ensureLoaded = useCallback(
    async (messageId: string) => {
      if (messagesRef.current.some((m) => m.id === messageId)) return true;
      const target = await supabase
        .from("wa_messages")
        .select("*")
        .eq("id", messageId)
        .eq("conversation_id", conversationId)
        .maybeSingle();
      if (target.error || !target.data) return false;
      // Load everything from that message up to what is already shown, so the list has no gap.
      const oldest = messagesRef.current[0]?.created_at;
      let query = supabase
        .from("wa_messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .gte("created_at", (target.data as Message).created_at)
        .order("created_at", { ascending: true })
        .limit(1000);
      if (oldest) query = query.lt("created_at", oldest);
      const between = await query;
      if (between.error) return false;
      setMessages((current) => mergeMessages(current, [target.data as Message, ...((between.data ?? []) as Message[])]));
      setHasEarlier(true);
      return true;
    },
    [conversationId],
  );

  return { messages, loaded, error, live, hasEarlier, loadingEarlier, loadEarlier, reload, upsert, ensureLoaded };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Conversation, Message, MessageFlag, Staff, VisibleLast } from "../lib/types";
import { customerLabel, errorMessage, messageSummary } from "../lib/format";
import { deleteMessageForMe, loadFlags, loadVisibleLastMessages, restoreMessageForMe, setMessageFlags } from "../lib/api";
import { announceMessage } from "../lib/notify";
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

export type Flags = Record<string, { starred: boolean; hidden: boolean }>;

export interface Inbox {
  conversations: Conversation[];
  unread: Record<string, number>;
  staff: Record<string, Staff>;
  /** This user's starred / deleted-for-me messages, by message id. */
  flags: Flags;
  /**
   * The newest message of each chat that this user has NOT deleted, by conversation id.
   * Null while unavailable (server without the function): the list then falls back to the server preview.
   */
  previews: Record<string, VisibleLast> | null;
  /** Chats whose newest message changed after the previews were loaded: show the server preview until refreshed. */
  previewDirty: Set<string>;
  loaded: boolean;
  error: string | null;
  live: LiveStatus;
  reload: () => void;
  markRead: (conversationId: string) => void;
  setFlag: (messageId: string, patch: Partial<{ starred: boolean; hidden: boolean }>) => Promise<void>;
  /** Delete for me: resolves only after the server confirmed, then the message disappears. */
  deleteForMe: (messageId: string) => Promise<void>;
  /** Undo / show again. */
  restoreForMe: (messageId: string) => Promise<void>;
}

/**
 * The conversation list, unread counts, staff directory and the user's message flags,
 * kept live through Realtime. `openId` is the chat the user is looking at (no alert for it).
 */
export function useInbox(userId: string, openId: string | null, onOpenConversation: (id: string) => void): Inbox {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [staff, setStaff] = useState<Record<string, Staff>>({});
  const [flags, setFlags] = useState<Flags>({});
  const [previews, setPreviews] = useState<Record<string, VisibleLast> | null>(null);
  const [previewDirty, setPreviewDirty] = useState<Set<string>>(new Set());
  const dirtyRef = useRef<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Changes that arrive while a full reload is in flight are replayed on top of it,
  // so a slow reload can never overwrite something newer.
  const pending = useRef<{ loads: number; changes: Change[] }>({ loads: 0, changes: [] });
  const unreadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Latest values for the notification callback (which must not re-subscribe the channel).
  const latest = useRef({ conversations, openId, onOpenConversation });
  useEffect(() => {
    latest.current = { conversations, openId, onOpenConversation };
  });

  const loadUnread = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc("unread_counts");
    if (rpcError) return; // the next sync will try again
    const counts: Record<string, number> = {};
    for (const row of (data ?? []) as { conversation_id: string; unread: number }[]) {
      counts[row.conversation_id] = Number(row.unread);
    }
    setUnread(counts);
  }, []);

  const loadPreviews = useCallback(async () => {
    const dirtyAtStart = new Set(dirtyRef.current);
    const rows = await loadVisibleLastMessages();
    setPreviews(rows ? Object.fromEntries(rows.map((r) => [r.conversation_id, r])) : null);
    // Chats that changed while this request was running stay dirty until the next refresh.
    for (const id of dirtyAtStart) dirtyRef.current.delete(id);
    setPreviewDirty(new Set(dirtyRef.current));
  }, []);

  const markDirty = useCallback((conversationId: string) => {
    dirtyRef.current.add(conversationId);
    setPreviewDirty(new Set(dirtyRef.current));
  }, []);

  const reload = useCallback(async () => {
    pending.current.loads++;
    const [conversationResult, staffResult, flagRows] = await Promise.all([
      supabase.from("conversations").select("*").order("last_message_at", { ascending: false }).limit(MAX_CONVERSATIONS),
      supabase.from("staff").select("*"),
      loadFlags().catch(() => null),
      loadUnread(),
      loadPreviews(),
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
    if (flagRows) {
      setFlags(Object.fromEntries(flagRows.map((f: MessageFlag) => [f.message_id, { starred: f.starred, hidden: f.hidden }])));
    }
    setError(null);
    setLoaded(true);
  }, [loadUnread, loadPreviews]);

  const onChange = useCallback(
    (change: Change) => {
      if (change.table === "conversations") {
        if (pending.current.loads > 0) pending.current.changes.push(change);
        setConversations((list) => applyConversationChange(list, change));
        if (change.eventType !== "DELETE") {
          // The newest message of this chat changed (a message arrived or was sent): refresh its preview.
          markDirty((change.new as { id: string }).id);
          clearTimeout(unreadTimer.current);
          unreadTimer.current = setTimeout(() => {
            void loadUnread();
            void loadPreviews();
          }, 250);
        }
      } else if (change.table === "wa_messages" && change.eventType === "INSERT") {
        const message = change.new as unknown as Message;
        if (message.direction !== "in") return;
        // A new incoming message changes the unread counts. Ask the server (debounced)
        // instead of counting locally, so the badge can never drift.
        clearTimeout(unreadTimer.current);
        unreadTimer.current = setTimeout(() => {
          void loadUnread();
          void loadPreviews();
        }, 250);

        // Sound / browser notification, unless the user is looking at that chat right now.
        const { conversations: known, openId: open, onOpenConversation: openConversation } = latest.current;
        const conversation = known.find((c) => c.id === message.conversation_id);
        announceMessage({
          title: conversation ? customerLabel(conversation) : "New WhatsApp message",
          body: messageSummary(message).slice(0, 120),
          tag: message.conversation_id,
          quiet: open === message.conversation_id && document.visibilityState === "visible",
          onClick: () => openConversation(message.conversation_id),
        });
      }
    },
    [loadUnread, loadPreviews, markDirty],
  );

  useEffect(() => () => clearTimeout(unreadTimer.current), []);

  const live = useLiveChannel(`inbox:${userId}`, TABLES, onChange, reload);

  const markRead = useCallback((conversationId: string) => {
    setUnread((counts) => (counts[conversationId] ? { ...counts, [conversationId]: 0 } : counts));
    void supabase.rpc("mark_conversation_read", { p_conversation_id: conversationId }).then(({ error: rpcError }) => {
      if (rpcError) console.warn("Could not mark the conversation as read");
    });
  }, []);

  const flagsRef = useRef(flags);
  useEffect(() => {
    flagsRef.current = flags;
  });
  const setFlag = useCallback(async (messageId: string, patch: Partial<{ starred: boolean; hidden: boolean }>) => {
    const before = flagsRef.current[messageId] ?? { starred: false, hidden: false };
    const next = { ...before, ...patch };
    setFlags((all) => ({ ...all, [messageId]: next }));
    try {
      await setMessageFlags(messageId, next.starred, next.hidden);
    } catch (err) {
      setFlags((all) => ({ ...all, [messageId]: before })); // undo
      throw err;
    }
  }, []);

  const deleteForMe = useCallback(
    async (messageId: string) => {
      await deleteMessageForMe(messageId);
      // Only after the server said yes: hide it here and refresh the chat-list preview.
      setFlags((all) => ({ ...all, [messageId]: { starred: all[messageId]?.starred ?? false, hidden: true } }));
      void loadPreviews();
    },
    [loadPreviews],
  );

  const restoreForMe = useCallback(
    async (messageId: string) => {
      await restoreMessageForMe(messageId);
      setFlags((all) => ({ ...all, [messageId]: { starred: all[messageId]?.starred ?? false, hidden: false } }));
      void loadPreviews();
    },
    [loadPreviews],
  );

  return {
    conversations, unread, staff, flags, previews, previewDirty, loaded, error, live, reload, markRead, setFlag, deleteForMe, restoreForMe,
  };
}

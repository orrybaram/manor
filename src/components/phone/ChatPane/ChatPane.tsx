import { useCallback, useRef, useState } from "react";
import type { ChatEntry, ChatHistory } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useAppStore } from "../../../store/app-store";
import { useHostStore } from "../../../store/host-store";
import { Button } from "../../ui/Button/Button";
import {
  answerablePickerId,
  endsMenuHandoff,
  groupEntries,
  mergeHistory,
  upsertEntry,
} from "./chat-entries";
import { ChatComposer } from "./ChatComposer";
import { ChatEntryView } from "./ChatEntryView";
import { ChatThinking } from "./ChatThinking";
import styles from "./ChatPane.module.css";
import { endMenuHandoff, usePaneChatViewStore } from "./usePaneChatView";

type Unavailable = Extract<ChatHistory, { ok: false }>["reason"] | "error";

const UNAVAILABLE_NOTE: Record<Unavailable, string> = {
  "no-agent": "This pane has no Claude session to show as a chat.",
  "no-transcript": "Claude hasn't written a transcript for this session yet.",
  remote: "Chat isn't available for agents on a remote host yet.",
  "host-offline": "This host is offline. The chat will catch up when it reconnects.",
  error: "Couldn't load this chat.",
};

/**
 * While the host is offline, history is fetched again this often, besides
 * on a host status change and on the next entry: the host can come back a
 * moment before its transcript can be read.
 */
const OFFLINE_RETRY_MS = 5_000;

/** Within this many px of the bottom counts as "at the bottom". */
const STICK_SLOP_PX = 48;

type ChatPaneProps = {
  paneId: string;
  /** The transcript this chat reads (it is keyed by it). */
  transcript: string;
  /** The terminal is showing instead. The chat stays mounted and subscribed. */
  hidden: boolean;
  onShowTerminal: () => void;
};

/**
 * A phone's chat view of a Claude pane (ADR-215 D7): the pane's transcript as
 * a conversation, its pickers as cards that answer through the PTY, and a
 * composer. The terminal stays the truth; this is a reader of the transcript
 * and a writer of keystrokes.
 *
 * Mounted once per transcript: `LeafPane` keys it by the agent's
 * `transcriptPath`, so `/clear` or a resume starts a fresh list rather than
 * merging two sessions.
 *
 * A remote agent's transcript can't be read while its host is away
 * (`host-offline`, ADR-216 D4). The note shows until history can be fetched
 * again: on any host status change, on the next live entry, or on a slow
 * retry, whichever comes first.
 *
 * Stays subscribed while the terminal shows a TUI menu the chat sent: the
 * menu's command landing in the transcript means it closed, and the pane
 * comes back to the chat (ADR-218 D3).
 */
export function ChatPane(props: ChatPaneProps) {
  const { paneId, transcript, hidden, onShowTerminal } = props;

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  /** Ids the first history load drew: only entries after it animate in. */
  const [settledIds, setSettledIds] = useState<Set<string> | null>(null);
  const status = useAppStore((s) => s.paneAgentStatus[paneId]?.status ?? null);

  useMountEffect(() => {
    const chat = window.electronAPI.chat;
    let alive = true;
    /** The last fetch answered `host-offline`: fetch again on a sign of life. */
    let offline = false;
    let fetching = false;
    let retry: ReturnType<typeof setInterval> | null = null;

    // Read from the store, not a hook: these callbacks live as long as the mount.
    const checkHandoff = (landed: readonly ChatEntry[]) => {
      const handoff = usePaneChatViewStore.getState().handoffs[paneId];
      if (handoff && landed.some((e) => endsMenuHandoff(handoff, e))) {
        endMenuHandoff(paneId, { returnToChat: true });
      }
    };

    const setOffline = (next: boolean) => {
      offline = next;
      if (next && retry === null) retry = setInterval(fetchHistory, OFFLINE_RETRY_MS);
      if (!next && retry !== null) {
        clearInterval(retry);
        retry = null;
      }
    };

    function fetchHistory(): void {
      if (fetching) return;
      fetching = true;
      chat.getHistory(paneId).then(
        (history) => {
          fetching = false;
          if (!alive) return;
          if (history.ok) {
            checkHandoff(history.entries);
            setEntries((prev) => mergeHistory(history.entries, prev));
            setSettledIds((prev) => prev ?? new Set(history.entries.map((e) => e.id)));
            setUnavailable(null);
          } else {
            setUnavailable(history.reason);
          }
          setOffline(!history.ok && history.reason === "host-offline");
          setLoaded(true);
        },
        () => {
          fetching = false;
          if (!alive) return;
          setUnavailable("error");
          setOffline(false);
          setLoaded(true);
        },
      );
    }

    // Subscribe first: the mirror only watches the transcript while someone
    // is subscribed, and nothing published during the fetch is lost.
    const unsubscribe = chat.onEntry(paneId, (_paneId, entry) => {
      setEntries((prev) => upsertEntry(prev, entry));
      checkHandoff([entry]);
      // The transcript is readable again: catch up on what was missed.
      if (offline) fetchHistory();
    });
    const unsubscribeHosts = useHostStore.subscribe((state, prev) => {
      if (offline && state.hosts !== prev.hosts) fetchHistory();
    });
    fetchHistory();
    return () => {
      alive = false;
      setOffline(false);
      unsubscribe();
      unsubscribeHosts();
    };
  });

  // A new entry always brings the chat to the bottom. An entry growing in
  // place is followed only while the user hasn't scrolled up to read.
  const stuck = useRef(true);
  const newestId = useRef<string | undefined>(undefined);
  const followedId = useRef<string | undefined>(undefined);
  const followBottom = useCallback((content: HTMLDivElement | null) => {
    const scroller = content?.parentElement;
    if (!content || !scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // The history the chat opens on lands at the bottom at once.
      const opening = followedId.current === undefined;
      if (newestId.current !== followedId.current) {
        followedId.current = newestId.current;
        stuck.current = true;
      }
      if (!stuck.current) return;
      const smooth = !opening && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // A smooth scroll down passes through spots far from the bottom, so only
  // moving up counts as the user leaving it.
  const lastScrollTop = useRef(0);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLOP_PX) stuck.current = true;
    else if (el.scrollTop < lastScrollTop.current) stuck.current = false;
    lastScrollTop.current = el.scrollTop;
  };

  const answerableId = answerablePickerId(entries);
  const busy = status === "thinking" || status === "working";
  const items = groupEntries(entries);
  const newest = items[items.length - 1];
  newestId.current = newest?.id;
  // A running tool call already has its own live line.
  const toolRunning =
    newest?.kind === "tool-group" && newest.tools.some((t) => t.status === "pending");
  const thinking = busy && answerableId === null && !toolRunning;
  const needsYou = status === "requires_input" && answerableId === null;

  return (
    <div
      className={`${styles.chatPane} ${hidden ? styles.hidden : ""}`}
      data-chat-pane
      data-testid="chat-pane"
      aria-hidden={hidden || undefined}
    >
      {unavailable ? (
        <div className={styles.unavailable} data-testid="chat-unavailable">
          <p>{UNAVAILABLE_NOTE[unavailable]}</p>
          <Button onClick={onShowTerminal}>Show terminal</Button>
        </div>
      ) : (
        <>
          <div className={styles.scroller} onScroll={onScroll}>
            <div ref={followBottom} className={styles.entries}>
              {loaded && entries.length === 0 && (
                <p className={styles.empty}>Nothing in this conversation yet.</p>
              )}
              {items.map((entry) => {
                const live = settledIds !== null && !settledIds.has(entry.id);
                return (
                  <div key={entry.id} className={styles.entry} data-enter={live || undefined}>
                    <ChatEntryView
                      paneId={paneId}
                      entry={entry}
                      answerableId={answerableId}
                      live={live}
                      onShowTerminal={onShowTerminal}
                    />
                  </div>
                );
              })}
              {thinking && <ChatThinking key={entries[entries.length - 1]?.id ?? ""} />}
            </div>
          </div>
          {needsYou && (
            <div className={styles.needsYou} data-testid="chat-needs-you">
              <span>Claude needs you</span>
              <Button size="sm" variant="primary" onClick={onShowTerminal}>
                Open terminal
              </Button>
            </div>
          )}
          <ChatComposer paneId={paneId} busy={busy} transcript={transcript} />
        </>
      )}
    </div>
  );
}

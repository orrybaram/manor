import { useCallback, useRef, useState } from "react";
import type { ChatEntry, ChatHistory } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useAppStore } from "../../../store/app-store";
import { useHostStore } from "../../../store/host-store";
import { Button } from "../../ui/Button/Button";
import { answerablePickerId, mergeHistory, upsertEntry } from "./chat-entries";
import { ChatComposer } from "./ChatComposer";
import { ChatEntryView } from "./ChatEntryView";
import styles from "./ChatPane.module.css";

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
 */
export function ChatPane(props: ChatPaneProps) {
  const { paneId, hidden, onShowTerminal } = props;

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  const status = useAppStore((s) => s.paneAgentStatus[paneId]?.status ?? null);

  useMountEffect(() => {
    const chat = window.electronAPI.chat;
    let alive = true;
    /** The last fetch answered `host-offline`: fetch again on a sign of life. */
    let offline = false;
    let fetching = false;
    let retry: ReturnType<typeof setInterval> | null = null;

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
            setEntries((prev) => mergeHistory(history.entries, prev));
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

  // Follow the bottom as entries arrive or grow, unless the user has
  // scrolled up to read.
  const stuck = useRef(true);
  const followBottom = useCallback((content: HTMLDivElement | null) => {
    const scroller = content?.parentElement;
    if (!content || !scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLOP_PX;
  };

  const answerableId = answerablePickerId(entries);
  const busy = status === "thinking" || status === "working";
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
              {entries.map((entry) => (
                <ChatEntryView
                  key={entry.id}
                  paneId={paneId}
                  entry={entry}
                  answerableId={answerableId}
                  onShowTerminal={onShowTerminal}
                />
              ))}
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
          <ChatComposer paneId={paneId} busy={busy} />
        </>
      )}
    </div>
  );
}

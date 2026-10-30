import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { onBridgeResync, refreshState } from "../../../bridge/resync";
import type { ChatEntry, ChatHistory } from "../../../electron.d";
import type { LayoutMode } from "../../../hooks/useLayoutMode";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useAppStore } from "../../../store/app-store";
import { useHostStore } from "../../../store/host-store";
import { agentChat } from "../../../lib/agent-chat";
import { Button } from "../../ui/Button/Button";
import { PullToRefresh } from "../PullToRefresh";
import {
  answerablePickerId,
  groupEntries,
  mergeHistory,
  runningTaskCount,
  upsertEntry,
} from "./chat-entries";
import { ChatComposer } from "./ChatComposer";
import { ChatEntryView } from "./ChatEntryView";
import { ChatThinking } from "./ChatThinking";
import { earlierAnchor, windowStart } from "./chat-window";
import styles from "./ChatPane.module.css";
import { isBusyStatus, TurnSettle } from "./turn-settle";
import { noteChatEntries } from "./usePaneChatView";

type Unavailable = Extract<ChatHistory, { ok: false }>["reason"] | "error";

/** Why there is no chat, in words naming the agent (`AgentChat.name`). */
function unavailableNote(reason: Unavailable, agent: string): string {
  switch (reason) {
    case "no-agent":
      return `This pane has no ${agent} session to show as a chat.`;
    case "unsupported-agent":
      return "Chat isn't available for this agent yet.";
    case "no-transcript":
      return `${agent} hasn't written a transcript for this session yet.`;
    case "remote":
      return "Chat isn't available for agents on a remote host yet.";
    case "host-offline":
      return "This host is offline. The chat will catch up when it reconnects.";
    case "error":
      return "Couldn't load this chat.";
  }
}

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
  /** The **Agent kind** of the agent whose transcript this is. */
  agentKind: string;
  /** The transcript this chat reads (it is keyed by it). */
  transcript: string;
  /** The terminal is showing instead. The chat stays mounted and subscribed. */
  hidden: boolean;
  onShowTerminal: () => void;
  /** Which layout the pane is in: the desk keeps the chat to a column. */
  layout?: LayoutMode;
};

/**
 * The chat view of an agent pane, on a phone or a desk: the pane's transcript as
 * a conversation, its pickers as cards that answer through the PTY, and a
 * composer. The terminal stays the truth; this is a reader of the transcript
 * and a writer of keystrokes.
 *
 * Mounted once per transcript: `LeafPane` keys it by the agent's
 * `transcriptPath`, so `/clear` or a resume starts a fresh list rather than
 * merging two sessions.
 *
 * A remote agent's transcript can't be read while its host is away
 * (`host-offline`). The note shows until history can be fetched
 * again: on any host status change, on the next live entry, or on a slow
 * retry, whichever comes first.
 *
 * Stays subscribed while the terminal shows a TUI menu the chat sent: the
 * menu's command landing in the transcript means it closed, and the pane
 * comes back to the chat.
 *
 * Busy is the hook status, unless the transcript has said the turn ended
 * for a few seconds (`TurnSettle`): then a missing Stop hook can't leave
 * the chat on "Thinking" with its composer held.
 *
 * Only the newest items are mounted (`chat-window.ts`). Scrolling near the
 * top mounts earlier ones; back at the bottom, the window drops back to the
 * newest. Either way the items that stay mounted must not move on screen, so
 * every commit moves the scroll offset by however far the first of them
 * moved (iOS Safari has no scroll anchoring, so the browser's is turned off
 * everywhere and this does it).
 */
export function ChatPane(props: ChatPaneProps) {
  const { paneId, agentKind, transcript, hidden, onShowTerminal, layout = "phone" } = props;
  const agentName = agentChat(agentKind).name;

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  /** Ids the first history load drew: only entries after it animate in. */
  const [settledIds, setSettledIds] = useState<Set<string> | null>(null);
  /** The session's context size; a fresh transcript remounts this. */
  const [contextTokens, setContextTokens] = useState<number | null>(null);
  const status = useAppStore((s) => s.paneAgentStatus[paneId]?.status ?? null);
  /** The transcript's ended turn outranks a busy hook status, for display. */
  const [turnSettled, setTurnSettled] = useState(false);

  useMountEffect(() => {
    const chat = window.electronAPI.chat;
    let alive = true;
    /** The last fetch answered `host-offline`: fetch again on a sign of life. */
    let offline = false;
    let fetching = false;
    /**
     * The history changed in place (`ChatReset`): the next history that
     * answers replaces the entries shown rather than merging under them.
     */
    let replace = false;
    /** A reset arrived during a fetch, which may predate it: fetch again after. */
    let again = false;
    /** The chat is showing a history: the last fetch that answered had one. */
    let shown = false;
    let retry: ReturnType<typeof setInterval> | null = null;
    const turnSettle = new TurnSettle(setTurnSettled);
    const statusOf = (s: ReturnType<typeof useAppStore.getState>) =>
      s.paneAgentStatus[paneId]?.status ?? null;
    turnSettle.setStatus(statusOf(useAppStore.getState()));

    const setOffline = (next: boolean) => {
      offline = next;
      if (next && retry === null) retry = setInterval(fetchHistory, OFFLINE_RETRY_MS);
      if (!next && retry !== null) {
        clearInterval(retry);
        retry = null;
      }
    };

    function fetchHistory(): Promise<void> {
      if (fetching) return Promise.resolve();
      fetching = true;
      const replacing = replace;
      return chat.getHistory(paneId).then(
        (history) => {
          fetching = false;
          if (!alive) return;
          if (again) {
            again = false;
            void fetchHistory();
            return;
          }
          if (history.ok) {
            shown = true;
            if (replacing) replace = false;
            noteChatEntries(paneId, transcript, history.entries);
            setEntries((prev) => (replacing ? history.entries : mergeHistory(history.entries, prev)));
            setSettledIds((prev) => prev ?? new Set(history.entries.map((e) => e.id)));
            // An older host's history has no size: keep what a push said.
            if (history.contextTokens != null) setContextTokens(history.contextTokens);
            if (history.turnState != null) turnSettle.setTurn(history.turnState);
            setUnavailable(null);
          } else {
            shown = false;
            setUnavailable(history.reason);
          }
          setOffline(!history.ok && history.reason === "host-offline");
          setLoaded(true);
        },
        () => {
          fetching = false;
          // A refetch that failed (a resync on a line that dropped again)
          // keeps the chat it already has rather than blanking it.
          if (!alive || shown) return;
          setUnavailable("error");
          setOffline(false);
          setLoaded(true);
        },
      );
    }

    // Subscribe first: the mirror only watches the transcript while someone
    // is subscribed, and nothing published during the fetch is lost.
    const unsubscribe = chat.onEntry(paneId, (_paneId, entry) => {
      // The context size and turn state ride the entry channel but are no entries.
      if (entry.kind === "usage") {
        setContextTokens(entry.contextTokens);
      } else if (entry.kind === "turn") {
        turnSettle.setTurn(entry.state);
      } else if (entry.kind === "reset") {
        replace = true;
        if (fetching) again = true;
        else void fetchHistory();
        return;
      } else {
        setEntries((prev) => upsertEntry(prev, entry));
        noteChatEntries(paneId, transcript, [entry]);
      }
      // The transcript is readable again: catch up on what was missed.
      if (offline) void fetchHistory();
    });
    const unsubscribeStatus = useAppStore.subscribe((state) => {
      turnSettle.setStatus(statusOf(state));
    });
    const unsubscribeHosts = useHostStore.subscribe((state, prev) => {
      if (offline && state.hosts !== prev.hosts) void fetchHistory();
    });
    // The bridge came back from a drop, or the user asked for a refresh:
    // catch up on entries pushed while the socket was down.
    // Entries upsert by id, so this merges, and an unchanged newest entry
    // leaves scroll-follow where the user put it.
    const unsubscribeResync = onBridgeResync(fetchHistory);
    void fetchHistory();
    return () => {
      alive = false;
      setOffline(false);
      unsubscribe();
      unsubscribeStatus();
      turnSettle.dispose();
      unsubscribeHosts();
      unsubscribeResync();
    };
  });

  // New and growing entries are followed only while the user is at the
  // bottom; scrolling up to read leaves the chat where they put it.
  const stuck = useRef(true);
  const newestId = useRef<string | undefined>(undefined);
  const opened = useRef(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const followBottom = useCallback((content: HTMLDivElement | null) => {
    contentRef.current = content;
    const scroller = content?.parentElement;
    if (!content || !scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // The history the chat opens on lands at the bottom at once.
      const opening = !opened.current;
      if (newestId.current !== undefined) opened.current = true;
      if (!stuck.current) return;
      const smooth = !opening && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const answerableId = answerablePickerId(entries);
  const busy = isBusyStatus(status) && !turnSettled;
  const items = groupEntries(entries, status);

  /** The window's first item; null while at the bottom (the newest items). */
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const start = windowStart(items, anchorId);
  /** Earlier items were asked for and haven't committed yet. */
  const loadingEarlier = useRef(false);
  /** Each mounted item's offset as of the last commit, by id. */
  const placed = useRef(new Map<string, number>());
  /** Live entries that left the window: back in it, they don't animate again. */
  const retired = useRef(new Set<string>());

  // A smooth scroll down passes through spots far from the bottom, so only
  // moving up counts as the user leaving it.
  const lastScrollTop = useRef(0);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLOP_PX) stuck.current = true;
    else if (el.scrollTop < lastScrollTop.current) stuck.current = false;
    lastScrollTop.current = el.scrollTop;

    if (stuck.current) {
      if (anchorId !== null) setAnchorId(null);
    } else if (start > 0 && el.scrollTop < el.clientHeight) {
      // Within a screen of the top: one load at a time.
      if (!loadingEarlier.current) {
        loadingEarlier.current = true;
        setAnchorId(earlierAnchor(items, start));
      }
    } else if (anchorId === null) {
      // Left the bottom: pin the top, so entries landing below can't trim it.
      setAnchorId(items[start]?.id ?? null);
    }
  };

  // Before paint: items mounted or unmounted above moved the ones that
  // stayed, so move the scroll offset with them. From the offset before the
  // commit (the last scroll event's): a shorter list may have clamped it.
  useLayoutEffect(() => {
    loadingEarlier.current = false;
    const content = contentRef.current;
    const scroller = content?.parentElement;
    if (!content || !scroller) return;
    const rows = [...content.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.itemId !== undefined,
    );
    const kept = rows.find((el) => placed.current.has(el.dataset.itemId!));
    const moved = kept ? kept.offsetTop - placed.current.get(kept.dataset.itemId!)! : 0;
    if (moved !== 0) {
      scroller.scrollTop = lastScrollTop.current + moved;
      // Ours, not the user's: moving up here must not unstick the chat.
      lastScrollTop.current = scroller.scrollTop;
    }
    placed.current = new Map(rows.map((el) => [el.dataset.itemId!, el.offsetTop]));
  });
  // Live entries above the window have left it (it only ever trims the top).
  useLayoutEffect(() => {
    if (settledIds === null) return;
    for (let i = 0; i < start; i++) {
      if (!settledIds.has(items[i].id)) retired.current.add(items[i].id);
    }
  });
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
      data-layout={layout}
      data-testid="chat-pane"
      aria-hidden={hidden || undefined}
    >
      {unavailable ? (
        <div className={styles.unavailable} data-testid="chat-unavailable">
          <p>{unavailableNote(unavailable, agentName)}</p>
          <Button onClick={onShowTerminal}>Show terminal</Button>
        </div>
      ) : (
        <>
          {/* Pulling down at the top refreshes the bridge. It moves an
              overlay and never scrolls, so it can't change what
              bottom-follow sees. */}
          <PullToRefresh
            onRefresh={refreshState}
            className={styles.scroller}
            onScroll={onScroll}
          >
            <div ref={followBottom} className={styles.entries}>
              {loaded && entries.length === 0 && (
                <p className={styles.empty}>Nothing in this conversation yet.</p>
              )}
              {items.slice(start).map((entry) => {
                const live =
                  settledIds !== null &&
                  !settledIds.has(entry.id) &&
                  !retired.current.has(entry.id);
                return (
                  <div
                    key={entry.id}
                    className={styles.entry}
                    data-item-id={entry.id}
                    data-enter={live || undefined}
                  >
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
          </PullToRefresh>
          {needsYou && (
            <div className={styles.needsYou} data-testid="chat-needs-you">
              <span>{agentName} needs you</span>
              <Button size="sm" variant="primary" onClick={onShowTerminal}>
                Open terminal
              </Button>
            </div>
          )}
          <ChatComposer
            paneId={paneId}
            agentKind={agentKind}
            busy={busy}
            transcript={transcript}
            contextTokens={contextTokens}
            runningTasks={runningTaskCount(items)}
          />
        </>
      )}
    </div>
  );
}

import { useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import type { AgentKind } from "../../../electron.d";
import { useAppStore } from "../../../store/app-store";
import { cleanLiveTitle } from "../../../hooks/useAgentDisplay";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { relativeShortThenDate } from "../../../utils/relative-time";
import { getPlatform } from "../../../lib/keybindings";
import { ChatMarkdown } from "../../phone/ChatPane/ChatMarkdown";
import { summarizeTools } from "../../phone/ChatPane/chat-entries";
import { modalRowTitle, type ModalRow } from "./agents-modal-list";
import { groupPreviewTurns, type PreviewItem, type PreviewState, type PreviewToolGroup } from "./session-preview";
import styles from "./SessionPreview.module.css";

/** How each Agent kind is named. */
const KIND_LABELS: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "opencode",
  pi: "pi",
};

/** ⌘↵ on a Mac, Ctrl+↵ elsewhere. */
export const FORK_KEYS = getPlatform() === "mac" ? "⌘↵" : "Ctrl+↵";

type SessionPreviewProps = {
  row: ModalRow;
  state: PreviewState;
  /** The row's Agent has a pane in a workspace now. */
  live: boolean;
  /**
   * Show Resume, Fork and Rename buttons. Only a phone needs them; a desk
   * has ↵, ⌘↵ and F2, which the footer lists.
   */
  actions: boolean;
  onPrimary: () => void;
  onFork: () => void;
  /** Absent for a Session with no Agent: there is nothing to rename. */
  onRename?: () => void;
};

// Buttons here keep focus in the search box, so the keys keep working.
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

/**
 * The highlighted row: its title, facts and, on a phone, actions; then its
 * conversation (the opening prompt and the last turns).
 */
export function SessionPreview(props: SessionPreviewProps) {
  const { row, state, live, actions, onPrimary, onFork, onRename } = props;
  const { agent, session, project } = row;
  const liveTitle = useAppStore((s) =>
    agent?.paneId ? cleanLiveTitle(s.paneTitle[agent.paneId] ?? null) : null,
  );
  const title = modalRowTitle(row, liveTitle);
  const kind = session?.kind ?? agent?.agentKind;
  const messages = session?.messageCount;

  return (
    <div
      className={styles.preview}
      data-testid="agents-modal-preview"
      aria-busy={state.status === "loading" || undefined}
    >
      <h3 className={styles.title}>{title}</h3>
      <div className={styles.meta}>
        <span className={styles.project} style={projectColorStyle(project.color)} title={project.path}>
          <span className={styles.projectDot} data-uncolored={project.color ? undefined : ""} />
          {project.name}
        </span>
        {session?.gitBranch && <span>{session.gitBranch}</span>}
        {kind && <span className={styles.kind}>{KIND_LABELS[kind] ?? kind}</span>}
        {messages != null && <span>{messages === 1 ? "1 message" : `${messages} messages`}</span>}
        <span>{relativeShortThenDate(new Date(row.activityAt).getTime())}</span>
        {live && <span className={styles.live}>● in a pane</span>}
        {!agent && (
          <span className={styles.outside} title="Found on disk; not started in Manor">
            outside Manor
          </span>
        )}
      </div>
      {actions && (
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            data-testid="agents-modal-primary"
            onMouseDown={keepFocus}
            onClick={onPrimary}
          >
            {live ? "Go to pane" : "Resume"} <kbd aria-hidden>↵</kbd>
          </button>
          <button
            type="button"
            className={styles.button}
            data-testid="agents-modal-fork"
            onMouseDown={keepFocus}
            onClick={onFork}
          >
            Fork <kbd aria-hidden>{FORK_KEYS}</kbd>
          </button>
          {onRename && (
            <button type="button" className={styles.button} onMouseDown={keepFocus} onClick={onRename}>
              Rename <kbd aria-hidden>F2</kbd>
            </button>
          )}
        </div>
      )}
      {/* Keyed so an opened tool group closes when the highlight moves on. */}
      <Conversation key={row.id} state={state} />
    </div>
  );
}

function Conversation({ state }: { state: PreviewState }) {
  if (state.status === "loading") {
    return (
      <div
        className={styles.skeleton}
        role="status"
        aria-label="Loading conversation"
        data-testid="agents-modal-preview-loading"
      >
        <span className={`${styles.bar} ${styles.barUser}`} />
        <span className={styles.bar} />
        <span className={`${styles.bar} ${styles.barShort}`} />
      </div>
    );
  }
  if (state.status === "error") {
    return <div className={styles.note}>Couldn’t read this conversation.</div>;
  }
  if (state.status === "none") return <div className={styles.note}>No transcript yet.</div>;

  const { turns, truncated, partial } = state.preview;
  const partialNote = partial && (
    <div className={styles.gap} data-testid="agents-modal-preview-partial">
      Showing turns from before the end — this transcript is too large to read fully
    </div>
  );
  if (turns.length === 0) return partialNote || <div className={styles.note}>No messages yet.</div>;
  const items = groupPreviewTurns(turns);
  // The opening prompt comes from before the window the rest came from, so
  // the gap sits after it.
  const gapAfter = items[0].role === "user" && items[0].first ? 1 : 0;
  return (
    <div className={styles.turns} data-testid="agents-modal-turns">
      {partialNote}
      {items.map((item, i) => (
        <PreviewItemView key={i} item={item} gapBefore={truncated && i === gapAfter} />
      ))}
      {truncated && gapAfter === items.length && <EarlierHint />}
    </div>
  );
}

function EarlierHint() {
  return <div className={styles.gap}>Earlier messages not shown</div>;
}

function PreviewItemView({ item, gapBefore }: { item: PreviewItem; gapBefore: boolean }) {
  const body =
    item.role === "user" ? (
      <div className={styles.userTurn}>
        {item.first && <div className={styles.label}>First prompt</div>}
        <div className={styles.bubble}>{item.text}</div>
      </div>
    ) : item.role === "assistant" ? (
      <div className={styles.assistantTurn}>
        <ChatMarkdown source={item.text} imagesAsText />
      </div>
    ) : (
      <ToolGroupView group={item} />
    );
  return (
    <>
      {gapBefore && <EarlierHint />}
      {body}
    </>
  );
}

/**
 * A run of tool calls as one line summing them up ("Ran 5 commands, used 6
 * tools"); clicking it lists each call.
 */
function ToolGroupView({ group }: { group: PreviewToolGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.toolGroup} data-testid="agents-modal-tool-group">
      <button
        type="button"
        className={styles.toolGroupLine}
        aria-expanded={open}
        onMouseDown={keepFocus}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.toolGroupSummary}>
          {summarizeTools(group.tools)
            .map((part) => part.text)
            .join(", ")}
        </span>
        <ChevronRight className={styles.toolGroupChevron} size={12} aria-hidden />
      </button>
      {open &&
        group.tools.map((tool, i) => {
          // A call with nothing to say about itself has its name as its summary.
          const line = tool.summary === tool.name ? tool.name : `${tool.name} ${tool.summary}`;
          return (
            <div key={i} className={styles.toolTurn} title={line}>
              {line}
            </div>
          );
        })}
    </div>
  );
}

import { useCallback, useRef, useState, type ReactNode } from "react";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import X from "lucide-react/dist/esm/icons/x";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { Button } from "../../ui/Button/Button";
import { PhoneSheet, PhoneSheetClose } from "../PhoneSheet";
import { groupEntries, type TaskItem } from "./chat-entries";
import { ChatEntryView } from "./ChatEntryView";
import { agentsListTitle, agentStatusText } from "./chat-status-line";
import { TaskViewContext } from "./task-view-context";
import { TaskStatusDot } from "./TaskStatusDot";
import { useTaskChatView } from "./useTaskChatView";
import styles from "./ChatPane.module.css";

/** What the task view shows: one task, or (on a phone) the list of agents. */
export type TaskViewState = { kind: "task"; id: string } | { kind: "list" };

const NOOP = () => {};

/** Within this many px of the bottom counts as "at the bottom". */
const STICK_SLOP_PX = 48;

/** The clock, ticking each second while mounted. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useMountEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  });
  return now;
}

/** A task's status dot, title and line of type and time. */
function TaskHeading(props: { task: TaskItem }) {
  const { task } = props;
  const now = useNow();
  return (
    <>
      <TaskStatusDot status={task.display} />
      <span className={styles.agentRowText}>
        <span className={styles.agentRowTitle}>{task.title}</span>
        <span className={styles.agentRowStatus}>{agentStatusText(task, now)}</span>
      </span>
    </>
  );
}

/**
 * A task's own transcript: the entries the chat draws, read-only. Keyed by
 * task and mounted only while shown, so it watches one child stream at most.
 * A running task's opens at its newest output and follows it until you scroll
 * up; a finished one's opens at the top.
 */
function TaskTranscript(props: { paneId: string; task: TaskItem }) {
  const { paneId, task } = props;
  const { entries, loaded, unavailable } = useTaskChatView(paneId, task.id);
  const items = groupEntries(entries);

  const stuck = useRef(task.display === "running");
  const lastScrollTop = useRef(0);
  const follow = useCallback((content: HTMLDivElement | null) => {
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
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLOP_PX) stuck.current = true;
    else if (el.scrollTop < lastScrollTop.current) stuck.current = false;
    lastScrollTop.current = el.scrollTop;
  };

  return (
    <TaskViewContext.Provider value={null}>
      <div className={styles.taskTranscript} onScroll={onScroll} data-testid="chat-task-transcript">
        <div ref={follow} className={styles.entries}>
          {items.length === 0 ? (
            task.result ? (
              <pre className={styles.toolDetail}>{task.result}</pre>
            ) : (
              <p className={styles.empty}>{loaded || unavailable ? "No transcript yet" : ""}</p>
            )
          ) : (
            items.map((item) => (
              <div key={item.id} className={styles.entry}>
                <ChatEntryView
                  paneId={paneId}
                  entry={item}
                  answerableId={null}
                  live={false}
                  onShowTerminal={NOOP}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </TaskViewContext.Provider>
  );
}

function IconButton(props: {
  label: string;
  onClick: () => void;
  className?: string;
  "data-testid"?: string;
  children: ReactNode;
}) {
  const { label, onClick, className, children } = props;
  return (
    <Button
      variant="ghost"
      className={`${styles.taskPanelIcon} ${className ?? ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={props["data-testid"]}
    >
      {children}
    </Button>
  );
}

type TaskPanelProps = {
  paneId: string;
  task: TaskItem;
  /** The chat's background agents, in chat order: what the arrows step through. */
  agents: readonly TaskItem[];
  /** The pane is showing its terminal: the panel keeps its place but watches nothing. */
  hidden: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
};

/**
 * The desk's task view: the task's transcript beside the chat, which stays
 * usable. A pane too narrow for both gets the panel alone, and its close
 * button becomes a back arrow (`ChatPane.module.css`). A task that isn't a
 * background agent has no arrows, since the list it would step through
 * doesn't hold it.
 */
export function TaskPanel(props: TaskPanelProps) {
  const { paneId, task, agents, hidden, onPick, onClose } = props;
  const panelRef = useRef<HTMLElement>(null);
  const index = agents.findIndex((a) => a.id === task.id);
  const step = (by: number) => {
    onPick(agents[(index + by + agents.length) % agents.length].id);
  };

  // Takes the keyboard so Escape closes it, unless you're typing in another
  // pane (it also mounts when a remote host comes back). On the way out, focus
  // that went with it lands in the composer, ready to reply.
  useMountEffect(() => {
    const panel = panelRef.current;
    const pane = panel?.closest("[data-chat-pane]");
    const idle = () => !document.activeElement || document.activeElement === document.body;
    if (idle() || pane?.contains(document.activeElement)) panel?.focus({ preventScroll: true });
    return () => {
      if (idle()) pane?.querySelector("textarea")?.focus({ preventScroll: true });
    };
  });

  return (
    <aside
      ref={panelRef}
      className={styles.taskPanel}
      tabIndex={-1}
      aria-label={task.title}
      data-testid="chat-task-panel"
    >
      <div className={styles.taskViewHeader}>
        <IconButton
          label="Back to chat"
          onClick={onClose}
          className={styles.taskPanelBack}
          data-testid="chat-task-panel-back"
        >
          <ChevronLeft size={16} />
        </IconButton>
        <TaskHeading task={task} />
        {index !== -1 && agents.length > 1 && (
          <>
            <span className={styles.taskPanelCount} data-testid="chat-task-panel-count">
              {index + 1} of {agents.length}
            </span>
            <IconButton
              label="Previous agent"
              onClick={() => step(-1)}
              data-testid="chat-task-panel-previous"
            >
              <ChevronLeft size={16} />
            </IconButton>
            <IconButton
              label="Next agent"
              onClick={() => step(1)}
              data-testid="chat-task-panel-next"
            >
              <ChevronRight size={16} />
            </IconButton>
          </>
        )}
        <IconButton
          label="Close"
          onClick={onClose}
          className={styles.taskPanelClose}
          data-testid="chat-task-panel-close"
        >
          <X size={16} />
        </IconButton>
      </div>
      {!hidden && <TaskTranscript key={task.id} paneId={paneId} task={task} />}
    </aside>
  );
}

type AgentsSheetProps = {
  paneId: string;
  view: TaskViewState | null;
  /** The view's task, when it shows one. */
  task: TaskItem | undefined;
  /** The chat's background agents, running first. */
  agents: readonly TaskItem[];
  running: number;
  onViewChange: (view: TaskViewState | null) => void;
};

/**
 * The phone's task view: one bottom sheet holding the list of agents and a
 * task's transcript, with a back arrow between them. With a single agent
 * there's no list to go back to.
 */
export function AgentsSheet(props: AgentsSheetProps) {
  const { paneId, view, task, agents, running, onViewChange } = props;
  // What it showed last, for the sheet to slide away with.
  const [shownTask, setShownTask] = useState(task);
  if (view !== null && task !== shownTask) setShownTask(task);
  const heading = view === null ? shownTask : task;
  const title = heading ? heading.title : agentsListTitle(running);

  return (
    <PhoneSheet
      open={view !== null}
      onOpenChange={(open) => {
        if (!open) onViewChange(null);
      }}
      variant="bottom"
      hiddenTitle={title}
      data-testid="chat-agents-sheet"
    >
      <div className={styles.taskViewHeader}>
        {heading ? (
          <>
            {agents.length > 1 && (
              <IconButton
                label="All agents"
                onClick={() => onViewChange({ kind: "list" })}
                data-testid="chat-agents-back"
              >
                <ChevronLeft size={18} />
              </IconButton>
            )}
            <TaskHeading task={heading} />
          </>
        ) : (
          <span className={styles.agentsTitle}>{title}</span>
        )}
        <PhoneSheetClose label="Close" />
      </div>
      {task && <TaskTranscript key={task.id} paneId={paneId} task={task} />}
      {view?.kind === "list" && (
        <div className={styles.agentsSheetBody}>
          <AgentsList agents={agents} onPick={(id) => onViewChange({ kind: "task", id })} />
        </div>
      )}
    </PhoneSheet>
  );
}

/**
 * The agents, one row each: status dot, title, type and time. Mounted only
 * while the list is open, so only an open list ticks the running times.
 */
function AgentsList(props: { agents: readonly TaskItem[]; onPick: (id: string) => void }) {
  const { agents, onPick } = props;
  return (
    <div className={styles.agentsList} data-testid="chat-agents-list">
      {agents.map((agent) => (
        <Button
          key={agent.id}
          variant="ghost"
          className={styles.agentRow}
          data-testid="chat-agent-row"
          data-agent-id={agent.id}
          onClick={() => onPick(agent.id)}
        >
          <TaskHeading task={agent} />
          <ChevronRight size={14} className={styles.agentRowChevron} aria-hidden />
        </Button>
      ))}
    </div>
  );
}
